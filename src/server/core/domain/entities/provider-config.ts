/**
 * Provider Configuration Entity
 *
 * Stores user's provider preferences and connection state.
 * Non-sensitive data (API keys stored separately in keychain).
 */

/**
 * Durable record of why/when a provider was disconnected.
 *
 * Persisted on the provider entry (tombstone) when the provider was disconnected
 * with a recorded reason — e.g. a permanent OAuth refresh failure — so the user
 * can later see what happened and how to reconnect, instead of silently finding
 * "no provider connected" with no explanation.
 */
export interface ProviderDisconnectInfo {
  /** ISO timestamp of when the disconnect happened */
  readonly at: string
  /** OAuth error code when available (e.g. invalid_grant, invalid_client) */
  readonly errorCode?: string
  /** Human-readable reason (e.g. "OAuth token refresh failed") */
  readonly reason: string
  /** HTTP status code when available (e.g. 400, 401) */
  readonly statusCode?: number
}

/**
 * Configuration for a single connected provider.
 */
export interface ConnectedProviderConfig {
  /** Currently active model for this provider */
  readonly activeModel?: string
  /** Context window size of the active model (from provider API, e.g. OpenRouter) */
  readonly activeModelContextLength?: number
  /** How this provider was authenticated */
  readonly authMethod?: 'api-key' | 'oauth'
  /** Custom API base URL (for openai-compatible provider) */
  readonly baseUrl?: string
  /** When the provider was connected */
  readonly connectedAt: string
  /** User's favorite models (for quick access) */
  readonly favoriteModels: readonly string[]
  /**
   * Set when the provider was disconnected with a recorded reason. Its presence
   * marks this entry as a disconnected tombstone — `isProviderConnected` returns
   * false while it is set, and reconnecting clears it.
   */
  readonly lastDisconnect?: ProviderDisconnectInfo
  /** OAuth account ID (e.g. ChatGPT-Account-Id for OpenAI) */
  readonly oauthAccountId?: string
  /** Recently used models (last 10) */
  readonly recentModels: readonly string[]
}

/**
 * Parameters for creating a ProviderConfig.
 */
export interface ProviderConfigParams {
  /** Currently active provider ID */
  readonly activeProvider: string
  /** Configuration for each connected provider */
  readonly providers: Readonly<Record<string, ConnectedProviderConfig>>
}

/**
 * Type guard for ProviderConfig JSON validation.
 */
const isProviderConfigJson = (json: unknown): json is ProviderConfigParams => {
  if (typeof json !== 'object' || json === null) return false

  if (!('activeProvider' in json) || typeof json.activeProvider !== 'string') return false
  if (!('providers' in json) || typeof json.providers !== 'object' || json.providers === null) return false

  return true
}

/**
 * Default configuration when no providers are connected.
 */
export const DEFAULT_PROVIDER_CONFIG: ProviderConfigParams = {
  activeProvider: '',
  providers: {},
}

/**
 * Maximum number of recent models to track.
 */
const MAX_RECENT_MODELS = 10

/**
 * Represents the provider configuration for the CLI.
 * Tracks which providers are connected and user preferences.
 */
export class ProviderConfig {
  public readonly activeProvider: string
  public readonly providers: Readonly<Record<string, ConnectedProviderConfig>>

  private constructor(params: ProviderConfigParams) {
    this.activeProvider = params.activeProvider
    this.providers = params.providers
  }

  /**
   * Creates a new ProviderConfig with default values.
   */
  public static createDefault(): ProviderConfig {
    return new ProviderConfig(DEFAULT_PROVIDER_CONFIG)
  }

  /**
   * Deserializes config from JSON format.
   * Returns default config for invalid JSON structure.
   */
  public static fromJson(json: unknown): ProviderConfig {
    if (!isProviderConfigJson(json)) {
      return ProviderConfig.createDefault()
    }

    return new ProviderConfig(json)
  }

  /**
   * Get the active model for a provider.
   */
  public getActiveModel(providerId: string): string | undefined {
    return this.providers[providerId]?.activeModel
  }

  /**
   * Get the context window size of the active model for a provider.
   */
  public getActiveModelContextLength(providerId: string): number | undefined {
    return this.providers[providerId]?.activeModelContextLength
  }

  /**
   * Get the custom base URL for a provider (e.g., openai-compatible).
   */
  public getBaseUrl(providerId: string): string | undefined {
    return this.providers[providerId]?.baseUrl
  }

  /**
   * Get favorite models for a provider.
   */
  public getFavoriteModels(providerId: string): readonly string[] {
    return this.providers[providerId]?.favoriteModels ?? []
  }

  /**
   * Get recent models for a provider.
   */
  public getRecentModels(providerId: string): readonly string[] {
    return this.providers[providerId]?.recentModels ?? []
  }

