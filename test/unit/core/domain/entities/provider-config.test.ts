import {expect} from 'chai'

import {ProviderConfig} from '../../../../../src/server/core/domain/entities/provider-config.js'

describe('ProviderConfig', () => {
  describe('withProviderConnected()', () => {
    it('should connect a provider with no options (backward compatible)', () => {
      const config = ProviderConfig.createDefault()
      const updated = config.withProviderConnected('openai')

      expect(updated.isProviderConnected('openai')).to.be.true
      expect(updated.providers.openai.authMethod).to.be.undefined
      expect(updated.providers.openai.oauthAccountId).to.be.undefined
      expect(updated.providers.openai.favoriteModels).to.deep.equal([])
      expect(updated.providers.openai.recentModels).to.deep.equal([])
    })

    it('should connect with explicit api-key authMethod', () => {
      const config = ProviderConfig.createDefault()
      const updated = config.withProviderConnected('openai', {authMethod: 'api-key'})

      expect(updated.providers.openai.authMethod).to.equal('api-key')
      expect(updated.providers.openai.oauthAccountId).to.be.undefined
    })

    it('should connect with oauth authMethod and oauthAccountId', () => {
      const config = ProviderConfig.createDefault()
      const updated = config.withProviderConnected('openai', {
        authMethod: 'oauth',
        oauthAccountId: 'acct_123',
      })

      expect(updated.providers.openai.authMethod).to.equal('oauth')
      expect(updated.providers.openai.oauthAccountId).to.equal('acct_123')
    })

    it('should connect with OAuth fields (tokens stored in encrypted store)', () => {
      const config = ProviderConfig.createDefault()
      const updated = config.withProviderConnected('openai', {
        authMethod: 'oauth',
        oauthAccountId: 'acct_123',
      })

      expect(updated.providers.openai.authMethod).to.equal('oauth')
      expect(updated.providers.openai.oauthAccountId).to.equal('acct_123')
    })

    it('should preserve existing fields when reconnecting with OAuth', () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openai', {
        activeModel: 'gpt-4.1',
        authMethod: 'api-key',
      })

      const reconnected = config.withProviderConnected('openai', {
        authMethod: 'oauth',
        oauthAccountId: 'acct_123',
      })

      expect(reconnected.providers.openai.activeModel).to.equal('gpt-4.1')
      expect(reconnected.providers.openai.authMethod).to.equal('oauth')
      expect(reconnected.providers.openai.oauthAccountId).to.equal('acct_123')
      expect(reconnected.providers.openai.favoriteModels).to.deep.equal([])
      expect(reconnected.providers.openai.recentModels).to.deep.equal([])
    })

    it('should set connectedAt timestamp on first connection', () => {
      const config = ProviderConfig.createDefault()
      const updated = config.withProviderConnected('openai', {authMethod: 'oauth'})

      expect(updated.providers.openai.connectedAt).to.be.a('string')
      expect(new Date(updated.providers.openai.connectedAt).getTime()).to.not.be.NaN
    })

    it('should preserve original connectedAt on reconnection', () => {
      const config = ProviderConfig.createDefault()
      const first = config.withProviderConnected('openai', {authMethod: 'api-key'})
      const originalConnectedAt = first.providers.openai.connectedAt

      const reconnected = first.withProviderConnected('openai', {authMethod: 'oauth'})

      expect(reconnected.providers.openai.connectedAt).to.equal(originalConnectedAt)
    })

    it('should not affect other connected providers', () => {
      const config = ProviderConfig.createDefault().withProviderConnected('anthropic', {authMethod: 'api-key'})

      const updated = config.withProviderConnected('openai', {
        authMethod: 'oauth',
        oauthAccountId: 'acct_123',
      })

      expect(updated.providers.anthropic.authMethod).to.equal('api-key')
      expect(updated.providers.anthropic.oauthAccountId).to.be.undefined
      expect(updated.providers.openai.authMethod).to.equal('oauth')
    })
  })

  describe('backward compatibility with fromJson()', () => {
    it('should handle legacy config without authMethod field', () => {
      const legacyJson = {
        activeProvider: 'openai',
        providers: {
          openai: {
            connectedAt: '2025-01-01T00:00:00.000Z',
            favoriteModels: [],
            recentModels: ['gpt-4.1'],
          },
        },
      }

      const config = ProviderConfig.fromJson(legacyJson)

      expect(config.isProviderConnected('openai')).to.be.true
      expect(config.providers.openai.authMethod).to.be.undefined
      expect(config.providers.openai.oauthAccountId).to.be.undefined
    })

    it('should deserialize config with OAuth fields', () => {
      const json = {
        activeProvider: 'openai',
        providers: {
          openai: {
            activeModel: 'gpt-5.1-codex',
            authMethod: 'oauth',
            connectedAt: '2026-03-15T00:00:00.000Z',
            favoriteModels: [],
            oauthAccountId: 'acct_123',
            recentModels: [],
          },
        },
      }

      const config = ProviderConfig.fromJson(json)

      expect(config.providers.openai.authMethod).to.equal('oauth')
      expect(config.providers.openai.oauthAccountId).to.equal('acct_123')
    })

    it('should roundtrip OAuth fields through toJson/fromJson', () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openai', {
        authMethod: 'oauth',
        oauthAccountId: 'acct_456',
      })

      const restored = ProviderConfig.fromJson(config.toJson())

      expect(restored.providers.openai.authMethod).to.equal('oauth')
      expect(restored.providers.openai.oauthAccountId).to.equal('acct_456')
    })
  })

  describe('withProviderDisconnected()', () => {
    it('should remove OAuth fields when disconnecting an OAuth provider', () => {
      const config = ProviderConfig.createDefault()
        .withProviderConnected('openai', {
          authMethod: 'oauth',
          oauthAccountId: 'acct_123',
        })
        .withActiveProvider('openai')

      const disconnected = config.withProviderDisconnected('openai')

      expect(disconnected.isProviderConnected('openai')).to.be.false
      expect(disconnected.providers.openai).to.be.undefined
    })

    it('should set activeProvider to empty string when disconnecting active provider', () => {
      const config = ProviderConfig.createDefault()
        .withProviderConnected('openrouter', {authMethod: 'api-key'})
        .withActiveProvider('openrouter')

      const disconnected = config.withProviderDisconnected('openrouter')

      expect(disconnected.activeProvider).to.equal('')
    })

    it('should keep activeProvider unchanged when disconnecting non-active provider', () => {
      const config = ProviderConfig.createDefault()
        .withProviderConnected('openrouter', {authMethod: 'api-key'})
        .withProviderConnected('anthropic', {authMethod: 'api-key'})
        .withActiveProvider('anthropic')

      const disconnected = config.withProviderDisconnected('openrouter')

      expect(disconnected.activeProvider).to.equal('anthropic')
    })

    it('should retain a tombstone with lastDisconnect when details are provided', () => {
      const config = ProviderConfig.createDefault()
        .withProviderConnected('openai', {authMethod: 'oauth', oauthAccountId: 'acct_123'})
        .withActiveProvider('openai')

      const disconnected = config.withProviderDisconnected('openai', {
        errorCode: 'invalid_grant',
        reason: 'OAuth token refresh failed',
        statusCode: 400,
      })

      // Entry is kept (exists in config) but reports as not connected
      expect(disconnected.providers.openai).to.not.be.undefined
      expect(disconnected.isProviderConnected('openai')).to.be.false
      expect(disconnected.activeProvider).to.equal('')

      const {lastDisconnect} = disconnected.providers.openai
      expect(lastDisconnect?.reason).to.equal('OAuth token refresh failed')
      expect(lastDisconnect?.errorCode).to.equal('invalid_grant')
      expect(lastDisconnect?.statusCode).to.equal(400)
      expect(lastDisconnect?.at).to.be.a('string')
      expect(Number.isNaN(Date.parse(lastDisconnect!.at))).to.be.false

      // Last-known authMethod is preserved so the view can build the reconnect hint
      expect(disconnected.providers.openai.authMethod).to.equal('oauth')
    })

    it('should record lastDisconnect without optional error/status fields', () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openrouter', {authMethod: 'api-key'})

      const disconnected = config.withProviderDisconnected('openrouter', {reason: 'Manual disconnect'})

      const {lastDisconnect} = disconnected.providers.openrouter
      expect(lastDisconnect?.reason).to.equal('Manual disconnect')
      expect(lastDisconnect?.errorCode).to.be.undefined
      expect(lastDisconnect?.statusCode).to.be.undefined
    })

    it('should remove the entry entirely when details are omitted even if it existed', () => {
      const config = ProviderConfig.createDefault().withProviderConnected('openai', {authMethod: 'oauth'})

      const disconnected = config.withProviderDisconnected('openai')

      expect(disconnected.providers.openai).to.be.undefined
      expect(disconnected.isProviderConnected('openai')).to.be.false
    })

    it('should not create a tombstone for a provider that was never connected', () => {
      const config = ProviderConfig.createDefault()

      const disconnected = config.withProviderDisconnected('openai', {reason: 'OAuth token refresh failed'})

      expect(disconnected.providers.openai).to.be.undefined
    })

    it('should clear lastDisconnect when the provider is reconnected', () => {
      const disconnected = ProviderConfig.createDefault()
        .withProviderConnected('openai', {authMethod: 'oauth'})
        .withProviderDisconnected('openai', {errorCode: 'invalid_grant', reason: 'OAuth token refresh failed'})

      expect(disconnected.isProviderConnected('openai')).to.be.false

      const reconnected = disconnected.withProviderConnected('openai', {authMethod: 'oauth'})

      expect(reconnected.isProviderConnected('openai')).to.be.true
      expect(reconnected.providers.openai.lastDisconnect).to.be.undefined
    })

    it('should round-trip lastDisconnect through toJson/fromJson', () => {
      const disconnected = ProviderConfig.createDefault()
        .withProviderConnected('openai', {authMethod: 'oauth'})
        .withProviderDisconnected('openai', {
          errorCode: 'invalid_grant',
          reason: 'OAuth token refresh failed',
          statusCode: 400,
        })

      const restored = ProviderConfig.fromJson(disconnected.toJson())

      expect(restored.isProviderConnected('openai')).to.be.false
      expect(restored.providers.openai.lastDisconnect?.reason).to.equal('OAuth token refresh failed')
      expect(restored.providers.openai.lastDisconnect?.errorCode).to.equal('invalid_grant')
      expect(restored.providers.openai.lastDisconnect?.statusCode).to.equal(400)
    })
  })
})
