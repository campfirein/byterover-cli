import type {ProviderDTO} from '../../../../shared/transport/types/dto.js'
import type {IProviderConfigStore} from '../../../core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../../core/interfaces/i-provider-keychain-store.js'
import type {IProviderOAuthTokenStore} from '../../../core/interfaces/i-provider-oauth-token-store.js'
import type {IBrowserLauncher} from '../../../core/interfaces/services/i-browser-launcher.js'
import type {IAuthStateStore} from '../../../core/interfaces/state/i-auth-state-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'
import type {
  PkceParameters,
  ProviderTokenResponse,
  TokenExchangeParams,
  TokenRequestContentType,
} from '../../provider-oauth/index.js'

import {
  type ProviderAwaitOAuthCallbackRequest,
  type ProviderAwaitOAuthCallbackResponse,
  type ProviderCancelOAuthRequest,
  type ProviderCancelOAuthResponse,
  type ProviderConnectRequest,
  type ProviderConnectResponse,
  type ProviderDisconnectRequest,
  type ProviderDisconnectResponse,
  ProviderEvents,
  type ProviderGetActiveResponse,
  type ProviderListResponse,
  type ProviderSetActiveRequest,
  type ProviderSetActiveResponse,
  type ProviderStartOAuthRequest,
  type ProviderStartOAuthResponse,
  type ProviderSubmitOAuthCodeRequest,
  type ProviderSubmitOAuthCodeResponse,
  type ProviderValidateApiKeyRequest,
  type ProviderValidateApiKeyResponse,
} from '../../../../shared/transport/events/provider-events.js'
import {
  getProviderById,
  getProvidersSortedByPriority,
  providerRequiresApiKey,
} from '../../../core/domain/entities/provider-registry.js'
import {TransportDaemonEventNames} from '../../../core/domain/transport/schemas.js'
import {getErrorMessage} from '../../../utils/error-helpers.js'
import {processLog} from '../../../utils/process-logger.js'
import {validateApiKey as validateApiKeyViaFetcher} from '../../http/provider-model-fetcher-registry.js'
import {OpenAICompatibleModelFetcher} from '../../http/provider-model-fetchers.js'
import {
  computeExpiresAt,
  exchangeCodeForTokens as defaultExchangeCodeForTokens,
  generatePkce as defaultGeneratePkce,
  parseAccountIdFromIdToken,
  ProviderCallbackServer,
  ProviderCallbackTimeoutError,
} from '../../provider-oauth/index.js'

const BYTEROVER_AUTH_REQUIRED_MESSAGE = [
  'ByteRover Provider requires a ByteRover account.',
  '',
  '  • Interactive shell: brv login',
  '  • Headless / SSH / CI: create an account at https://app.byterover.dev,',
  '    generate an API key at https://app.byterover.dev/settings/keys, then:',
  '      brv login --api-key <key>',
  '',
  'Once signed in, retry: brv providers connect byterover',
].join('\n')

async function defaultValidateOpenAICompatibleEndpoint(params: {
  apiKey: string
  baseUrl: string
}): Promise<{error?: string; isValid: boolean}> {
  const fetcher = new OpenAICompatibleModelFetcher(params.baseUrl, 'OpenAI Compatible')
  return fetcher.validateApiKey(params.apiKey)
}

type OAuthFlowState = {
  awaitInProgress?: boolean
  callbackServer?: ProviderCallbackServer
  clientId: string
  codeVerifier: string
  state: string
}

export interface ProviderHandlerDeps {
  authStateStore: IAuthStateStore
  browserLauncher: IBrowserLauncher
  /** Factory for creating callback servers (injectable for testing) */
  createCallbackServer?: (options: {callbackPath?: string; port: number}) => ProviderCallbackServer
  /** Token exchange function (injectable for testing) */
  exchangeCodeForTokens?: (params: TokenExchangeParams) => Promise<ProviderTokenResponse>
  /** PKCE generator function (injectable for testing) */
  generatePkce?: () => PkceParameters
  providerConfigStore: IProviderConfigStore
  providerKeychainStore: IProviderKeychainStore
  providerOAuthTokenStore: IProviderOAuthTokenStore
  transport: ITransportServer
  /** Validator for openai-compatible base URL (injectable for testing) */
  validateOpenAICompatibleEndpoint?: (params: {
    apiKey: string
    baseUrl: string
  }) => Promise<{error?: string; isValid: boolean}>
}