  /**
   * Check if a provider is connected.
   *
   * A disconnected tombstone (an entry retained only to record `lastDisconnect`)
   * is NOT connected — it exists purely to surface why the provider dropped.
   */
  public isProviderConnected(providerId: string): boolean {
    const entry = this.providers[providerId]
    return entry !== undefined && entry.lastDisconnect === undefined
  }

  /**
   * Serializes the config to JSON format.
   */
  public toJson(): ProviderConfigParams {
    return {
      activeProvider: this.activeProvider,
      providers: this.providers,
    }
  }

  /**
   * Create a new config with the active model changed for a provider.
   */
  public withActiveModel(providerId: string, modelId: string, contextLength?: number): ProviderConfig {
    const existingConfig = this.providers[providerId]
    if (!existingConfig) {
      return this
    }

    // Add to recent models (at the front, deduplicated)
    const recentModels = [modelId, ...existingConfig.recentModels.filter((m) => m !== modelId)].slice(
      0,
      MAX_RECENT_MODELS,
    )

    const newProviderConfig: ConnectedProviderConfig = {
      ...existingConfig,
      activeModel: modelId,
      activeModelContextLength: contextLength,
      recentModels,
    }

    return new ProviderConfig({
      ...this.toJson(),
      providers: {
        ...this.providers,
        [providerId]: newProviderConfig,
      },
    })
  }

  /**
   * Create a new config with the active provider changed.
   */
  public withActiveProvider(providerId: string): ProviderConfig {
    return new ProviderConfig({
      ...this.toJson(),
      activeProvider: providerId,
    })
  }

  /**
   * Create a new config with a model toggled as favorite.
   */
  public withFavoriteToggled(providerId: string, modelId: string): ProviderConfig {
    const existingConfig = this.providers[providerId]
    if (!existingConfig) {
      return this
    }

    const isFavorite = existingConfig.favoriteModels.includes(modelId)
    const favoriteModels = isFavorite
      ? existingConfig.favoriteModels.filter((m) => m !== modelId)
      : [...existingConfig.favoriteModels, modelId]

    const newProviderConfig: ConnectedProviderConfig = {
      ...existingConfig,
      favoriteModels,
    }

    return new ProviderConfig({
      ...this.toJson(),
      providers: {
        ...this.providers,
        [providerId]: newProviderConfig,
      },
    })
  }

  /**
   * Create a new config with a provider connected.
   */
  public withProviderConnected(
    providerId: string,
    options?: {
      activeModel?: string
      authMethod?: 'api-key' | 'oauth'
      baseUrl?: string
      oauthAccountId?: string
    },
  ): ProviderConfig {
    const existingConfig = this.providers[providerId]
    const newProviderConfig: ConnectedProviderConfig = {
      activeModel: options?.activeModel ?? existingConfig?.activeModel,
      authMethod: options?.authMethod ?? existingConfig?.authMethod,
      baseUrl: options?.baseUrl ?? existingConfig?.baseUrl,
      connectedAt: existingConfig?.connectedAt ?? new Date().toISOString(),
      favoriteModels: existingConfig?.favoriteModels ?? [],
      oauthAccountId: options?.oauthAccountId ?? existingConfig?.oauthAccountId,
      recentModels: existingConfig?.recentModels ?? [],
    }

    return new ProviderConfig({
      ...this.toJson(),
      providers: {
        ...this.providers,
        [providerId]: newProviderConfig,
      },
    })
  }

  /**
   * Create a new config with a provider disconnected.
   *
   * Without `details`, the provider entry is removed entirely (a clean manual
   * disconnect). With `details`, the entry is retained as a tombstone carrying a
   * `lastDisconnect` record so the reason survives to the providers view — used
   * when the disconnect was involuntary (e.g. a permanent OAuth refresh failure).
   * The active provider is cleared either way when it was the disconnected one.
   */
  public withProviderDisconnected(
    providerId: string,
    details?: {errorCode?: string; reason: string; statusCode?: number},
  ): ProviderConfig {
    const newActiveProvider = this.activeProvider === providerId ? '' : this.activeProvider
    const existingConfig = this.providers[providerId]

    // Record a tombstone (keep the entry) when a reason is supplied and the
    // provider actually existed — so the disconnect is visible after the fact.
    if (details && existingConfig) {
      const lastDisconnect: ProviderDisconnectInfo = {
        at: new Date().toISOString(),
        errorCode: details.errorCode,
        reason: details.reason,
        statusCode: details.statusCode,
      }

      return new ProviderConfig({
        activeProvider: newActiveProvider,
        providers: {
          ...this.providers,
          [providerId]: {...existingConfig, lastDisconnect},
        },
      })
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {[providerId]: _removed, ...remainingProviders} = this.providers

    return new ProviderConfig({
      activeProvider: newActiveProvider,
      providers: remainingProviders,
    })
  }
}
