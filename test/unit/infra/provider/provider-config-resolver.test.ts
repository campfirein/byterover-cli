import {expect} from 'chai'
import sinon, {createSandbox, type SinonSandbox, type SinonStubbedInstance} from 'sinon'

import type {IProviderConfigStore} from '../../../../src/server/core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../../../src/server/core/interfaces/i-provider-keychain-store.js'
import type {IProviderOAuthTokenStore} from '../../../../src/server/core/interfaces/i-provider-oauth-token-store.js'
import type {ITokenRefreshManager} from '../../../../src/server/infra/provider-oauth/token-refresh-manager.js'

import {ProviderConfig} from '../../../../src/server/core/domain/entities/provider-config.js'
import {
  clearStaleProviderConfig,
  resolveProviderConfig,
} from '../../../../src/server/infra/provider/provider-config-resolver.js'
import {createMockAuthStateStore} from '../../../helpers/mock-factories.js'

// ==================== Helpers ====================

function createStubStores(sandbox: SinonSandbox) {
  const configStore: SinonStubbedInstance<IProviderConfigStore> = {
    connectProvider: sandbox.stub().resolves(),
    disconnectProvider: sandbox.stub().resolves(),
    getActiveModel: sandbox.stub().resolves(),
    getActiveProvider: sandbox.stub().resolves('byterover'),
    getFavoriteModels: sandbox.stub().resolves([]),
    getRecentModels: sandbox.stub().resolves([]),
    isProviderConnected: sandbox.stub().resolves(false),
    read: sandbox.stub(),
    setActiveModel: sandbox.stub().resolves(),
    setActiveProvider: sandbox.stub().resolves(),
    toggleFavorite: sandbox.stub().resolves(),
    write: sandbox.stub().resolves(),
  } as unknown as SinonStubbedInstance<IProviderConfigStore>

  const keychainStore: SinonStubbedInstance<IProviderKeychainStore> = {
    deleteApiKey: sandbox.stub().resolves(),
    getApiKey: sandbox.stub().resolves(),
    hasApiKey: sandbox.stub().resolves(false),
    setApiKey: sandbox.stub().resolves(),
  } as unknown as SinonStubbedInstance<IProviderKeychainStore>

  return {configStore, keychainStore}
}

function createProviderConfig(
  activeProvider: string,
  providers: Record<
    string,
    {
      activeModel?: string
      authMethod?: 'api-key' | 'oauth'
      baseUrl?: string
      oauthAccountId?: string
    }
  > = {},
): ProviderConfig {
  const providerEntries: Record<
    string,
    {
      activeModel?: string
      authMethod?: 'api-key' | 'oauth'
      baseUrl?: string
      connectedAt: string
      favoriteModels: string[]
      oauthAccountId?: string
      recentModels: string[]
    }
  > = {}
  for (const [id, opts] of Object.entries(providers)) {
    providerEntries[id] = {
      ...opts,
      connectedAt: new Date().toISOString(),
      favoriteModels: [],
      recentModels: [],
    }
  }

  return ProviderConfig.fromJson({activeProvider, providers: providerEntries})
}

// ==================== Tests ====================

