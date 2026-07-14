/* eslint-disable camelcase -- OAuth token fields use snake_case per RFC 6749 */
import {expect} from 'chai'
import sinon, {restore, stub} from 'sinon'

import type {
  ProviderTokenResponse,
  RefreshTokenExchangeParams,
} from '../../../../src/server/infra/provider-oauth/types.js'

import {ProviderConfig} from '../../../../src/server/core/domain/entities/provider-config.js'
import {TransportDaemonEventNames} from '../../../../src/server/core/domain/transport/schemas.js'
import {ProviderTokenExchangeError} from '../../../../src/server/infra/provider-oauth/errors.js'
import {
  REFRESH_THRESHOLD_MS,
  TokenRefreshManager,
} from '../../../../src/server/infra/provider-oauth/token-refresh-manager.js'
import {
  createMockProviderConfigStore,
  createMockProviderKeychainStore,
  createMockProviderOAuthTokenStore,
  createMockTransportServer,
} from '../../../helpers/mock-factories.js'

// Helper to create a provider config with OAuth
function oauthConfig(providerId: string): ProviderConfig {
  return ProviderConfig.createDefault().withProviderConnected(providerId, {
    authMethod: 'oauth',
    oauthAccountId: 'acct_123',
  })
}

describe('TokenRefreshManager', () => {
  let providerConfigStore: ReturnType<typeof createMockProviderConfigStore>
  let providerKeychainStore: ReturnType<typeof createMockProviderKeychainStore>
  let providerOAuthTokenStore: ReturnType<typeof createMockProviderOAuthTokenStore>
  let transport: ReturnType<typeof createMockTransportServer>
  let exchangeStub: sinon.SinonStub<[RefreshTokenExchangeParams], Promise<ProviderTokenResponse>>

  beforeEach(() => {
    providerConfigStore = createMockProviderConfigStore()
    providerKeychainStore = createMockProviderKeychainStore()
    providerOAuthTokenStore = createMockProviderOAuthTokenStore()
    transport = createMockTransportServer()
    exchangeStub = stub<[RefreshTokenExchangeParams], Promise<ProviderTokenResponse>>()
  })

  afterEach(() => {
    restore()
  })

  function createManager(): TokenRefreshManager {
    return new TokenRefreshManager({
      exchangeRefreshToken: exchangeStub,
      providerConfigStore,
      providerKeychainStore,
      providerOAuthTokenStore,
      transport,
    })
  }

  describe('refreshIfNeeded', () => {
    it('should return true for non-OAuth provider (no refresh needed)', async () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openai', {
        authMethod: 'api-key',
      })
      providerConfigStore.read.resolves(config)

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      expect(result).to.be.true
      expect(exchangeStub.notCalled).to.be.true
    })

    it('should return true for non-connected provider', async () => {
      providerConfigStore.read.resolves(ProviderConfig.createDefault())

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      expect(result).to.be.true
      expect(exchangeStub.notCalled).to.be.true
    })

    it('should return true when token is not expiring (> 5 min)', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + REFRESH_THRESHOLD_MS + 60_000).toISOString(),
        refreshToken: 'rt_valid',
      })

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      expect(result).to.be.true
      expect(exchangeStub.notCalled).to.be.true
    })

    it('should refresh when token expires within 5 minutes', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(), // 1 min from now
        refreshToken: 'rt_expiring',
      })
      exchangeStub.resolves({
        access_token: 'at_new',
        expires_in: 3600,
        refresh_token: 'rt_new',
      })

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      expect(result).to.be.true
      expect(exchangeStub.calledOnce).to.be.true

      // Verify keychain updated
      expect(providerKeychainStore.setApiKey.calledWith('openai', 'at_new')).to.be.true

      // Verify token store updated
      expect(providerOAuthTokenStore.set.calledOnce).to.be.true
      const [id, record] = providerOAuthTokenStore.set.firstCall.args
      expect(id).to.equal('openai')
      expect(record.refreshToken).to.equal('rt_new')
      expect(record.expiresAt).to.be.a('string')

      // Verify broadcast
      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true
    })

    it('should refresh when token is already expired', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() - 60_000).toISOString(), // 1 min ago
        refreshToken: 'rt_expired',
      })
      exchangeStub.resolves({
        access_token: 'at_renewed',
        expires_in: 3600,
        refresh_token: 'rt_renewed',
      })

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      expect(result).to.be.true
      expect(exchangeStub.calledOnce).to.be.true
    })

    it('should keep old refresh token when provider does not return a new one', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_original',
      })
      exchangeStub.resolves({
        access_token: 'at_new',
        expires_in: 3600,
        // No refresh_token in response
      })

      const manager = createManager()
      await manager.refreshIfNeeded('openai')

      const [, record] = providerOAuthTokenStore.set.firstCall.args
      expect(record.refreshToken).to.equal('rt_original')
    })

    it('should disconnect provider on permanent refresh failure (invalid_grant)', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_revoked',
      })
      exchangeStub.rejects(
        new ProviderTokenExchangeError({errorCode: 'invalid_grant', message: 'Token revoked', statusCode: 400}),
      )

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      expect(result).to.be.false

      // Verify full cleanup on permanent error
      expect(providerConfigStore.disconnectProvider.calledWith('openai')).to.be.true
      expect(providerOAuthTokenStore.delete.calledWith('openai')).to.be.true
      expect(providerKeychainStore.deleteApiKey.calledWith('openai')).to.be.true
      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true

      // Verify the disconnect reason/details were plumbed through so the drop is
      // recorded durably (lastDisconnect) instead of vanishing silently.
      const [disconnectedId, disconnectDetails] = providerConfigStore.disconnectProvider.firstCall.args
      expect(disconnectedId).to.equal('openai')
      expect(disconnectDetails).to.include({errorCode: 'invalid_grant', statusCode: 400})
      expect(disconnectDetails?.reason).to.equal('OAuth token refresh failed')
    })

    it('should return true and keep credentials intact on transient refresh failure', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_valid',
      })
      exchangeStub.rejects(new Error('Network timeout'))

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      // Transient errors return true so the caller uses the existing access token
      expect(result).to.be.true

      // Verify credentials NOT cleaned up on transient error
      expect(providerConfigStore.disconnectProvider.notCalled).to.be.true
      expect(providerOAuthTokenStore.delete.notCalled).to.be.true
      expect(providerKeychainStore.deleteApiKey.notCalled).to.be.true
      expect(transport.broadcast.notCalled).to.be.true
    })

    it('should return false when no token record and no legacy tokens', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves()

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      expect(result).to.be.false
    })

    it('should serialize concurrent refresh calls for the same provider', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_test',
      })

      // Make exchange resolve after a small delay
      exchangeStub.callsFake(
        () =>
          new Promise((resolve) => {
            setTimeout(
              () =>
                resolve({
                  access_token: 'at_new',
                  expires_in: 3600,
                  refresh_token: 'rt_new',
                }),
              10,
            )
          }),
      )

      const manager = createManager()

      // Fire two concurrent refreshes
      const [r1, r2] = await Promise.all([manager.refreshIfNeeded('openai'), manager.refreshIfNeeded('openai')])

      expect(r1).to.be.true
      expect(r2).to.be.true
      // Exchange should only be called once (second call reuses pending promise)
      expect(exchangeStub.callCount).to.equal(1)
    })

    it('should pass correct params to exchange function', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_test',
      })
      exchangeStub.resolves({
        access_token: 'at_new',
        expires_in: 3600,
      })

      const manager = createManager()
      await manager.refreshIfNeeded('openai')

      const params = exchangeStub.firstCall.args[0]
      expect(params.clientId).to.equal('app_EMoamEEZ73f0CkXaXp7hrann')
      expect(params.contentType).to.equal('application/x-www-form-urlencoded')
      expect(params.refreshToken).to.equal('rt_test')
      expect(params.tokenUrl).to.equal('https://auth.openai.com/oauth/token')
    })
  })

  describe('error handling edge cases', () => {
    it('should treat 400 without permanent error code as transient (keep credentials, return true)', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_valid',
      })
      exchangeStub.rejects(
        new ProviderTokenExchangeError({errorCode: 'temporarily_unavailable', message: 'Try later', statusCode: 400}),
      )

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      // Transient error: return true so caller uses existing access token
      expect(result).to.be.true
      // Credentials should NOT be cleaned up — 400 with non-permanent error code is transient
      expect(providerConfigStore.disconnectProvider.notCalled).to.be.true
      expect(providerOAuthTokenStore.delete.notCalled).to.be.true
      expect(providerKeychainStore.deleteApiKey.notCalled).to.be.true
    })

    it('should complete best-effort cleanup even if individual steps fail', async () => {
      providerConfigStore.read.resolves(oauthConfig('openai'))
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_revoked',
      })
      exchangeStub.rejects(
        new ProviderTokenExchangeError({errorCode: 'invalid_grant', message: 'Token revoked', statusCode: 401}),
      )
      providerOAuthTokenStore.delete.rejects(new Error('Disk full'))

      const manager = createManager()
      const result = await manager.refreshIfNeeded('openai')

      // Should return false (not throw) despite cleanup failure
      expect(result).to.be.false

      // All cleanup steps should have been attempted
      expect(providerConfigStore.disconnectProvider.calledWith('openai')).to.be.true
      expect(providerOAuthTokenStore.delete.calledWith('openai')).to.be.true
      expect(providerKeychainStore.deleteApiKey.calledWith('openai')).to.be.true
      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true

      // Reason/details still plumbed through even when a later cleanup step fails.
      const disconnectDetails = providerConfigStore.disconnectProvider.firstCall.args[1]
      expect(disconnectDetails).to.include({errorCode: 'invalid_grant', statusCode: 401})
      expect(disconnectDetails?.reason).to.equal('OAuth token refresh failed')
    })
  })

  describe('edge cases', () => {
    it('should return false when provider has no OAuth definition in registry', async () => {
      // Create config with a fake provider that has authMethod: 'oauth' but no registry entry
      const config = ProviderConfig.createDefault().withProviderConnected('unknown-provider', {
        authMethod: 'oauth',
      })
      providerConfigStore.read.resolves(config)
      providerOAuthTokenStore.get.resolves({
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'rt_test',
      })

      const manager = createManager()
      const result = await manager.refreshIfNeeded('unknown-provider')

      expect(result).to.be.false
      expect(exchangeStub.notCalled).to.be.true
    })
  })
})