/**
 * Handles provider:* events.
 * Business logic for provider management — no terminal/UI calls.
 */
export class ProviderHandler {
  private readonly authStateStore: IAuthStateStore
  private readonly browserLauncher: IBrowserLauncher
  private readonly createCallbackServer: (options: {callbackPath?: string; port: number}) => ProviderCallbackServer
  private readonly exchangeCodeForTokens: (params: TokenExchangeParams) => Promise<ProviderTokenResponse>
  private readonly generatePkce: () => PkceParameters
  private readonly oauthFlows = new Map<string, OAuthFlowState>()
  private readonly providerConfigStore: IProviderConfigStore
  private readonly providerKeychainStore: IProviderKeychainStore
  private readonly providerOAuthTokenStore: IProviderOAuthTokenStore
  private readonly transport: ITransportServer
  private readonly validateOpenAICompatibleEndpoint: (params: {
    apiKey: string
    baseUrl: string
  }) => Promise<{error?: string; isValid: boolean}>

  constructor(deps: ProviderHandlerDeps) {
    this.authStateStore = deps.authStateStore
    this.browserLauncher = deps.browserLauncher
    this.createCallbackServer = deps.createCallbackServer ?? ((options) => new ProviderCallbackServer(options))
    this.exchangeCodeForTokens = deps.exchangeCodeForTokens ?? defaultExchangeCodeForTokens
    this.generatePkce = deps.generatePkce ?? defaultGeneratePkce
    this.providerConfigStore = deps.providerConfigStore
    this.providerKeychainStore = deps.providerKeychainStore
    this.providerOAuthTokenStore = deps.providerOAuthTokenStore
    this.transport = deps.transport
    this.validateOpenAICompatibleEndpoint =
      deps.validateOpenAICompatibleEndpoint ?? defaultValidateOpenAICompatibleEndpoint
  }

  setup(): void {
    this.setupConnect()
    this.setupDisconnect()
    this.setupGetActive()
    this.setupList()
    this.setupSetActive()
    this.setupValidateApiKey()
    this.setupStartOAuth()
    this.setupAwaitOAuthCallback()
    this.setupCancelOAuth()
    this.setupSubmitOAuthCode()

    // Clean up OAuth flows when a client disconnects (prevents callback server port leaks)
    this.transport.onDisconnection((clientId) => {
      this.cleanupFlowsForClient(clientId)
    })
  }

  private cleanupFlowsForClient(clientId: string): void {
    for (const [providerId, flow] of this.oauthFlows.entries()) {
      if (flow.clientId === clientId) {
        flow.callbackServer?.stop().catch(() => {})
        this.oauthFlows.delete(providerId)
      }
    }
  }

  private isByteRoverAuthSatisfied(): boolean {
    const token = this.authStateStore.getToken()
    return token !== undefined && token.isValid()
  }

