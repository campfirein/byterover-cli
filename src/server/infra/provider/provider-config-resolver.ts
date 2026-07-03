/**
 * Provider Config Resolver
 *
 * Resolves the full provider configuration (API key, base URL, headers, etc.)
 * for the currently active provider. Used by the daemon state server to serve
 * agent child processes on startup and after provider hot-swap.
 */

import type {IProviderConfigStore} from '../../core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../core/interfaces/i-provider-keychain-store.js'
import type {IProviderOAuthTokenStore} from '../../core/interfaces/i-provider-oauth-token-store.js'
import type {ITokenRefreshManager} from '../../core/interfaces/i-token-refresh-manager.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'

import {CHATGPT_OAUTH_BASE_URL, CHATGPT_OAUTH_ORIGINATOR} from '../../../shared/constants/oauth.js'
import {getProviderById, providerRequiresApiKey} from '../../core/domain/entities/provider-registry.js'
import {type ProviderConfigResponse} from '../../core/domain/transport/schemas.js'
import {getProviderApiKeyFromEnv} from './env-provider-detector.js'

/**
 * Check if a provider's credential (API key or OAuth access token) is accessible.
 *
 * Note: authMethod is intentionally NOT passed to providerRequiresApiKey() here.
 * OAuth access tokens are stored in the keychain (as the provider's "API key"),
 * so the keychain check on the next line correctly handles both auth methods.
 * If an OAuth token expires and the refresh manager (Issue 5) deletes it from
 * keychain, this function returns false — correctly marking the provider as stale.
 */
async function isProviderCredentialAccessible(
  providerId: string,
  providerKeychainStore: IProviderKeychainStore,
): Promise<boolean> {
  if (!providerRequiresApiKey(providerId)) return true
  return Boolean((await providerKeychainStore.getApiKey(providerId)) || getProviderApiKeyFromEnv(providerId))
}

/**
 * Validate provider config integrity at startup.
 *
 * Iterates ALL connected providers and disconnects any whose credentials are no
 * longer accessible. This handles migration from v1 (system keychain) to v2
 * (file-based keystore) and other stale credential scenarios.
 *
 * If the previously active provider was stale, explicitly sets activeProvider to
 * empty string so the TUI routes to the provider setup flow — bypassing the
 * 'byterover' fallback that withProviderDisconnected() would otherwise apply.
 */
export async function clearStaleProviderConfig(
  providerConfigStore: IProviderConfigStore,
  providerKeychainStore: IProviderKeychainStore,
  providerOAuthTokenStore?: IProviderOAuthTokenStore,
): Promise<void> {
  try {
    const config = await providerConfigStore.read()

    const results = await Promise.all(
      Object.keys(config.providers).map(async (providerId) => ({
        accessible: await isProviderCredentialAccessible(providerId, providerKeychainStore),
        providerId,
      })),
    )

    const staleProviderIds = results.filter(({accessible}) => !accessible).map(({providerId}) => providerId)

    if (staleProviderIds.length === 0) return

    // Build new config in ONE pass — avoids parallel-write race conditions
    // where multiple disconnectProvider() calls read the same cached config.
    let newConfig = config
    for (const providerId of staleProviderIds) {
      newConfig = newConfig.withProviderDisconnected(providerId)
    }

    // withProviderDisconnected() already sets activeProvider to '' when the active
    // provider is removed. This call is a no-op but kept for readability — it makes
    // the "clear active provider" intent explicit at the call site.
    if (staleProviderIds.includes(config.activeProvider)) {
      newConfig = newConfig.withActiveProvider('')
    }

    await providerConfigStore.write(newConfig)

    // Clean up orphaned OAuth tokens for stale providers (consistent with
    // the 3-store cleanup in TokenRefreshManager and ProviderHandler.setupDisconnect)
    if (providerOAuthTokenStore) {
      await Promise.all(staleProviderIds.map((id) => providerOAuthTokenStore.delete(id).catch(() => {})))
    }
  } catch {
    // Non-critical: if validation fails, daemon continues normally.
    // The user will encounter a provider error when submitting a task instead.
  }
}

/**
 * Resolve the active provider's full configuration.
 *
 * Reads the active provider/model from the config store, resolves
 * the API key (keychain → env fallback), and maps provider-specific
 * fields (base URL, headers, location, etc.).
 */
export type ResolveProviderConfigParams = {
  authStateStore?: IAuthStateStore
  providerConfigStore: IProviderConfigStore
  providerKeychainStore: IProviderKeychainStore
  tokenRefreshManager?: ITokenRefreshManager
}

