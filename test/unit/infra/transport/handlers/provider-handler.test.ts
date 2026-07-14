/* eslint-disable camelcase -- OAuth token fields use snake_case per RFC 6749 */
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {IBrowserLauncher} from '../../../../../src/server/core/interfaces/services/i-browser-launcher.js'
import type {IAuthStateStore} from '../../../../../src/server/core/interfaces/state/i-auth-state-store.js'
import type {ProviderCallbackServer} from '../../../../../src/server/infra/provider-oauth/callback-server.js'
import type {
  PkceParameters,
  ProviderTokenResponse,
  TokenExchangeParams,
} from '../../../../../src/server/infra/provider-oauth/types.js'

import {ProviderConfig} from '../../../../../src/server/core/domain/entities/provider-config.js'
import {PROVIDER_REGISTRY} from '../../../../../src/server/core/domain/entities/provider-registry.js'
import {TransportDaemonEventNames} from '../../../../../src/server/core/domain/transport/schemas.js'
import {ProviderCallbackTimeoutError} from '../../../../../src/server/infra/provider-oauth/errors.js'
import {ProviderHandler} from '../../../../../src/server/infra/transport/handlers/provider-handler.js'
import {ProviderEvents} from '../../../../../src/shared/transport/events/provider-events.js'
import {
  createMockAuthStateStore,
  createMockProviderConfigStore,
  createMockProviderKeychainStore,
  createMockProviderOAuthTokenStore,
  createMockTransportServer,
} from '../../../../helpers/mock-factories.js'

// ==================== Test Helpers ====================

function createMockBrowserLauncher(): sinon.SinonStubbedInstance<IBrowserLauncher> {
  return {open: stub<[string], Promise<void>>().resolves()} as unknown as sinon.SinonStubbedInstance<IBrowserLauncher>
}

function createMockCallbackServer(): sinon.SinonStubbedInstance<ProviderCallbackServer> {
  return {
    getAddress: stub().returns({port: 1455}),
    start: stub().resolves(1455),
    stop: stub().resolves(),
    waitForCallback: stub().resolves({code: 'test-auth-code', state: 'test-state'}),
  } as unknown as sinon.SinonStubbedInstance<ProviderCallbackServer>
}

const TEST_PKCE: PkceParameters = {
  codeChallenge: 'test-challenge',
  codeVerifier: 'test-verifier',
  state: 'test-state',
}

const TEST_TOKEN_RESPONSE: ProviderTokenResponse = {
  access_token: 'test-access-token',
  expires_in: 3600,
  // JWT payload: { chatgpt_account_id: "acct_test123" }
  id_token: `eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify({chatgpt_account_id: 'acct_test123'})).toString('base64url')}.fake`,
  refresh_token: 'test-refresh-token',
}

// ==================== Tests ====================

