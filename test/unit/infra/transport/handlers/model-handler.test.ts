import {expect} from 'chai'
import {restore, type SinonStub, stub} from 'sinon'

import type {IProviderModelFetcher} from '../../../../../src/server/core/interfaces/i-provider-model-fetcher.js'

import {ProviderConfig} from '../../../../../src/server/core/domain/entities/provider-config.js'
import {TransportDaemonEventNames} from '../../../../../src/server/core/domain/transport/schemas.js'
import {ModelHandler} from '../../../../../src/server/infra/transport/handlers/model-handler.js'
import {ModelEvents} from '../../../../../src/shared/transport/events/model-events.js'
import {
  createMockProviderConfigStore,
  createMockProviderKeychainStore,
  createMockTransportServer,
} from '../../../../helpers/mock-factories.js'

// ==================== Tests ====================

describe('ModelHandler', () => {
  let providerConfigStore: ReturnType<typeof createMockProviderConfigStore>
  let providerKeychainStore: ReturnType<typeof createMockProviderKeychainStore>
  let transport: ReturnType<typeof createMockTransportServer>
  let getModelFetcherStub: SinonStub

  beforeEach(() => {
    providerConfigStore = createMockProviderConfigStore()
    providerKeychainStore = createMockProviderKeychainStore()
    transport = createMockTransportServer()

    // Default: no providers connected (empty config)
    providerConfigStore.read.resolves(ProviderConfig.createDefault())

    getModelFetcherStub = stub().resolves()
  })

  afterEach(() => {
    restore()
  })

  function createHandler(overrides?: {
    getModelFetcher?: (id: string) => Promise<IProviderModelFetcher | undefined>
  }): ModelHandler {
    const handler = new ModelHandler({
      getModelFetcher: overrides?.getModelFetcher ?? getModelFetcherStub,
      providerConfigStore,
      providerKeychainStore,
      transport,
    })
    handler.setup()
    return handler
  }

  describe('setup', () => {
    it('should register model event handlers', () => {
      createHandler()

      expect(transport._handlers.has(ModelEvents.LIST)).to.be.true
      expect(transport._handlers.has(ModelEvents.SET_ACTIVE)).to.be.true
    })
  })

  describe('model:setActive', () => {
    it('should broadcast provider:updated after setting active model', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openrouter',
          providers: {openrouter: {connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []}},
        }),
      )

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'gpt-4', providerId: 'openrouter'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(transport.broadcast.calledOnce).to.be.true
      expect(transport.broadcast.calledWith(TransportDaemonEventNames.PROVIDER_UPDATED, {})).to.be.true
    })

    it('should set active model before broadcasting', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openrouter',
          providers: {openrouter: {connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []}},
        }),
      )

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      await handler!({modelId: 'gpt-4', providerId: 'openrouter'}, 'client-1')

      expect(providerConfigStore.setActiveModel.calledWith('openrouter', 'gpt-4')).to.be.true
      expect(providerConfigStore.setActiveModel.calledBefore(transport.broadcast)).to.be.true
    })

    it('should activate the provider when picking a model (load-bearing for openai-compatible deferred-activation)', async () => {
      // The openai-compatible connect path passes setAsActive: false when no
      // active model will be set. The provider only becomes active once a
      // model is picked here — so this call MUST flip activeProvider, or
      // the openai-compatible setup flow ends up "connected but never
      // active". A regression that drops this call would silently break it.
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: '',
          providers: {
            'openai-compatible': {
              authMethod: 'api-key',
              baseUrl: 'http://localhost:11434/v1',
              connectedAt: new Date().toISOString(),
              favoriteModels: [],
              recentModels: [],
            },
          },
        }),
      )

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'qwen3.5-9b', providerId: 'openai-compatible'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.setActiveProvider.calledWith('openai-compatible')).to.be.true
      expect(providerConfigStore.setActiveModel.calledWith('openai-compatible', 'qwen3.5-9b')).to.be.true
      expect(providerConfigStore.setActiveProvider.calledBefore(providerConfigStore.setActiveModel)).to.be.true
    })

    it('should reject when provider is not connected', async () => {
      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'gpt-4', providerId: 'unknown-provider'}, 'client-1')

      expect(result.success).to.be.false
      expect(result.error).to.include('not connected')
      expect(providerConfigStore.setActiveModel.called).to.be.false
      expect(transport.broadcast.called).to.be.false
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

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'some-model', providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.false
      expect(result.error).to.include('not connected')
      expect(providerConfigStore.setActiveProvider.called).to.be.false
      expect(providerConfigStore.setActiveModel.called).to.be.false
      expect(transport.broadcast.called).to.be.false
    })

    it('should still succeed for a healthy (non-tombstoned) api-key-connected provider', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.createDefault().withProviderConnected('openrouter', {authMethod: 'api-key'}),
      )
      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'some-model', providerId: 'openrouter'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.setActiveProvider.calledWith('openrouter')).to.be.true
      expect(providerConfigStore.setActiveModel.calledWith('openrouter', 'some-model')).to.be.true
    })

    it('should return structured error when config store throws', async () => {
      providerConfigStore.read.rejects(new Error('Config file corrupted'))

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'gpt-4', providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.false
      expect(result.error).to.include('Config file corrupted')
    })

    it('should return structured error when fetcher throws during OAuth validation', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )

      const mockFetcher = {
        fetchModels: stub().rejects(new Error('Network timeout')),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'o4-mini', providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.false
      expect(result.error).to.include('Network timeout')
    })

    it('should allow any model for API-key-connected providers without validation', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {
              authMethod: 'api-key',
              connectedAt: new Date().toISOString(),
              favoriteModels: [],
              recentModels: [],
            },
          },
        }),
      )

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'any-model-id', providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(getModelFetcherStub.called).to.be.false
    })

    it('should reject invalid model for OAuth-connected provider', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )

      const mockFetcher = {
        fetchModels: stub().resolves([
          {
            contextLength: 200_000,
            id: 'o4-mini',
            isFree: true,
            name: 'o4-mini',
            pricing: {inputPerM: 0, outputPerM: 0},
            provider: 'OpenAI',
          },
          {
            contextLength: 200_000,
            id: 'codex-mini-latest',
            isFree: true,
            name: 'Codex Mini (Latest)',
            pricing: {inputPerM: 0, outputPerM: 0},
            provider: 'OpenAI',
          },
        ]),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'gpt-4o', providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.false
      expect(result.error).to.include('gpt-4o')
      expect(result.error).to.include('not available')
      expect(providerConfigStore.setActiveModel.called).to.be.false
      expect(transport.broadcast.called).to.be.false
    })

    it('should allow valid model for OAuth-connected provider', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )

      const mockFetcher = {
        fetchModels: stub().resolves([
          {
            contextLength: 200_000,
            id: 'o4-mini',
            isFree: true,
            name: 'o4-mini',
            pricing: {inputPerM: 0, outputPerM: 0},
            provider: 'OpenAI',
          },
        ]),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'o4-mini', providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.setActiveModel.calledWith('openai', 'o4-mini')).to.be.true
      expect(transport.broadcast.calledOnce).to.be.true
    })

    it('should pass authMethod oauth to fetcher when validating', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )

      const mockFetcher = {
        fetchModels: stub().resolves([
          {
            contextLength: 200_000,
            id: 'o4-mini',
            isFree: true,
            name: 'o4-mini',
            pricing: {inputPerM: 0, outputPerM: 0},
            provider: 'OpenAI',
          },
        ]),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      await handler!({modelId: 'o4-mini', providerId: 'openai'}, 'client-1')

      expect(mockFetcher.fetchModels.calledWith('', {authMethod: 'oauth'})).to.be.true
    })

    it('should return error when model fetcher is undefined for OAuth provider', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )

      getModelFetcherStub.resolves()

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'o4-mini', providerId: 'openai'}, 'client-1')

      expect(result.success).to.be.false
      expect(result.error).to.include('model fetcher unavailable')
      expect(providerConfigStore.setActiveModel.called).to.be.false
      expect(transport.broadcast.called).to.be.false
    })

    it('should use matched model contextLength when data.contextLength is not provided', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )

      const mockFetcher = {
        fetchModels: stub().resolves([
          {
            contextLength: 200_000,
            id: 'o4-mini',
            isFree: true,
            name: 'o4-mini',
            pricing: {inputPerM: 0, outputPerM: 0},
            provider: 'OpenAI',
          },
        ]),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({modelId: 'o4-mini', providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.setActiveModel.calledWith('openai', 'o4-mini', 200_000)).to.be.true
    })

    it('should prefer data.contextLength over matched model contextLength', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )

      const mockFetcher = {
        fetchModels: stub().resolves([
          {
            contextLength: 200_000,
            id: 'o4-mini',
            isFree: true,
            name: 'o4-mini',
            pricing: {inputPerM: 0, outputPerM: 0},
            provider: 'OpenAI',
          },
        ]),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.SET_ACTIVE)
      const result = await handler!({contextLength: 128_000, modelId: 'o4-mini', providerId: 'openai'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(providerConfigStore.setActiveModel.calledWith('openai', 'o4-mini', 128_000)).to.be.true
    })
  })

  describe('model:list', () => {
    it('should pass authMethod to fetcher for OAuth-connected providers', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )
      providerKeychainStore.getApiKey.resolves('oauth-access-token')

      const codexModels = [
        {
          contextLength: 200_000,
          id: 'o4-mini',
          isFree: true,
          name: 'o4-mini',
          pricing: {inputPerM: 0, outputPerM: 0},
          provider: 'OpenAI',
        },
      ]
      const mockFetcher = {
        fetchModels: stub().resolves(codexModels),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.LIST)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(mockFetcher.fetchModels.calledWith('oauth-access-token', {authMethod: 'oauth'})).to.be.true
      expect(result.models).to.have.length(1)
      expect(result.models[0].id).to.equal('o4-mini')
    })

    it('should return error message when fetchModels throws', async () => {
      const mockFetcher = {
        fetchModels: stub().rejects(new Error('Request failed with status code 401')),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.LIST)
      const result = await handler!({providerId: 'openai'}, 'client-1')

      expect(result.error).to.equal('Request failed with status code 401')
      expect(result.models).to.deep.equal([])
      expect(result.favorites).to.deep.equal([])
      expect(result.recent).to.deep.equal([])
    })

    it('should pass authMethod undefined for non-connected providers', async () => {
      providerConfigStore.read.resolves(ProviderConfig.createDefault())
      providerKeychainStore.getApiKey.resolves('some-key')

      const mockFetcher = {
        fetchModels: stub().resolves([]),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.LIST)
      await handler!({providerId: 'openai'}, 'client-1')

      expect(mockFetcher.fetchModels.calledWith('some-key', {authMethod: undefined})).to.be.true
    })
  })

  describe('model:listByProviders', () => {
    it('should pass authMethod to fetcher for OAuth-connected providers', async () => {
      providerConfigStore.read.resolves(
        ProviderConfig.fromJson({
          activeProvider: 'openai',
          providers: {
            anthropic: {
              authMethod: 'api-key',
              connectedAt: new Date().toISOString(),
              favoriteModels: [],
              recentModels: [],
            },
            openai: {authMethod: 'oauth', connectedAt: new Date().toISOString(), favoriteModels: [], recentModels: []},
          },
        }),
      )
      providerKeychainStore.getApiKey.resolves('some-token')

      const mockFetcher = {
        fetchModels: stub().resolves([
          {
            contextLength: 200_000,
            id: 'test-model',
            isFree: true,
            name: 'Test',
            pricing: {inputPerM: 0, outputPerM: 0},
            provider: 'Test',
          },
        ]),
        validateApiKey: stub().resolves({isValid: true}),
      }
      getModelFetcherStub.resolves(mockFetcher)

      createHandler()

      const handler = transport._handlers.get(ModelEvents.LIST_BY_PROVIDERS)
      const result = await handler!({providerIds: ['openai', 'anthropic']}, 'client-1')

      expect(result.models).to.have.length(2)

      // Verify OAuth provider gets authMethod: 'oauth'
      const openaiCall = mockFetcher.fetchModels
        .getCalls()
        .find((c: {args: unknown[]}) => (c.args[1] as {authMethod?: string})?.authMethod === 'oauth')
      expect(openaiCall).to.exist

      // Verify API-key provider gets authMethod: 'api-key'
      const anthropicCall = mockFetcher.fetchModels
        .getCalls()
        .find((c: {args: unknown[]}) => (c.args[1] as {authMethod?: string})?.authMethod === 'api-key')
      expect(anthropicCall).to.exist
    })
  })
})