  private setupAwaitOAuthCallback(): void {
    this.transport.onRequest<ProviderAwaitOAuthCallbackRequest, ProviderAwaitOAuthCallbackResponse>(
      ProviderEvents.AWAIT_OAUTH_CALLBACK,
      async (data) => {
        const flow = this.oauthFlows.get(data.providerId)
        if (!flow?.callbackServer) {
          return {error: 'No active OAuth flow for this provider', success: false}
        }

        if (flow.awaitInProgress) {
          return {error: 'OAuth callback is already being awaited for this provider', success: false}
        }

        flow.awaitInProgress = true

        try {
          // Block until callback or timeout (5 min default in ProviderCallbackServer)
          const callbackResult = await flow.callbackServer.waitForCallback(flow.state)

          // Exchange code for tokens
          const providerDef = getProviderById(data.providerId)
          if (!providerDef?.oauth) {
            return {error: 'Provider does not support OAuth', success: false}
          }

          const oauthConfig = providerDef.oauth
          const contentType: TokenRequestContentType =
            oauthConfig.tokenContentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'

          const tokens = await this.exchangeCodeForTokens({
            clientId: oauthConfig.clientId,
            code: callbackResult.code,
            codeVerifier: flow.codeVerifier,
            contentType,
            redirectUri: oauthConfig.redirectUri,
            tokenUrl: oauthConfig.tokenUrl,
          })

          // Parse JWT id_token for account ID
          const oauthAccountId = tokens.id_token ? parseAccountIdFromIdToken(tokens.id_token) : undefined

          // Store access token as the "API key" in keychain
          await this.providerKeychainStore.setApiKey(data.providerId, tokens.access_token)

          // Store refresh token + expiry in encrypted OAuth token store
          if (tokens.refresh_token) {
            const expiresAt = tokens.expires_in ? computeExpiresAt(tokens.expires_in) : computeExpiresAt(3600) // 1-hour default when provider omits expires_in
            await this.providerOAuthTokenStore.set(data.providerId, {
              expiresAt,
              refreshToken: tokens.refresh_token,
            })
          }

          // Connect provider — secrets stored in keychain + encrypted token store, not config
          // OAuth providers may define their own default model (e.g., Codex for OpenAI OAuth)
          const defaultModel = oauthConfig.defaultModel ?? providerDef.defaultModel
          await this.providerConfigStore.connectProvider(data.providerId, {
            activeModel: defaultModel,
            authMethod: 'oauth',
            oauthAccountId,
          })

          // Broadcast update
          this.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})

          return {success: true}
        } catch (error) {
          if (error instanceof ProviderCallbackTimeoutError) {
            return {error: 'Authentication timed out. Please try again.', success: false}
          }

          return {error: getErrorMessage(error), success: false}
        } finally {
          // Only clean up if this is still the same flow (guard against concurrent START_OAUTH)
          if (this.oauthFlows.get(data.providerId) === flow) {
            await flow.callbackServer?.stop().catch(() => {})
            this.oauthFlows.delete(data.providerId)
          }
        }
      },
    )
  }

  private setupCancelOAuth(): void {
    this.transport.onRequest<ProviderCancelOAuthRequest, ProviderCancelOAuthResponse>(
      ProviderEvents.CANCEL_OAUTH,
      async (data) => {
        const flow = this.oauthFlows.get(data.providerId)
        if (flow?.callbackServer) {
          await flow.callbackServer.stop().catch(() => {})
        }

        this.oauthFlows.delete(data.providerId)
        return {success: true}
      },
    )
  }

  private setupConnect(): void {
    this.transport.onRequest<ProviderConnectRequest, ProviderConnectResponse>(ProviderEvents.CONNECT, async (data) => {
      const {apiKey, baseUrl, providerId} = data

      if (providerId === 'byterover' && !this.isByteRoverAuthSatisfied()) {
        return {error: BYTEROVER_AUTH_REQUIRED_MESSAGE, success: false}
      }

      // Verify openai-compatible endpoint is reachable before persisting anything —
      // a failed setup must not leave a placeholder config that masquerades as
      // connected. Falls back to existing baseUrl/keychain key on reconfigure
      // when the request omits them, so a partial reconfigure (e.g. only changing
      // the URL) still validates with the user's stored credentials.
      if (providerId === 'openai-compatible') {
        const existingBaseUrl = await this.providerConfigStore.read().then((c) => c.getBaseUrl(providerId))
        const effectiveBaseUrl = baseUrl ?? existingBaseUrl
        if (!effectiveBaseUrl) {
          return {
            error: 'A base URL is required for OpenAI-compatible providers (e.g. http://localhost:11434/v1)',
            success: false,
          }
        }

        const effectiveApiKey = apiKey ?? (await this.providerKeychainStore.getApiKey(providerId)) ?? ''
        const validation = await this.validateOpenAICompatibleEndpoint({
          apiKey: effectiveApiKey,
          baseUrl: effectiveBaseUrl,
        })
        if (!validation.isValid) {
          const detail = validation.error ? `: ${validation.error}` : ''
          return {
            error: `Could not reach OpenAI-compatible endpoint at ${effectiveBaseUrl}${detail}`,
            success: false,
          }
        }
      }

      // Store API key if provided (supports optional keys for openai-compatible)
      if (apiKey) {
        await this.providerKeychainStore.setApiKey(providerId, apiKey)
      }

      const provider = getProviderById(providerId)
      // Skip activating the provider when it ends up with no active model —
      // the welcome view treats `activeProvider w/o activeModel` as
      // "needs setup" and unmounts any in-flight setup flow on the home
      // page. The model:setActive handler activates the provider when the
      // user picks a model, which is the right moment.
      //
      // byterover bypasses this gate: it has no model fetcher and no
      // `brv model switch` recovery path, so deferring would strand it as
      // connected-but-never-active. Its model is resolved at runtime via
      // DEFAULT_LLM_MODEL in agent-process.ts rather than persisted here,
      // so future default changes roll out without a per-user migration.
      const willHaveActiveModel = providerId === 'byterover'
        || Boolean(provider?.defaultModel)
        || Boolean(await this.providerConfigStore.getActiveModel(providerId))
      await this.providerConfigStore.connectProvider(providerId, {
        activeModel: provider?.defaultModel,
        authMethod: apiKey ? 'api-key' : undefined,
        baseUrl,
        setAsActive: willHaveActiveModel,
      })

      this.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})
      return {success: true}
    })
  }

  private setupDisconnect(): void {
    this.transport.onRequest<ProviderDisconnectRequest, ProviderDisconnectResponse>(
      ProviderEvents.DISCONNECT,
      async (data) => {
        const {providerId} = data

        await this.providerConfigStore.disconnectProvider(providerId)
        await this.providerKeychainStore.deleteApiKey(providerId)
        await this.providerOAuthTokenStore.delete(providerId)

        this.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})
        return {success: true}
      },
    )
  }

  private setupGetActive(): void {
    this.transport.onRequest<void, ProviderGetActiveResponse>(ProviderEvents.GET_ACTIVE, async () => {
      const activeProviderId = await this.providerConfigStore.getActiveProvider()
      const activeModel = await this.providerConfigStore.getActiveModel(activeProviderId)
      const loginRequired = activeProviderId === 'byterover' && !this.isByteRoverAuthSatisfied()
      return {activeModel, activeProviderId, loginRequired: loginRequired ? true : undefined}
    })
  }

  private setupList(): void {
    this.transport.onRequest<void, ProviderListResponse>(ProviderEvents.LIST, async () => {
      const definitions = getProvidersSortedByPriority()
      const activeProviderId = await this.providerConfigStore.getActiveProvider().catch((error: unknown) => {
        processLog(
          `[ProviderHandler] getActiveProvider failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return ''
      })

      const config = await this.providerConfigStore.read().catch(() => null)

      const providers: ProviderDTO[] = await Promise.all(
        definitions.map(async (def) => {
          const providerConfig = config?.providers[def.id]
          const authMethod = providerConfig?.authMethod

          return {
            activeModel: providerConfig?.activeModel,
            apiKeyUrl: def.apiKeyUrl,
            authMethod,
            category: def.category,
            description: def.description,
            id: def.id,
            isConnected: await this.providerConfigStore.isProviderConnected(def.id).catch((error: unknown) => {
              processLog(
                `[ProviderHandler] isProviderConnected failed for ${def.id}: ${error instanceof Error ? error.message : String(error)}`,
              )
              return false
            }),
            isCurrent: def.id === activeProviderId,
            lastDisconnect: providerConfig?.lastDisconnect,
            name: def.name,
            oauthCallbackMode: def.oauth?.callbackMode,
            oauthLabel: def.oauth?.modes[0]?.label,
            requiresApiKey: providerRequiresApiKey(def.id, authMethod),
            supportsOAuth: Boolean(def.oauth),
          }
        }),
      )

      return {providers}
    })
  }

  private setupSetActive(): void {
    this.transport.onRequest<ProviderSetActiveRequest, ProviderSetActiveResponse>(
      ProviderEvents.SET_ACTIVE,
      async (data) => {
        if (data.providerId === 'byterover' && !this.isByteRoverAuthSatisfied()) {
          return {error: BYTEROVER_AUTH_REQUIRED_MESSAGE, success: false}
        }

        await this.providerConfigStore.setActiveProvider(data.providerId)
        this.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})
        return {success: true}
      },
    )
  }

  /* eslint-disable camelcase -- OAuth query params follow RFC 6749 naming */
  private setupStartOAuth(): void {
    this.transport.onRequest<ProviderStartOAuthRequest, ProviderStartOAuthResponse>(
      ProviderEvents.START_OAUTH,
      async (data, clientId) => {
        const providerDef = getProviderById(data.providerId)
        if (!providerDef?.oauth) {
          const errorResponse: ProviderStartOAuthResponse = {
            authUrl: '',
            callbackMode: 'auto',
            error: 'Provider does not support OAuth',
            success: false,
          }
          return errorResponse
        }

        try {
          const oauthConfig = providerDef.oauth

          // Clean up any existing flow for this provider (race condition guard)
          const existingFlow = this.oauthFlows.get(data.providerId)
          if (existingFlow?.callbackServer) {
            await existingFlow.callbackServer.stop().catch(() => {})
          }

          this.oauthFlows.delete(data.providerId)

          // Generate PKCE parameters
          const pkce = this.generatePkce()

          // Build auth URL
          const mode = oauthConfig.modes.find((m) => m.id === (data.mode ?? 'default')) ?? oauthConfig.modes[0]
          const params = new URLSearchParams({
            client_id: oauthConfig.clientId,
            code_challenge: pkce.codeChallenge,
            code_challenge_method: 'S256',
            redirect_uri: oauthConfig.redirectUri,
            response_type: 'code',
            scope: oauthConfig.scopes,
            state: pkce.state,
          })

          // Provider-specific extra params (e.g. OpenAI's codex_cli_simplified_flow)
          if (oauthConfig.extraParams) {
            for (const [key, value] of Object.entries(oauthConfig.extraParams)) {
              params.set(key, value)
            }
          }

          const authUrl = `${mode.authUrl}?${params.toString()}`

          // Start callback server for auto mode
          let callbackServer: ProviderCallbackServer | undefined
          if (oauthConfig.callbackMode === 'auto' && oauthConfig.callbackPort) {
            callbackServer = this.createCallbackServer({port: oauthConfig.callbackPort})
            await callbackServer.start()
          }

          // Store flow state
          this.oauthFlows.set(data.providerId, {
            callbackServer,
            clientId,
            codeVerifier: pkce.codeVerifier,
            state: pkce.state,
          })

          // Open browser (non-fatal on failure)
          try {
            await this.browserLauncher.open(authUrl)
          } catch {
            processLog(`[ProviderHandler] Browser launch failed for OAuth — user can copy the URL`)
          }

          return {authUrl, callbackMode: oauthConfig.callbackMode, success: true}
        } catch (error) {
          // Clean up callback server if it was started but flow setup failed
          const partialFlow = this.oauthFlows.get(data.providerId)
          if (partialFlow?.callbackServer) {
            await partialFlow.callbackServer.stop().catch(() => {})
          }

          this.oauthFlows.delete(data.providerId)

          const errorResponse: ProviderStartOAuthResponse = {
            authUrl: '',
            callbackMode: 'auto',
            error: getErrorMessage(error),
            success: false,
          }
          return errorResponse
        }
      },
    )
  }
  /* eslint-enable camelcase */

  private setupSubmitOAuthCode(): void {
    this.transport.onRequest<ProviderSubmitOAuthCodeRequest, ProviderSubmitOAuthCodeResponse>(
      ProviderEvents.SUBMIT_OAUTH_CODE,
      // Stub for M2 (Anthropic code-paste flow)
      async () => ({error: 'Code submission is not yet supported for this provider', success: false}),
    )
  }

  private setupValidateApiKey(): void {
    this.transport.onRequest<ProviderValidateApiKeyRequest, ProviderValidateApiKeyResponse>(
      ProviderEvents.VALIDATE_API_KEY,
      async (data) => {
        try {
          const result = await validateApiKeyViaFetcher(data.apiKey, data.providerId)
          return result
        } catch (error) {
          return {error: getErrorMessage(error), isValid: false}
        }
      },
    )
  }
}
