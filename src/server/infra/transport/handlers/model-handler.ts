import type {ModelDTO} from '../../../../shared/transport/types/dto.js'
import type {IProviderConfigStore} from '../../../core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../../core/interfaces/i-provider-keychain-store.js'
import type {IProviderModelFetcher, ProviderModelInfo} from '../../../core/interfaces/i-provider-model-fetcher.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  ModelEvents,
  type ModelListByProvidersRequest,
  type ModelListByProvidersResponse,
  type ModelListRequest,
  type ModelListResponse,
  type ModelSetActiveRequest,
  type ModelSetActiveResponse,
} from '../../../../shared/transport/events/model-events.js'
import {TransportDaemonEventNames} from '../../../core/domain/transport/schemas.js'
import {getModelFetcher as getModelFetcherDefault} from '../../http/provider-model-fetcher-registry.js'

export interface ModelHandlerDeps {
  getModelFetcher?: (providerId: string) => Promise<IProviderModelFetcher | undefined>
  providerConfigStore: IProviderConfigStore
  providerKeychainStore: IProviderKeychainStore
  transport: ITransportServer
}

/**
 * Handles model:* events.
 * Business logic for model listing and selection — no terminal/UI calls.
 */
export class ModelHandler {
  private readonly getModelFetcher: (providerId: string) => Promise<IProviderModelFetcher | undefined>
  private readonly providerConfigStore: IProviderConfigStore
  private readonly providerKeychainStore: IProviderKeychainStore
  private readonly transport: ITransportServer

  constructor(deps: ModelHandlerDeps) {
    this.getModelFetcher = deps.getModelFetcher ?? getModelFetcherDefault
    this.providerConfigStore = deps.providerConfigStore
    this.providerKeychainStore = deps.providerKeychainStore
    this.transport = deps.transport
  }

  setup(): void {
    this.setupList()
    this.setupListByProviders()
    this.setupSetActive()
  }

  private setupList(): void {
    this.transport.onRequest<ModelListRequest, ModelListResponse>(ModelEvents.LIST, async (data) => {
      const {providerId} = data
      const fetcher = await this.getModelFetcher(providerId)
      if (!fetcher) {
        return {favorites: [], models: [], recent: []}
      }

      // Fetch models from provider API using the correct per-provider fetcher
      let fetchedModels: ProviderModelInfo[]
      try {
        const config = await this.providerConfigStore.read()
        const authMethod = config.providers[providerId]?.authMethod
        const apiKey = await this.providerKeychainStore.getApiKey(providerId)
        fetchedModels = await fetcher.fetchModels(apiKey ?? '', {authMethod})
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to load models'
        return {error: message, favorites: [], models: [], recent: []}
      }

      const models: ModelDTO[] = fetchedModels.map((m) => ({
        contextLength: m.contextLength,
        description: m.description,
        id: m.id,
        isFree: m.isFree,
        name: m.name,
        pricing: m.pricing,
        provider: m.provider,
        providerId,
      }))

      const [activeModel, favorites, recent] = await Promise.all([
        this.providerConfigStore.getActiveModel(providerId),
        this.providerConfigStore.getFavoriteModels(providerId),
        this.providerConfigStore.getRecentModels(providerId),
      ])

      return {
        activeModel,
        favorites: [...favorites],
        models,
        recent: [...recent],
      }
    })
  }

  private setupListByProviders(): void {
    this.transport.onRequest<ModelListByProvidersRequest, ModelListByProvidersResponse>(
      ModelEvents.LIST_BY_PROVIDERS,
      async (data) => {
        const {providerIds} = data
        const config = await this.providerConfigStore.read()

        const results = await Promise.allSettled(
          providerIds.map(async (providerId): Promise<ModelDTO[]> => {
            const fetcher = await this.getModelFetcher(providerId)
            if (!fetcher) return []

            const authMethod = config.providers[providerId]?.authMethod
            const apiKey = await this.providerKeychainStore.getApiKey(providerId)
            const fetchedModels = await fetcher.fetchModels(apiKey ?? '', {authMethod})

            return fetchedModels.map((model) => ({
              contextLength: model.contextLength,
              description: model.description,
              id: model.id,
              isFree: model.isFree,
              name: model.name,
              pricing: model.pricing,
              provider: model.provider,
              providerId,
            }))
          }),
        )

        const models: ModelDTO[] = []
        const providerErrors: Record<string, string> = {}
        for (const [i, result] of results.entries()) {
          const providerId = providerIds[i]
          if (result.status === 'fulfilled') {
            models.push(...result.value)
          } else {
            const raw = result.reason instanceof Error ? result.reason.message : String(result.reason)
            providerErrors[providerId] = raw.replace(/ for event '[^']+'$/, '')
          }
        }

        return {
          models,
          providerErrors: Object.keys(providerErrors).length > 0 ? providerErrors : undefined,
        }
      },
    )
  }

  private setupSetActive(): void {
    this.transport.onRequest<ModelSetActiveRequest, ModelSetActiveResponse>(ModelEvents.SET_ACTIVE, async (data) => {
      try {
        const config = await this.providerConfigStore.read()
        const providerConfig = config.providers[data.providerId]

        // A tombstoned entry (disconnected with a recorded reason, e.g. a permanent
        // OAuth refresh failure) still exists in config.providers, so presence alone
        // isn't enough — isProviderConnected() also rejects tombstones.
        if (!providerConfig || !config.isProviderConnected(data.providerId)) {
          return {
            error: `Provider "${data.providerId}" is not connected`,
            success: false,
          }
        }

        let matchedModel: ProviderModelInfo | undefined

        // Validate model against allowed list for OAuth providers
        if (providerConfig.authMethod === 'oauth') {
          const fetcher = await this.getModelFetcher(data.providerId)
          if (!fetcher) {
            return {
              error: `Cannot validate model for OAuth-connected ${data.providerId}: model fetcher unavailable`,
              success: false,
            }
          }

          const allowedModels = await fetcher.fetchModels('', {authMethod: 'oauth'})
          matchedModel = allowedModels.find((m) => m.id === data.modelId)
          if (!matchedModel) {
            const allowedIds = allowedModels.map((m) => m.id).join(', ')
            return {
              error: `Model "${data.modelId}" is not available for OAuth-connected ${data.providerId}. Allowed models: ${allowedIds}`,
              success: false,
            }
          }
        }

        const contextLength = data.contextLength ?? matchedModel?.contextLength
        await this.providerConfigStore.setActiveProvider(data.providerId)
        await this.providerConfigStore.setActiveModel(data.providerId, data.modelId, contextLength)
        this.transport.broadcast(TransportDaemonEventNames.PROVIDER_UPDATED, {})
        return {success: true}
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : 'Failed to set active model'
        return {error: message, success: false}
      }
    })
  }
}
