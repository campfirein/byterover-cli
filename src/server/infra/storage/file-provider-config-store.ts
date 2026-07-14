/**
 * File-based Provider Config Store
 *
 * Stores provider configuration (non-sensitive data) in a JSON file.
 * API keys are stored separately in the system keychain.
 */

import {existsSync} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import type {IProviderConfigStore} from '../../core/interfaces/i-provider-config-store.js'

import {ProviderConfig} from '../../core/domain/entities/provider-config.js'
import {getGlobalConfigDir} from '../../utils/global-config-path.js'

const PROVIDER_CONFIG_FILE = 'providers.json'

/**
 * Dependencies for FileProviderConfigStore.
 * Allows injection for testing.
 */
export interface FileProviderConfigStoreDeps {
  readonly getConfigDir: () => string
  readonly getConfigPath: () => string
}

/**
 * Default dependencies using the real path functions.
 */
const defaultDeps: FileProviderConfigStoreDeps = {
  getConfigDir: getGlobalConfigDir,
  getConfigPath: () => join(getGlobalConfigDir(), PROVIDER_CONFIG_FILE),
}

/**
 * File-based implementation of IProviderConfigStore.
 * Stores configuration in <global-config-dir>/providers.json (platform-specific path).
 */
export class FileProviderConfigStore implements IProviderConfigStore {
  private cachedConfig: ProviderConfig | undefined
  private readonly deps: FileProviderConfigStoreDeps

  public constructor(deps: FileProviderConfigStoreDeps = defaultDeps) {
    this.deps = deps
  }

  /**
   * Clears the cached config. Useful for testing or forcing a re-read.
   */
  public clearCache(): void {
    this.cachedConfig = undefined
  }

  /**
   * Marks a provider as connected. Defaults to also marking it as active —
   * pass `setAsActive: false` to skip the activate step (used when the
   * provider has no usable model yet).
   */
  public async connectProvider(
    providerId: string,
    options?: {
      activeModel?: string
      authMethod?: 'api-key' | 'oauth'
      baseUrl?: string
      oauthAccountId?: string
      setAsActive?: boolean
    },
  ): Promise<void> {
    const config = await this.read()
    const connected = config.withProviderConnected(providerId, options)
    const newConfig = options?.setAsActive === false ? connected : connected.withActiveProvider(providerId)
    await this.write(newConfig)
  }

  /**
   * Removes a provider connection. When `details` is supplied, the entry is
   * retained as a `lastDisconnect` tombstone (see IProviderConfigStore).
   */
  public async disconnectProvider(
    providerId: string,
    details?: {errorCode?: string; reason: string; statusCode?: number},
  ): Promise<void> {
    const config = await this.read()
    const newConfig = config.withProviderDisconnected(providerId, details)
    await this.write(newConfig)
  }

  /**
   * Gets the active model for a provider.
   */
  public async getActiveModel(providerId: string): Promise<string | undefined> {
    const config = await this.read()
    return config.getActiveModel(providerId)
  }

  /**
   * Gets the active provider ID.
   */
  public async getActiveProvider(): Promise<string> {
    const config = await this.read()
    return config.activeProvider
  }

  /**
   * Gets favorite models for a provider.
   */
  public async getFavoriteModels(providerId: string): Promise<readonly string[]> {
    const config = await this.read()
    return config.getFavoriteModels(providerId)
  }

  /**
   * Gets recent models for a provider.
   */
  public async getRecentModels(providerId: string): Promise<readonly string[]> {
    const config = await this.read()
    return config.getRecentModels(providerId)
  }

  /**
   * Checks if a provider is connected.
   */
  public async isProviderConnected(providerId: string): Promise<boolean> {
    const config = await this.read()
    return config.isProviderConnected(providerId)
  }

  /**
   * Reads the provider configuration from disk.
   */
  public async read(): Promise<ProviderConfig> {
    if (this.cachedConfig) {
      return this.cachedConfig
    }

    const configPath = this.deps.getConfigPath()

    if (!existsSync(configPath)) {
      this.cachedConfig = ProviderConfig.createDefault()
      return this.cachedConfig
    }

    try {
      const content = await readFile(configPath, 'utf8')
      const json: unknown = JSON.parse(content)
      this.cachedConfig = ProviderConfig.fromJson(json)
      return this.cachedConfig
    } catch {
      // Return default config for any error
      this.cachedConfig = ProviderConfig.createDefault()
      return this.cachedConfig
    }
  }

  /**
   * Sets the active model for a provider.
   */
  public async setActiveModel(providerId: string, modelId: string, contextLength?: number): Promise<void> {
    const config = await this.read()
    const newConfig = config.withActiveModel(providerId, modelId, contextLength)
    await this.write(newConfig)
  }

  /**
   * Sets the active provider.
   */
  public async setActiveProvider(providerId: string): Promise<void> {
    const config = await this.read()
    const newConfig = config.withActiveProvider(providerId)
    await this.write(newConfig)
  }

  /**
   * Toggles a model as favorite.
   */
  public async toggleFavorite(providerId: string, modelId: string): Promise<void> {
    const config = await this.read()
    const newConfig = config.withFavoriteToggled(providerId, modelId)
    await this.write(newConfig)
  }

  /**
   * Writes the provider configuration to disk.
   */
  public async write(config: ProviderConfig): Promise<void> {
    const configDir = this.deps.getConfigDir()
    const configPath = this.deps.getConfigPath()

    // Create config directory if it doesn't exist
    await mkdir(configDir, {recursive: true})

    // Write config file
    const content = JSON.stringify(config.toJson(), null, 2)
    await writeFile(configPath, content, 'utf8')

    // Update cache
    this.cachedConfig = config
  }
}