export async function resolveProviderConfig(
  params: ResolveProviderConfigParams,
): Promise<ProviderConfigResponse> {
  const {authStateStore, providerConfigStore, providerKeychainStore, tokenRefreshManager} = params
  const config = await providerConfigStore.read()
  const {activeProvider} = config
  const activeModel = config.getActiveModel(activeProvider)
  const maxInputTokens = config.getActiveModelContextLength(activeProvider)

  if (activeProvider === 'byterover') {
    const authToken = authStateStore?.getToken()
    const loginRequired = authStateStore ? !authToken || !authToken.isValid() : undefined
    return {activeModel, activeProvider, loginRequired: loginRequired ? true : undefined, maxInputTokens}
  }

  if (!activeProvider) {
    return {activeModel, activeProvider, maxInputTokens}
  }

  // Resolve API key: keychain first, then environment variable
  let apiKey = await providerKeychainStore.getApiKey(activeProvider)
  if (!apiKey) {
    apiKey = getProviderApiKeyFromEnv(activeProvider)
  }

  switch (activeProvider) {
    case 'openai-compatible': {
      return {
        activeModel,
        activeProvider,
        maxInputTokens,
        provider: activeProvider,
        providerApiKey: apiKey || undefined,
        providerBaseUrl: config.getBaseUrl(activeProvider) || undefined,
        providerKeyMissing: providerRequiresApiKey(activeProvider) && !apiKey,
      }
    }

    case 'openrouter': {
      return {
        activeModel,
        activeProvider,
        maxInputTokens,
        openRouterApiKey: apiKey || undefined,
        provider: activeProvider,
        providerKeyMissing: providerRequiresApiKey(activeProvider) && !apiKey,
      }
    }

    case 'requesty': {
      const providerDef = getProviderById(activeProvider)
      const headers = providerDef?.headers
      return {
        activeModel,
        activeProvider,
        maxInputTokens,
        provider: activeProvider,
        providerApiKey: apiKey || undefined,
        providerBaseUrl: config.getBaseUrl(activeProvider) || providerDef?.baseUrl || undefined,
        providerHeaders: headers && Object.keys(headers).length > 0 ? {...headers} : undefined,
        providerKeyMissing: providerRequiresApiKey(activeProvider) && !apiKey,
      }
    }

    default: {
      const providerDef = getProviderById(activeProvider)
      const providerConfig = config.providers[activeProvider]
      if (!providerConfig) {
        return {activeModel, activeProvider, maxInputTokens}
      }

      const {authMethod} = providerConfig

      // Attempt OAuth token refresh if provider is OAuth-connected
      if (authMethod === 'oauth' && tokenRefreshManager) {
        try {
          const refreshed = await tokenRefreshManager.refreshIfNeeded(activeProvider)
          if (!refreshed) {
            return {activeModel, activeProvider, authMethod, maxInputTokens, providerKeyMissing: true}
          }

          // Re-read API key after potential refresh
          apiKey = (await providerKeychainStore.getApiKey(activeProvider)) ?? apiKey
        } catch {
          return {activeModel, activeProvider, authMethod, maxInputTokens, providerKeyMissing: true}
        }
      }

      // OAuth-connected OpenAI: use Codex endpoint + required headers
      if (activeProvider === 'openai' && authMethod === 'oauth') {
        const codexHeaders: Record<string, string> = {
          originator: CHATGPT_OAUTH_ORIGINATOR,
        }
        if (providerConfig.oauthAccountId) {
          codexHeaders['ChatGPT-Account-Id'] = providerConfig.oauthAccountId
        }

        return {
          activeModel,
          activeProvider,
          authMethod,
          maxInputTokens,
          provider: activeProvider,
          providerApiKey: apiKey || undefined,
          providerBaseUrl: CHATGPT_OAUTH_BASE_URL,
          providerHeaders: codexHeaders,
          providerKeyMissing: providerRequiresApiKey(activeProvider, authMethod) && !apiKey,
        }
      }

      const headers = providerDef?.headers
      return {
        activeModel,
        activeProvider,
        authMethod,
        maxInputTokens,
        provider: activeProvider,
        providerApiKey: apiKey || undefined,
        providerBaseUrl: config.getBaseUrl(activeProvider) || providerDef?.baseUrl || undefined,
        providerHeaders: headers && Object.keys(headers).length > 0 ? {...headers} : undefined,
        providerKeyMissing: providerRequiresApiKey(activeProvider, authMethod) && !apiKey,
      }
    }
  }
}