describe('ProviderHandler', () => {
  let authStateStore: IAuthStateStore
  let providerConfigStore: ReturnType<typeof createMockProviderConfigStore>
  let providerKeychainStore: ReturnType<typeof createMockProviderKeychainStore>
  let providerOAuthTokenStore: ReturnType<typeof createMockProviderOAuthTokenStore>
  let transport: ReturnType<typeof createMockTransportServer>
  let browserLauncher: sinon.SinonStubbedInstance<IBrowserLauncher>
  let mockCallbackServer: sinon.SinonStubbedInstance<ProviderCallbackServer>
  let generatePkceStub: sinon.SinonStub<[], PkceParameters>
  let exchangeCodeStub: sinon.SinonStub<[TokenExchangeParams], Promise<ProviderTokenResponse>>

  beforeEach(() => {
    authStateStore = createMockAuthStateStore(sinon)
    providerConfigStore = createMockProviderConfigStore()
    providerKeychainStore = createMockProviderKeychainStore()
    providerOAuthTokenStore = createMockProviderOAuthTokenStore()
    transport = createMockTransportServer()
    browserLauncher = createMockBrowserLauncher()
    mockCallbackServer = createMockCallbackServer()
    generatePkceStub = stub<[], PkceParameters>().returns(TEST_PKCE)
    exchangeCodeStub = stub<[TokenExchangeParams], Promise<ProviderTokenResponse>>().resolves(TEST_TOKEN_RESPONSE)
  })

  afterEach(() => {
    restore()
  })

  function createHandler(): ProviderHandler {
    const handler = new ProviderHandler({
      authStateStore,
      browserLauncher,
      createCallbackServer: () => mockCallbackServer as unknown as ProviderCallbackServer,
      exchangeCodeForTokens: exchangeCodeStub,
      generatePkce: generatePkceStub,
      providerConfigStore,
      providerKeychainStore,
      providerOAuthTokenStore,
      transport,
    })
    handler.setup()
    return handler
  }

  function createHandlerWithValidator(
    validateOpenAICompatibleEndpoint: (params: {apiKey: string; baseUrl: string}) => Promise<{
      error?: string
      isValid: boolean
    }>,
  ): ProviderHandler {
    const handler = new ProviderHandler({
      authStateStore,
      browserLauncher,
      createCallbackServer: () => mockCallbackServer as unknown as ProviderCallbackServer,
      exchangeCodeForTokens: exchangeCodeStub,
      generatePkce: generatePkceStub,
      providerConfigStore,
      providerKeychainStore,
      providerOAuthTokenStore,
      transport,
      validateOpenAICompatibleEndpoint,
    })
    handler.setup()
    return handler
  }

  describe('setup', () => {
    it('should register all provider event handlers', () => {
      createHandler()

      expect(transport._handlers.has(ProviderEvents.LIST)).to.be.true
      expect(transport._handlers.has(ProviderEvents.CONNECT)).to.be.true
      expect(transport._handlers.has(ProviderEvents.DISCONNECT)).to.be.true
      expect(transport._handlers.has(ProviderEvents.SET_ACTIVE)).to.be.true
      expect(transport._handlers.has(ProviderEvents.VALIDATE_API_KEY)).to.be.true
      expect(transport._handlers.has(ProviderEvents.START_OAUTH)).to.be.true
      expect(transport._handlers.has(ProviderEvents.AWAIT_OAUTH_CALLBACK)).to.be.true
      expect(transport._handlers.has(ProviderEvents.CANCEL_OAUTH)).to.be.true
      expect(transport._handlers.has(ProviderEvents.SUBMIT_OAUTH_CODE)).to.be.true
    })

    it('should register a disconnection handler', () => {
      createHandler()

      expect(transport._disconnectionHandlers.length).to.equal(1)
    })
  })

  describe('provider:connect', () => {
    it('should broadcast provider:updated after connecting', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.CONNECT)
      const result = await handler!({apiKey: 'test-key', providerId: 'openrouter'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(transport.broadcast.calledOnce).to.be.true
      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true
    })

    it('should store API key before connecting', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.CONNECT)
      await handler!({apiKey: 'test-key', providerId: 'openrouter'}, 'client-1')

      expect(providerKeychainStore.setApiKey.calledBefore(providerConfigStore.connectProvider)).to.be.true
    })

    it('should connect with authMethod api-key when API key provided', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.CONNECT)
      await handler!({apiKey: 'test-key', providerId: 'openrouter'}, 'client-1')

      const connectArgs = providerConfigStore.connectProvider.firstCall.args[1] as Record<string, unknown>
      expect(connectArgs.authMethod).to.equal('api-key')
    })

    it('should broadcast after connectProvider completes', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.CONNECT)
      await handler!({providerId: 'byterover'}, 'client-1')

      expect(providerConfigStore.connectProvider.calledBefore(transport.broadcast)).to.be.true
    })

    describe('openai-compatible URL validation', () => {
      beforeEach(() => {
        // setupConnect now reads existing config to fall back on stored
        // baseUrl/apiKey when the request omits them — give the mock a
        // sensible default so each test doesn't have to wire it up.
        providerConfigStore.read.resolves(ProviderConfig.createDefault())
      })

      it('should validate base URL via injected validator before persisting anything', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        const result = await connectHandler!(
          {apiKey: 'test-key', baseUrl: 'http://localhost:11434/v1', providerId: 'openai-compatible'},
          'client-1',
        )

        expect(result).to.deep.equal({success: true})
        expect(validateStub.calledOnce).to.be.true
        expect(validateStub.firstCall.args[0]).to.deep.equal({
          apiKey: 'test-key',
          baseUrl: 'http://localhost:11434/v1',
        })
        expect(validateStub.calledBefore(providerKeychainStore.setApiKey)).to.be.true
        expect(validateStub.calledBefore(providerConfigStore.connectProvider)).to.be.true
      })

      it('should return error and persist nothing when endpoint validation fails', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({error: 'connect ECONNREFUSED', isValid: false})
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        const result = await connectHandler!(
          {apiKey: 'test-key', baseUrl: 'http://nope', providerId: 'openai-compatible'},
          'client-1',
        )

        expect(result.success).to.be.false
        expect(result.error).to.include('http://nope')
        expect(result.error).to.include('connect ECONNREFUSED')
        expect(providerKeychainStore.setApiKey.notCalled).to.be.true
        expect(providerConfigStore.connectProvider.notCalled).to.be.true
        expect(transport.broadcast.notCalled).to.be.true
      })

      it('should not pre-write activeModel for openai-compatible', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        await connectHandler!(
          {baseUrl: 'http://localhost:11434/v1', providerId: 'openai-compatible'},
          'client-1',
        )

        const connectArgs = providerConfigStore.connectProvider.firstCall.args[1] as Record<string, unknown>
        expect(connectArgs.activeModel).to.be.undefined
        expect(connectArgs.baseUrl).to.equal('http://localhost:11434/v1')
      })

      it('should reject with friendly error when no baseUrl is provided and none is stored', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        providerConfigStore.read.resolves(ProviderConfig.createDefault())
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        const result = await connectHandler!({providerId: 'openai-compatible'}, 'client-1')

        expect(result.success).to.be.false
        expect(result.error).to.include('base URL is required')
        expect(validateStub.notCalled).to.be.true
        expect(providerConfigStore.connectProvider.notCalled).to.be.true
      })

      it('should validate with the stored baseUrl when the request omits it', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        const stored = ProviderConfig.createDefault().withProviderConnected('openai-compatible', {
          baseUrl: 'http://stored:11434/v1',
        })
        providerConfigStore.read.resolves(stored)
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        const result = await connectHandler!({providerId: 'openai-compatible'}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect(validateStub.firstCall.args[0]).to.deep.include({baseUrl: 'http://stored:11434/v1'})
      })

      it('should validate with the stored API key when the request omits it', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        providerKeychainStore.getApiKey.withArgs('openai-compatible').resolves('stored-key')
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        await connectHandler!(
          {baseUrl: 'http://localhost:11434/v1', providerId: 'openai-compatible'},
          'client-1',
        )

        expect(validateStub.firstCall.args[0]).to.deep.equal({
          apiKey: 'stored-key',
          baseUrl: 'http://localhost:11434/v1',
        })
      })

      it('should not validate non-openai-compatible providers', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        await connectHandler!({apiKey: 'test-key', providerId: 'openrouter'}, 'client-1')

        expect(validateStub.notCalled).to.be.true
      })

      it('should not activate openai-compatible when no active model will be set', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        providerConfigStore.getActiveModel.withArgs('openai-compatible').resolves()
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        await connectHandler!(
          {baseUrl: 'http://localhost:11434/v1', providerId: 'openai-compatible'},
          'client-1',
        )

        const connectArgs = providerConfigStore.connectProvider.firstCall.args[1] as Record<string, unknown>
        expect(connectArgs.setAsActive).to.equal(false)
      })

      it('should activate openai-compatible when an existing active model will be preserved', async () => {
        const validateStub = stub<
          [{apiKey: string; baseUrl: string}],
          Promise<{error?: string; isValid: boolean}>
        >().resolves({isValid: true})
        providerConfigStore.getActiveModel.withArgs('openai-compatible').resolves('qwen3.5-9b')
        createHandlerWithValidator(validateStub)

        const connectHandler = transport._handlers.get(ProviderEvents.CONNECT)
        await connectHandler!(
          {baseUrl: 'http://localhost:11434/v1', providerId: 'openai-compatible'},
          'client-1',
        )

        const connectArgs = providerConfigStore.connectProvider.firstCall.args[1] as Record<string, unknown>
        expect(connectArgs.setAsActive).to.equal(true)
      })
    })

    it('should activate non-openai-compatible providers (registry has a defaultModel)', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.CONNECT)
      await handler!({apiKey: 'test-key', providerId: 'openrouter'}, 'client-1')

      const connectArgs = providerConfigStore.connectProvider.firstCall.args[1] as Record<string, unknown>
      expect(connectArgs.setAsActive).to.equal(true)
    })

    it('should activate byterover on connect without persisting an activeModel', async () => {
      // byterover bypasses the gate (no model fetcher, no model-switch recovery path); runtime resolves via DEFAULT_LLM_MODEL.
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.CONNECT)
      await handler!({providerId: 'byterover'}, 'client-1')

      const connectArgs = providerConfigStore.connectProvider.firstCall.args[1] as Record<string, unknown>
      expect(connectArgs.setAsActive).to.equal(true)
      expect(connectArgs.activeModel).to.be.undefined
    })
  })

  describe('provider:disconnect', () => {
    it('should broadcast provider:updated after disconnecting', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.DISCONNECT)
      const result = await handler!({providerId: 'openrouter'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(transport.broadcast.calledOnce).to.be.true
      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true
    })

    it('should delete API key for providers that require one', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.DISCONNECT)
      await handler!({providerId: 'openrouter'}, 'client-1')

      expect(providerKeychainStore.deleteApiKey.calledWith('openrouter')).to.be.true
    })

    it('should delete OAuth tokens from encrypted store', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.DISCONNECT)
      await handler!({providerId: 'openai'}, 'client-1')

      expect(providerOAuthTokenStore.delete.calledWith('openai')).to.be.true
    })

    it('should broadcast after disconnectProvider completes', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.DISCONNECT)
      await handler!({providerId: 'openrouter'}, 'client-1')

      expect(providerConfigStore.disconnectProvider.calledBefore(transport.broadcast)).to.be.true
    })
  })

  describe('provider:setActive', () => {
    it('should broadcast provider:updated after setting active provider', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.createDefault().withProviderConnected('openrouter', {authMethod: 'api-key'}),
      )
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.SET_ACTIVE)
      const result = await handler!({providerId: 'openrouter'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(transport.broadcast.calledOnce).to.be.true
      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true
    })

    it('should set active provider before broadcasting', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.createDefault().withProviderConnected('openrouter', {authMethod: 'api-key'}),
      )
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.SET_ACTIVE)
      await handler!({providerId: 'openrouter'}, 'client-1')

      expect(providerConfigStore.setActiveProvider.calledWith('openrouter')).to.be.true
      expect(providerConfigStore.setActiveProvider.calledBefore(transport.broadcast)).to.be.true
    })

    it('should reject a disconnected tombstone (permanent OAuth refresh failure) and not mutate the active provider', async () => {
      // The entry still exists in config.providers (kept for lastDisconnect),
      // so presence alone must not be enough to let SET_ACTIVE reactivate it.
      providerConfigStore.read.resolves(
        ProviderConfig.createDefault()
          .withProviderConnected('openai', {authMethod: 'oauth'})
          .withProviderDisconnected('openai', {
            errorCode: 'invalid_grant',
            reason: 'OAuth token refresh failed',
            statusCode: 400,
          }),
      )
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.SET_ACTIVE)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.false
      expect(result.error).to.equal('Provider "openai" is not connected')
      expect(providerConfigStore.setActiveProvider.called).to.be.false
      expect(transport.broadcast.called).to.be.false
    })

    it('should still succeed for a healthy (non-tombstoned) connected provider', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.createDefault().withProviderConnected('openrouter', {authMethod: 'api-key'}),
      )
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.SET_ACTIVE)
      const result = await handler!({providerId: 'openrouter'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.setActiveProvider.calledWith('openrouter')).to.be.true
    })
  })

  describe('provider:getActive', () => {
    it('should include loginRequired when byterover is active and unauthenticated', async () => {
      authStateStore = createMockAuthStateStore(sinon, {isAuthenticated: false})
      providerConfigStore.getActiveProvider.resolves('byterover')
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.GET_ACTIVE)
      const result = await handler!(undefined, 'client-1')

      expect(result.loginRequired).to.be.true
    })

    it('should not include loginRequired when byterover is active and authenticated', async () => {
      providerConfigStore.getActiveProvider.resolves('byterover')
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.GET_ACTIVE)
      const result = await handler!(undefined, 'client-1')

      expect(result.loginRequired).to.be.undefined
    })

    it('should not include loginRequired for non-byterover providers', async () => {
      authStateStore = createMockAuthStateStore(sinon, {isAuthenticated: false})
      providerConfigStore.getActiveProvider.resolves('openrouter')
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.GET_ACTIVE)
      const result = await handler!(undefined, 'client-1')

      expect(result.loginRequired).to.be.undefined
    })
  })

  // ==================== OAuth: START_OAUTH ====================

  describe('provider:startOAuth', () => {
    it('should return error for provider without OAuth config', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.START_OAUTH)
      const result = await handler!({providerId: 'anthropic'}, 'client-1')

      expect(result).to.deep.include({success: false})
      expect(result.error).to.include('does not support OAuth')
    })

    it('should generate PKCE parameters and build auth URL for OpenAI', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.START_OAUTH)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.true
      expect(result.callbackMode).to.equal('auto')
      expect(result.authUrl).to.include('https://auth.openai.com/oauth/authorize')
      expect(result.authUrl).to.include('client_id=app_EMoamEEZ73f0CkXaXp7hrann')
      expect(result.authUrl).to.include('code_challenge=test-challenge')
      expect(result.authUrl).to.include('state=test-state')
      expect(result.authUrl).to.include('code_challenge_method=S256')
      expect(result.authUrl).to.include('response_type=code')
    })

    it('should include OpenAI-specific auth URL parameters', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.START_OAUTH)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(result.authUrl).to.include('id_token_add_organizations=true')
      expect(result.authUrl).to.include('originator=byterover')
      expect(result.authUrl).to.include('codex_cli_simplified_flow=true')
    })

    it('should start callback server on configured port', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await handler!({providerId: 'openai'}, 'client-1')

      expect(mockCallbackServer.start.calledOnce).to.be.true
    })

    it('should open browser with auth URL', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.START_OAUTH)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(browserLauncher.open.calledOnce).to.be.true
      expect(browserLauncher.open.firstCall.args[0]).to.equal(result.authUrl)
    })

    it('should not fail if browser launch fails', async () => {
      browserLauncher.open.rejects(new Error('No browser available'))
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.START_OAUTH)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.true
    })

    it('should stop existing flow before starting a new one for the same provider', async () => {
      const firstServer = createMockCallbackServer()
      const secondServer = createMockCallbackServer()
      let callCount = 0

      const handler = new ProviderHandler({
        authStateStore,
        browserLauncher,
        createCallbackServer() {
          callCount++
          return (callCount === 1 ? firstServer : secondServer) as unknown as ProviderCallbackServer
        },
        exchangeCodeForTokens: exchangeCodeStub,
        generatePkce: generatePkceStub,
        providerConfigStore,
        providerKeychainStore,
        providerOAuthTokenStore,
        transport,
      })
      handler.setup()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)

      // Start first flow
      await startHandler!({providerId: 'openai'}, 'client-1')
      expect(firstServer.start.calledOnce).to.be.true

      // Start second flow for the same provider — should stop the first
      await startHandler!({providerId: 'openai'}, 'client-1')

      expect(firstServer.stop.calledOnce).to.be.true
      expect(secondServer.start.calledOnce).to.be.true
    })

    it('should succeed and keep callback server running even if browser launch fails', async () => {
      const failingServer = createMockCallbackServer()
      // Server starts successfully but browser launch throws after server is stored
      browserLauncher.open.callsFake(() => {
        throw new Error('Simulated failure after server start')
      })

      const handler = new ProviderHandler({
        authStateStore,
        browserLauncher,
        createCallbackServer: () => failingServer as unknown as ProviderCallbackServer,
        exchangeCodeForTokens: exchangeCodeStub,
        generatePkce: generatePkceStub,
        providerConfigStore,
        providerKeychainStore,
        providerOAuthTokenStore,
        transport,
      })
      handler.setup()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      const result = await startHandler!({providerId: 'openai'}, 'client-1')

      // Browser launch failure is non-fatal — flow should succeed
      expect(result.success).to.be.true
      expect(failingServer.start.calledOnce).to.be.true
    })
  })

  // ==================== OAuth: AWAIT_OAUTH_CALLBACK ====================

  describe('provider:awaitOAuthCallback', () => {
    it('should return error when no active flow exists', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.include({success: false})
      expect(result.error).to.include('No active OAuth flow')
    })

    it('should return error when a concurrent await is already in progress', async () => {
      // Make waitForCallback block indefinitely so first await stays in progress
      mockCallbackServer.waitForCallback.returns(new Promise(() => {}))
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)

      // Fire first await (will block forever) — no need to await it
      awaitHandler!({providerId: 'openai'}, 'client-1')

      // Second await should fail immediately
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')
      expect(result).to.deep.include({success: false})
      expect(result.error).to.include('already being awaited')
    })

    it('should exchange code for tokens and store credentials on success', async () => {
      createHandler()

      // First start the OAuth flow to create the flow state
      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      // Now await the callback
      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})

      // Verify token exchange was called
      expect(exchangeCodeStub.calledOnce).to.be.true
      const exchangeArgs = exchangeCodeStub.firstCall.args[0]
      expect(exchangeArgs.code).to.equal('test-auth-code')
      expect(exchangeArgs.codeVerifier).to.equal('test-verifier')
      expect(exchangeArgs.clientId).to.equal('app_EMoamEEZ73f0CkXaXp7hrann')
      expect(exchangeArgs.contentType).to.equal('application/x-www-form-urlencoded')
    })

    it('should store access token in keychain', async () => {
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(providerKeychainStore.setApiKey.calledWith('openai', 'test-access-token')).to.be.true
    })

    it('should connect provider with authMethod oauth and oauthAccountId', async () => {
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(providerConfigStore.connectProvider.calledOnce).to.be.true
      const connectArgs = providerConfigStore.connectProvider.firstCall.args
      expect(connectArgs[0]).to.equal('openai')
      expect(connectArgs[1]).to.deep.include({
        authMethod: 'oauth',
        oauthAccountId: 'acct_test123',
      })
    })

    it('should use OAuth-specific default model instead of provider default', async () => {
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      await awaitHandler!({providerId: 'openai'}, 'client-1')

      const connectOptions = providerConfigStore.connectProvider.firstCall.args[1] as Record<string, unknown>
      // OAuth connect should use the OAuth-specific default (Codex model), not the provider's generic default (gpt-4.1)
      expect(connectOptions.activeModel).to.equal(PROVIDER_REGISTRY.openai.oauth!.defaultModel)
    })

    it('should store refresh token and expiry in encrypted OAuth token store', async () => {
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      await awaitHandler!({providerId: 'openai'}, 'client-1')

      // Verify tokens stored in encrypted store, NOT in provider config
      expect(providerOAuthTokenStore.set.calledOnce).to.be.true
      const [providerId, tokenRecord] = providerOAuthTokenStore.set.firstCall.args
      expect(providerId).to.equal('openai')
      expect(tokenRecord.refreshToken).to.equal('test-refresh-token')
      expect(tokenRecord.expiresAt).to.be.a('string')
      // Verify it's a valid ISO timestamp roughly 1 hour from now
      const expiresAt = new Date(tokenRecord.expiresAt).getTime()
      const expectedApprox = Date.now() + 3600 * 1000
      expect(Math.abs(expiresAt - expectedApprox)).to.be.lessThan(5000)

      // Verify connectProvider receives OAuth metadata (not tokens — those are in encrypted store)
      const connectArgs = providerConfigStore.connectProvider.firstCall.args[1]
      expect(connectArgs?.authMethod).to.equal('oauth')
    })

    it('should broadcast PROVIDER_UPDATED on success', async () => {
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      // Reset broadcast from startOAuth (no broadcast there, but just in case)
      transport.broadcast.resetHistory()

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true
    })

    it('should stop callback server and clean up flow state on success', async () => {
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      await awaitHandler!({providerId: 'openai'}, 'client-1')

      // Callback server should be stopped
      expect(mockCallbackServer.stop.calledOnce).to.be.true

      // Second await should fail (flow cleaned up)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')
      expect(result).to.deep.include({success: false})
    })

    it('should stop callback server and clean up flow state on failure', async () => {
      mockCallbackServer.waitForCallback.rejects(new Error('Timeout'))
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.include({success: false})
      expect(result.error).to.include('Timeout')

      // Callback server should be stopped
      expect(mockCallbackServer.stop.calledOnce).to.be.true

      // Second await should also fail (flow cleaned up)
      const result2 = await awaitHandler!({providerId: 'openai'}, 'client-1')
      expect(result2).to.deep.include({success: false})
      expect(result2.error).to.include('No active OAuth flow')
    })

    it('should return user-friendly message on callback timeout', async () => {
      mockCallbackServer.waitForCallback.rejects(new ProviderCallbackTimeoutError(300_000))
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.include({success: false})
      expect(result.error).to.equal('Authentication timed out. Please try again.')
    })

    it('should return error when token exchange fails', async () => {
      exchangeCodeStub.rejects(new Error('Token exchange failed'))
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.include({success: false})
      expect(result.error).to.include('Token exchange failed')
    })

    it('should store refresh token with default expiry when expires_in is missing', async () => {
      exchangeCodeStub.resolves({
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        // No expires_in in response
      })
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})

      // Refresh token should still be stored with a default 1-hour expiry
      expect(providerOAuthTokenStore.set.calledOnce).to.be.true
      const [providerId, tokenRecord] = providerOAuthTokenStore.set.firstCall.args
      expect(providerId).to.equal('openai')
      expect(tokenRecord.refreshToken).to.equal('test-refresh-token')
      // Default expiry should be roughly 1 hour from now
      const expiresAt = new Date(tokenRecord.expiresAt).getTime()
      const expectedApprox = Date.now() + 3600 * 1000
      expect(Math.abs(expiresAt - expectedApprox)).to.be.lessThan(5000)
    })

    it('should not store in OAuth token store when no refresh_token returned', async () => {
      exchangeCodeStub.resolves({
        access_token: 'test-access-token',
        expires_in: 3600,
        // No refresh_token in response
      })
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      // Access token should still be stored in keychain
      expect(providerKeychainStore.setApiKey.calledWith('openai', 'test-access-token')).to.be.true
      // But no refresh token to store
      expect(providerOAuthTokenStore.set.notCalled).to.be.true
    })

    it('should handle missing id_token gracefully (oauthAccountId undefined)', async () => {
      exchangeCodeStub.resolves({
        access_token: 'test-access-token',
        expires_in: 3600,
      })
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const awaitHandler = transport._handlers.get(ProviderEvents.AWAIT_OAUTH_CALLBACK)
      const result = await awaitHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      const connectArgs = providerConfigStore.connectProvider.firstCall.args[1]
      expect(connectArgs?.oauthAccountId).to.be.undefined
    })
  })

  // ==================== OAuth: SUBMIT_OAUTH_CODE ====================

  describe('provider:submitOAuthCode', () => {
    it('should return error (stub for M2 Anthropic)', async () => {
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.SUBMIT_OAUTH_CODE)
      const result = await handler!({code: 'some-code', providerId: 'anthropic'}, 'client-1')

      expect(result).to.deep.include({success: false})
      expect(result.error).to.include('not yet supported')
    })
  })

  // ==================== List with OAuth fields ====================

  describe('provider:list (OAuth fields)', () => {
    it('should include supportsOAuth field based on provider registry', async () => {
      providerConfigStore.read.resolves(ProviderConfig.createDefault())
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.LIST)
      const result = await handler!(undefined, 'client-1')

      const openaiProvider = result.providers.find((p: {id: string}) => p.id === 'openai')
      const anthropicProvider = result.providers.find((p: {id: string}) => p.id === 'anthropic')

      expect(openaiProvider?.supportsOAuth).to.be.true
      expect(anthropicProvider?.supportsOAuth).to.be.false
    })

    it('should include authMethod from config for connected providers', async () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openai', {
        authMethod: 'oauth',
        oauthAccountId: 'acct_123',
      })
      providerConfigStore.read.resolves(config)
      providerConfigStore.isProviderConnected.withArgs('openai').resolves(true)
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.LIST)
      const result = await handler!(undefined, 'client-1')

      const openaiProvider = result.providers.find((p: {id: string}) => p.id === 'openai')
      expect(openaiProvider?.authMethod).to.equal('oauth')
      expect(openaiProvider?.requiresApiKey).to.be.false
    })

    it('should expose activeModel as undefined for openai-compatible connected without a model', async () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openai-compatible', {
        baseUrl: 'http://localhost:11434/v1',
      })
      providerConfigStore.read.resolves(config)
      providerConfigStore.isProviderConnected.withArgs('openai-compatible').resolves(true)
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.LIST)
      const result = await handler!(undefined, 'client-1')

      const openaiCompat = result.providers.find((p: {id: string}) => p.id === 'openai-compatible')
      expect(openaiCompat?.isConnected).to.be.true
      expect(openaiCompat?.activeModel).to.be.undefined
    })

    it('should surface lastDisconnect for a provider disconnected with a recorded reason', async () => {
      const config = ProviderConfig.createDefault()
        .withProviderConnected('openai', {authMethod: 'oauth', oauthAccountId: 'acct_123'})
        .withProviderDisconnected('openai', {
          errorCode: 'invalid_grant',
          reason: 'OAuth token refresh failed',
          statusCode: 400,
        })
      providerConfigStore.read.resolves(config)
      providerConfigStore.isProviderConnected.withArgs('openai').resolves(false)
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.LIST)
      const result = await handler!(undefined, 'client-1')

      const openaiProvider = result.providers.find((p: {id: string}) => p.id === 'openai')
      // Not connected, but the drop reason is surfaced so the view can explain it
      expect(openaiProvider?.isConnected).to.be.false
      expect(openaiProvider?.lastDisconnect?.reason).to.equal('OAuth token refresh failed')
      expect(openaiProvider?.lastDisconnect?.errorCode).to.equal('invalid_grant')
      expect(openaiProvider?.lastDisconnect?.statusCode).to.equal(400)
      // authMethod is retained so the reconnect hint can choose the --oauth form
      expect(openaiProvider?.authMethod).to.equal('oauth')
    })

    it('should omit lastDisconnect for a normally connected provider', async () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openai', {authMethod: 'oauth'})
      providerConfigStore.read.resolves(config)
      providerConfigStore.isProviderConnected.withArgs('openai').resolves(true)
      createHandler()

      const handler = transport._handlers.get(ProviderEvents.LIST)
      const result = await handler!(undefined, 'client-1')

      const openaiProvider = result.providers.find((p: {id: string}) => p.id === 'openai')
      expect(openaiProvider?.isConnected).to.be.true
      expect(openaiProvider?.lastDisconnect).to.be.undefined
    })
  })

  describe('provider:cancelOAuth', () => {
    it('should stop callback server and delete flow', async () => {
      createHandler()

      // Start an OAuth flow first
      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')
      expect(mockCallbackServer.start.calledOnce).to.be.true

      // Cancel it
      const cancelHandler = transport._handlers.get(ProviderEvents.CANCEL_OAUTH)
      const result = await cancelHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(mockCallbackServer.stop.called).to.be.true
    })

    it('should return success when no active flow exists (idempotent)', async () => {
      createHandler()

      const cancelHandler = transport._handlers.get(ProviderEvents.CANCEL_OAUTH)
      const result = await cancelHandler!({providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
    })

    it('should allow a new OAuth flow after cancellation', async () => {
      createHandler()

      // Start, cancel, then start again
      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      const cancelHandler = transport._handlers.get(ProviderEvents.CANCEL_OAUTH)
      await cancelHandler!({providerId: 'openai'}, 'client-1')

      // Reset the mock to track the second start
      mockCallbackServer.start.resetHistory()
      const result = await startHandler!({providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.true
      expect(mockCallbackServer.start.calledOnce).to.be.true
    })
  })

  describe('client disconnect cleanup', () => {
    it('should stop callback server when initiating client disconnects', async () => {
      createHandler()

      // Start an OAuth flow
      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      // Simulate client disconnect
      transport._simulateDisconnect('client-1')

      expect(mockCallbackServer.stop.called).to.be.true
    })

    it('should not affect flows from other clients', async () => {
      createHandler()

      // Start an OAuth flow from client-1
      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      // Simulate disconnect of a different client
      transport._simulateDisconnect('client-2')

      // Callback server should NOT be stopped
      expect(mockCallbackServer.stop.called).to.be.false
    })

    it('should allow new flow after disconnect cleanup', async () => {
      createHandler()

      const startHandler = transport._handlers.get(ProviderEvents.START_OAUTH)
      await startHandler!({providerId: 'openai'}, 'client-1')

      transport._simulateDisconnect('client-1')

      // Reset mock and start a new flow from another client
      mockCallbackServer.start.resetHistory()
      const result = await startHandler!({providerId: 'openai'}, 'client-2')

      expect(result.success).to.be.true
      expect(mockCallbackServer.start.calledOnce).to.be.true
    })
  })

  // ==================== ByteRover Auth Gate ====================

  describe('ByteRover auth gate', () => {
    describe('provider:connect', () => {
      it('should return error when connecting byterover without auth', async () => {
        authStateStore = createMockAuthStateStore(sinon, {isAuthenticated: false})
        createHandler()

        const handler = transport._handlers.get(ProviderEvents.CONNECT)
        const result = await handler!({providerId: 'byterover'}, 'client-1')

        expect(result.success).to.be.false
        expect(result.error).to.include('ByteRover account')
        expect(result.error).to.include('brv login --api-key')
      })

      it('should succeed when connecting byterover with valid auth', async () => {
        createHandler()

        const handler = transport._handlers.get(ProviderEvents.CONNECT)
        const result = await handler!({providerId: 'byterover'}, 'client-1')

        expect(result.success).to.be.true
      })

      it('should not check auth when connecting non-byterover provider', async () => {
        authStateStore = createMockAuthStateStore(sinon, {isAuthenticated: false})
        createHandler()

        const handler = transport._handlers.get(ProviderEvents.CONNECT)
        const result = await handler!({apiKey: 'key-123', providerId: 'openrouter'}, 'client-1')

        expect(result.success).to.be.true
      })
    })

    describe('provider:setActive', () => {
      it('should return error when setting byterover active without auth', async () => {
        authStateStore = createMockAuthStateStore(sinon, {isAuthenticated: false})
        createHandler()

        const handler = transport._handlers.get(ProviderEvents.SET_ACTIVE)
        const result = await handler!({providerId: 'byterover'}, 'client-1')

        expect(result.success).to.be.false
        expect(result.error).to.include('ByteRover account')
        expect(result.error).to.include('brv login --api-key')
      })

      it('should succeed when setting byterover active with valid auth', async () => {
        createHandler()

        const handler = transport._handlers.get(ProviderEvents.SET_ACTIVE)
        const result = await handler!({providerId: 'byterover'}, 'client-1')

        expect(result.success).to.be.true
      })
    })
  })
})
