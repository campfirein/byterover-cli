import type {IProviderConfigStore} from '../../core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../core/interfaces/i-provider-keychain-store.js'
import type {IProviderOAuthTokenStore} from '../../core/interfaces/i-provider-oauth-token-store.js'
import type {ITokenRefreshManager} from '../../core/interfaces/i-token-refresh-manager.js'
import type {ITransportServer} from '../../core/interfaces/transport/i-transport-server.js'
import type {ProviderTokenResponse, RefreshTokenExchangeParams, TokenRequestContentType} from './types.js'

import {getProviderById} from '../../core/domain/entities/provider-registry.js'
import {TransportDaemonEventNames} from '../../core/domain/transport/schemas.js'
import {processLog} from '../../utils/process-logger.js'
import {isPermanentOAuthError, ProviderTokenExchangeError} from './errors.js'
import {exchangeRefreshToken as defaultExchangeRefreshToken} from './refresh-token-exchange.js'
import {computeExpiresAt} from './types.js'

export {type ITokenRefreshManager} from '../../core/interfaces/i-token-refresh-manager.js'

/** Refresh tokens when they expire within this threshold */
export const REFRESH_THRESHOLD_MS = 5 * 60 * 1000

export interface TokenRefreshManagerDeps {
  exchangeRefreshToken?: (params: RefreshTokenExchangeParams) => Promise<ProviderTokenResponse>
  providerConfigStore: IProviderConfigStore
  providerKeychainStore: IProviderKeychainStore
  providerOAuthTokenStore: IProviderOAuthTokenStore
  transport: ITransportServer
}

/**
 * Manages automatic OAuth token refresh for providers.
 *
 * Called by resolveProviderConfig() before returning config to agents.
 * If a token is expiring within 5 minutes, exchanges the refresh token
 * for a new access token. On failure, disconnects the provider.
 */
export class TokenRefreshManager implements ITokenRefreshManager {
  private readonly deps: TokenRefreshManagerDeps
  private readonly exchangeRefreshToken: (params: RefreshTokenExchangeParams) => Promise<ProviderTokenResponse>
  /** Per-provider mutex to serialize concurrent refresh attempts */
  private readonly pendingRefreshes = new Map<string, Promise<boolean>>()

  constructor(deps: TokenRefreshManagerDeps) {
    this.deps = deps
    this.exchangeRefreshToken = deps.exchangeRefreshToken ?? defaultExchangeRefreshToken
  }

  async refreshIfNeeded(providerId: string): Promise<boolean> {
    // Serialize concurrent refreshes for the same provider
    const pending = this.pendingRefreshes.get(providerId)
    if (pending) {
      return pending
    }

    const promise = this.doRefresh(providerId).finally(() => {
      this.pendingRefreshes.delete(providerId)
    })

    this.pendingRefreshes.set(providerId, promise)
    return promise
  }

  private async doRefresh(providerId: string): Promise<boolean> {
    // 1. Check if provider is OAuth-connected
    const config = await this.deps.providerConfigStore.read()
    const providerConfig = config.providers[providerId]
    if (providerConfig?.authMethod !== 'oauth') {
      return true
    }

    // 2. Get token record from encrypted store
    const tokenRecord = await this.deps.providerOAuthTokenStore.get(providerId)
    if (!tokenRecord) {
      return false
    }

    // 3. Check if refresh is needed
    const expiresAt = new Date(tokenRecord.expiresAt).getTime()
    const timeUntilExpiry = expiresAt - Date.now()
    if (timeUntilExpiry > REFRESH_THRESHOLD_MS) {
      return true
    }

    // 4. Look up provider OAuth config
    const providerDef = getProviderById(providerId)
    if (!providerDef?.oauth) {
      return false
    }

    const oauthConfig = providerDef.oauth
    const contentType: TokenRequestContentType =
      oauthConfig.tokenContentType === 'form' ? 'application/x-www-form-urlencoded' : 'application/json'

    // 5. Attempt refresh
    try {
      const tokens = await this.exchangeRefreshToken({
        clientId: oauthConfig.clientId,
        contentType,
        refreshToken: tokenRecord.refreshToken,
        tokenUrl: oauthConfig.tokenUrl,
      })

      // 6. Success: update keychain + encrypted store
      await this.deps.providerKeychainStore.setApiKey(providerId, tokens.access_token)

      const newExpiresAt = tokens.expires_in ? computeExpiresAt(tokens.expires_in) : tokenRecord.expiresAt

      await this.deps.providerOAuthTokenStore.set(providerId, {
        expiresAt: newExpiresAt,
        refreshToken: tokens.refresh_token ?? tokenRecord.refreshToken,
      })

      this.deps.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})
      return true
    } catch (error) {
      // 7. Permanent failure (token revoked, client invalid): disconnect provider, clean up.
      // Record the reason durably (lastDisconnect tombstone) and log symmetrically
      // with the transient branch so the disconnect leaves a visible trace instead
      // of silently dropping the provider.
      if (isPermanentOAuthError(error)) {
        const statusCode = error instanceof ProviderTokenExchangeError ? error.statusCode : undefined
        const errorCode = error instanceof ProviderTokenExchangeError ? error.errorCode : undefined
        const detail = [statusCode ? `status ${statusCode}` : undefined, errorCode].filter(Boolean).join(', ')

        processLog(
          `[TokenRefreshManager] Permanent refresh failure for ${providerId}${
            detail ? ` (${detail})` : ''
          }: disconnecting provider`,
        )

        await this.deps.providerConfigStore
          .disconnectProvider(providerId, {errorCode, reason: 'OAuth token refresh failed', statusCode})
          .catch(() => {})
        await this.deps.providerOAuthTokenStore.delete(providerId).catch(() => {})
        await this.deps.providerKeychainStore.deleteApiKey(providerId).catch(() => {})
        this.deps.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})
        return false
      }

      // Transient errors (network timeout, 5xx): keep credentials intact.
      // Return true so the caller uses the existing access token from the keychain,
      // which may still be valid until it actually expires.
      processLog(
        `[TokenRefreshManager] Transient refresh error for ${providerId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return true
    }
  }
}
