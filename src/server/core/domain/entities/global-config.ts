import {GLOBAL_CONFIG_VERSION} from '../../../constants.js'

/**
 * Parameters for creating a GlobalConfig instance.
 */
export interface GlobalConfigParams {
  readonly analytics: boolean
  readonly deviceId: string
  readonly version: string
}

/**
 * Serialized JSON shape for GlobalConfig.
 */
export type GlobalConfigJson = {
  readonly analytics: boolean
  readonly deviceId: string
  readonly version: string
}

type GlobalConfigJsonInput = {
  readonly analytics?: boolean
  readonly deviceId: string
  readonly version: string
}

/**
 * Type guard for GlobalConfig JSON validation.
 * `analytics` is optional on input (legacy configs predate the field); when
 * present it must be a boolean.
 */
const isGlobalConfigJson = (json: unknown): json is GlobalConfigJsonInput => {
  if (typeof json !== 'object' || json === null || json === undefined) return false

  const obj = json as Record<string, unknown>

  if (typeof obj.deviceId !== 'string' || obj.deviceId.trim().length === 0) {
    return false
  }

  if (typeof obj.version !== 'string') {
    return false
  }

  if ('analytics' in obj && typeof obj.analytics !== 'boolean') {
    return false
  }

  return true
}

/**
 * Represents the global configuration stored in the user's config directory.
 * Contains device-level settings that persist across all projects.
 */
export class GlobalConfig {
  public readonly analytics: boolean
  public readonly deviceId: string
  public readonly version: string

  private constructor(params: GlobalConfigParams) {
    this.deviceId = params.deviceId
    this.version = params.version
    this.analytics = params.analytics
  }

  /**
   * Creates a new GlobalConfig with the given device ID and current version.
   * Analytics defaults to `false` (opt-in).
   *
   * @param deviceId - The unique device identifier (UUID v4)
   * @returns A new GlobalConfig instance
   * @throws Error if deviceId is empty
   */
  public static create(deviceId: string): GlobalConfig {
    if (deviceId.trim().length === 0) {
      throw new Error('Device ID cannot be empty')
    }

    return new GlobalConfig({
      analytics: false,
      deviceId,
      version: GLOBAL_CONFIG_VERSION,
    })
  }

  /**
   * Deserializes config from JSON format.
   * Returns undefined for invalid JSON structure (graceful failure).
   * Missing `analytics` defaults to `false` to preserve the opt-in promise
   * across upgrades from pre-analytics builds.
   *
   * @param json - The JSON object to deserialize
   * @returns GlobalConfig instance or undefined if invalid
   */
  public static fromJson(json: unknown): GlobalConfig | undefined {
    if (!isGlobalConfigJson(json)) {
      return undefined
    }

    return new GlobalConfig({
      analytics: json.analytics ?? false,
      deviceId: json.deviceId,
      version: json.version,
    })
  }

  /**
   * Serializes the config to JSON format.
   */
  public toJson(): GlobalConfigJson {
    return {
      analytics: this.analytics,
      deviceId: this.deviceId,
      version: this.version,
    }
  }

  /**
   * Returns a new GlobalConfig with the analytics flag set to the given value.
   * deviceId and version are preserved. The original instance is not mutated.
   *
   * @param value - The new analytics value
   * @returns A new GlobalConfig instance
   */
  public withAnalytics(value: boolean): GlobalConfig {
    return new GlobalConfig({
      analytics: value,
      deviceId: this.deviceId,
      version: this.version,
    })
  }
}