describe('provider-config-resolver', () => {
  let sandbox: SinonSandbox

  beforeEach(() => {
    sandbox = createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('resolveProviderConfig', () => {
    it('should return minimal config for byterover provider', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig('byterover'))

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('byterover')
      expect(result.providerApiKey).to.be.undefined
      expect(result.providerBaseUrl).to.be.undefined
      // Should not attempt to read API key for byterover
      expect(keychainStore.getApiKey.called).to.be.false
    })

    it('should resolve API key from keychain for openrouter', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig('openrouter', {openrouter: {activeModel: 'gpt-4o'}}))
      keychainStore.getApiKey.resolves('sk-or-key-123')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('openrouter')
      expect(result.activeModel).to.equal('gpt-4o')
      expect(result.openRouterApiKey).to.equal('sk-or-key-123')
      expect(result.provider).to.equal('openrouter')
    })

    it('should resolve openai-compatible provider with base URL', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai-compatible', {
          'openai-compatible': {activeModel: 'local-model', baseUrl: 'http://localhost:8080'},
        }),
      )
      keychainStore.getApiKey.resolves('test-key')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('openai-compatible')
      expect(result.provider).to.equal('openai-compatible')
      expect(result.providerApiKey).to.equal('test-key')
      expect(result.providerBaseUrl).to.equal('http://localhost:8080')
      expect(result.providerKeyMissing).to.be.false
    })

    it('should NOT set providerKeyMissing for openai-compatible without API key (Ollama use case)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai-compatible', {
          'openai-compatible': {activeModel: 'qwen3.5:9b', baseUrl: 'http://localhost:11434/v1'},
        }),
      )
      keychainStore.getApiKey.resolves()

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('openai-compatible')
      expect(result.providerKeyMissing).to.be.false
      expect(result.providerBaseUrl).to.equal('http://localhost:11434/v1')
    })

    it('should resolve direct provider (anthropic) with API key and registry info', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('anthropic', {
          anthropic: {activeModel: 'claude-sonnet-4-20250514'},
        }),
      )
      keychainStore.getApiKey.resolves('sk-ant-key')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('anthropic')
      expect(result.provider).to.equal('anthropic')
      expect(result.providerApiKey).to.equal('sk-ant-key')
      expect(result.activeModel).to.equal('claude-sonnet-4-20250514')
    })

    it('should resolve OAuth-connected OpenAI with Codex URL and ChatGPT-Account-Id header', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {
            activeModel: 'gpt-4.1',
            authMethod: 'oauth',
            oauthAccountId: 'org-abc123',
          },
        }),
      )
      keychainStore.getApiKey.resolves('oauth-access-token-xyz')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('openai')
      expect(result.provider).to.equal('openai')
      expect(result.providerApiKey).to.equal('oauth-access-token-xyz')
      expect(result.providerBaseUrl).to.equal('https://chatgpt.com/backend-api/codex')
      expect(result.providerHeaders).to.deep.equal({'ChatGPT-Account-Id': 'org-abc123', originator: 'byterover'})
      expect(result.providerKeyMissing).to.be.false
    })

    it('should resolve OAuth-connected OpenAI without account ID (originator header only)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {
            activeModel: 'gpt-4.1',
            authMethod: 'oauth',
          },
        }),
      )
      keychainStore.getApiKey.resolves('oauth-access-token-xyz')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.providerBaseUrl).to.equal('https://chatgpt.com/backend-api/codex')
      expect(result.providerHeaders).to.deep.equal({originator: 'byterover'})
      expect(result.providerKeyMissing).to.be.false
    })

    it('should resolve API-key-connected OpenAI with standard base URL (not Codex)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-4.1', authMethod: 'api-key'},
        }),
      )
      keychainStore.getApiKey.resolves('sk-openai-key')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('openai')
      expect(result.providerApiKey).to.equal('sk-openai-key')
      expect(result.providerBaseUrl).to.equal('https://api.openai.com/v1')
      expect(result.providerHeaders).to.be.undefined
      expect(result.providerKeyMissing).to.be.false
    })

    it('should set providerKeyMissing for API-key OpenAI without key', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-4.1', authMethod: 'api-key'},
        }),
      )
      keychainStore.getApiKey.resolves()

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.providerKeyMissing).to.be.true
    })

    it('should use config baseUrl for non-OAuth provider when set', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('anthropic', {
          anthropic: {activeModel: 'claude-sonnet-4-20250514', baseUrl: 'https://custom-proxy.example.com'},
        }),
      )
      keychainStore.getApiKey.resolves('sk-ant-key')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.providerBaseUrl).to.equal('https://custom-proxy.example.com')
    })

    it('should resolve legacy OpenAI config without authMethod field (backward compat)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-4.1'},
        }),
      )
      keychainStore.getApiKey.resolves('sk-openai-key')

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeProvider).to.equal('openai')
      expect(result.providerApiKey).to.equal('sk-openai-key')
      expect(result.providerBaseUrl).to.equal('https://api.openai.com/v1')
      expect(result.providerHeaders).to.be.undefined
      expect(result.providerKeyMissing).to.be.false
    })

    it('should return providerKeyMissing false for OAuth OpenAI even when token is absent (race window)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {
            activeModel: 'gpt-4.1',
            authMethod: 'oauth',
            oauthAccountId: 'org-abc123',
          },
        }),
      )
      keychainStore.getApiKey.resolves()

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.providerApiKey).to.be.undefined
      expect(result.providerKeyMissing).to.be.false
      expect(result.providerBaseUrl).to.equal('https://chatgpt.com/backend-api/codex')
    })

    it('should return undefined model when provider has no active model', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig('byterover'))

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.activeModel).to.be.undefined
    })

    // ==================== Token Refresh Manager Integration ====================

    it('should call tokenRefreshManager for OAuth providers when provided', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-5.1-codex', authMethod: 'oauth', oauthAccountId: 'org-abc'},
        }),
      )
      keychainStore.getApiKey.resolves('refreshed-access-token')

      const refreshManager: ITokenRefreshManager = {
        refreshIfNeeded: sandbox.stub().resolves(true),
      }

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore, tokenRefreshManager: refreshManager})

      expect((refreshManager.refreshIfNeeded as sinon.SinonStub).calledWith('openai')).to.be.true
      expect(result.providerApiKey).to.equal('refreshed-access-token')
      expect(result.providerKeyMissing).to.be.false
    })

    it('should return providerKeyMissing when tokenRefreshManager returns false', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-5.1-codex', authMethod: 'oauth', oauthAccountId: 'org-abc'},
        }),
      )

      const refreshManager: ITokenRefreshManager = {
        refreshIfNeeded: sandbox.stub().resolves(false),
      }

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore, tokenRefreshManager: refreshManager})

      expect(result.providerKeyMissing).to.be.true
      expect(result.providerApiKey).to.be.undefined
    })

    it('should re-read API key from keychain after successful refresh', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-5.1-codex', authMethod: 'oauth', oauthAccountId: 'org-abc'},
        }),
      )
      // First call returns old token, second call (after refresh) returns new token
      keychainStore.getApiKey.onFirstCall().resolves('old-access-token')
      keychainStore.getApiKey.onSecondCall().resolves('fresh-access-token')

      const refreshManager: ITokenRefreshManager = {
        refreshIfNeeded: sandbox.stub().resolves(true),
      }

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore, tokenRefreshManager: refreshManager})

      // getApiKey must be called twice: once before refresh check, once after
      expect(keychainStore.getApiKey.callCount).to.equal(2)
      // Result should use the fresh token from second read
      expect(result.providerApiKey).to.equal('fresh-access-token')
    })

    it('should not call tokenRefreshManager for non-OAuth providers', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-4.1', authMethod: 'api-key'},
        }),
      )
      keychainStore.getApiKey.resolves('sk-key')

      const refreshManager: ITokenRefreshManager = {
        refreshIfNeeded: sandbox.stub().resolves(true),
      }

      await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore, tokenRefreshManager: refreshManager})

      expect((refreshManager.refreshIfNeeded as sinon.SinonStub).notCalled).to.be.true
    })

    it('should work without tokenRefreshManager (backward compatible)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-5.1-codex', authMethod: 'oauth', oauthAccountId: 'org-abc'},
        }),
      )
      keychainStore.getApiKey.resolves('access-token')

      // No tokenRefreshManager — should still resolve normally
      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.providerApiKey).to.equal('access-token')
      expect(result.providerBaseUrl).to.equal('https://chatgpt.com/backend-api/codex')
    })

    it('should return providerKeyMissing when tokenRefreshManager throws', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-5.1-codex', authMethod: 'oauth', oauthAccountId: 'org-abc'},
        }),
      )

      const refreshManager: ITokenRefreshManager = {
        refreshIfNeeded: sandbox.stub().rejects(new Error('Unexpected error')),
      }

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore, tokenRefreshManager: refreshManager})

      // Should degrade gracefully instead of throwing
      expect(result.providerKeyMissing).to.be.true
      expect(result.providerApiKey).to.be.undefined
    })
  })

  // ==================== loginRequired field ====================

  describe('loginRequired field', () => {
    it('should set loginRequired true for byterover when unauthenticated', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig('byterover'))

      const result = await resolveProviderConfig({authStateStore: createMockAuthStateStore(sandbox, {isAuthenticated: false}), providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.loginRequired).to.be.true
    })

    it('should not set loginRequired for byterover when authenticated', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig('byterover'))

      const result = await resolveProviderConfig({authStateStore: createMockAuthStateStore(sandbox, {isAuthenticated: true}), providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.loginRequired).to.be.undefined
    })

    it('should not set loginRequired for non-byterover providers', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig('openrouter', {openrouter: {activeModel: 'gpt-4o'}}))
      keychainStore.getApiKey.resolves('sk-key')

      const result = await resolveProviderConfig({authStateStore: createMockAuthStateStore(sandbox, {isAuthenticated: false}), providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.loginRequired).to.be.undefined
    })

    it('should not set loginRequired when activeProvider is empty string (post-disconnect)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig(''))

      const result = await resolveProviderConfig({authStateStore: createMockAuthStateStore(sandbox, {isAuthenticated: false}), providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.loginRequired).to.be.undefined
      expect(result.activeProvider).to.equal('')
    })

    it('should not set loginRequired when authStateStore is not provided (backward compat)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(createProviderConfig('byterover'))

      const result = await resolveProviderConfig({providerConfigStore: configStore, providerKeychainStore: keychainStore})

      expect(result.loginRequired).to.be.undefined
    })
  })

  describe('clearStaleProviderConfig', () => {
    it('should delete OAuth tokens for stale providers', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-5.1-codex', authMethod: 'oauth', oauthAccountId: 'org-abc'},
        }),
      )
      // Keychain returns nothing → provider is stale
      keychainStore.getApiKey.resolves()

      const oauthTokenStore: SinonStubbedInstance<IProviderOAuthTokenStore> = {
        delete: sandbox.stub().resolves(),
        get: sandbox.stub().resolves(),
        has: sandbox.stub().resolves(false),
        set: sandbox.stub().resolves(),
      } as unknown as SinonStubbedInstance<IProviderOAuthTokenStore>

      await clearStaleProviderConfig(configStore, keychainStore, oauthTokenStore)

      expect(oauthTokenStore.delete.calledWith('openai')).to.be.true
      expect(configStore.write.calledOnce).to.be.true
    })

    it('should not call oauthTokenStore when no providers are stale', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-4.1', authMethod: 'api-key'},
        }),
      )
      keychainStore.getApiKey.resolves('sk-key')

      const oauthTokenStore: SinonStubbedInstance<IProviderOAuthTokenStore> = {
        delete: sandbox.stub().resolves(),
        get: sandbox.stub().resolves(),
        has: sandbox.stub().resolves(false),
        set: sandbox.stub().resolves(),
      } as unknown as SinonStubbedInstance<IProviderOAuthTokenStore>

      await clearStaleProviderConfig(configStore, keychainStore, oauthTokenStore)

      expect(oauthTokenStore.delete.notCalled).to.be.true
      expect(configStore.write.notCalled).to.be.true
    })

    it('should work without oauthTokenStore (backward compatible)', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      configStore.read.resolves(
        createProviderConfig('openai', {
          openai: {activeModel: 'gpt-5.1-codex', authMethod: 'oauth'},
        }),
      )
      keychainStore.getApiKey.resolves()

      // No oauthTokenStore — should not throw
      await clearStaleProviderConfig(configStore, keychainStore)

      expect(configStore.write.calledOnce).to.be.true
    })

    it('should preserve an already-tombstoned provider instead of re-disconnecting it', async () => {
      const {configStore, keychainStore} = createStubStores(sandbox)
      // A provider that was disconnected with a recorded reason: its keychain key
      // is intentionally gone, so it would otherwise look "stale" and be removed.
      const tombstoned = ProviderConfig.createDefault()
        .withProviderConnected('openai', {authMethod: 'oauth'})
        .withProviderDisconnected('openai', {
          errorCode: 'invalid_grant',
          reason: 'OAuth token refresh failed',
          statusCode: 400,
        })
      configStore.read.resolves(tombstoned)
      keychainStore.getApiKey.resolves()

      const oauthTokenStore: SinonStubbedInstance<IProviderOAuthTokenStore> = {
        delete: sandbox.stub().resolves(),
        get: sandbox.stub().resolves(),
        has: sandbox.stub().resolves(false),
        set: sandbox.stub().resolves(),
      } as unknown as SinonStubbedInstance<IProviderOAuthTokenStore>

      await clearStaleProviderConfig(configStore, keychainStore, oauthTokenStore)

      // Tombstone left untouched: no re-write, no re-delete — the reason survives
      expect(configStore.write.notCalled).to.be.true
      expect(oauthTokenStore.delete.notCalled).to.be.true
    })
  })
})
