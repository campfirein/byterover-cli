import type {SettingItem} from '../../domain/entities/settings.js'

/**
 * Diagnostic view of the on-disk settings file consumed by the daemon
 * bootstrap. Returns only valid overrides (caller applies them) plus a
 * list of rejected entries (caller logs a warning per entry).
 */
export type SettingsStartupSnapshot = {
  readonly invalid: ReadonlyArray<{readonly key: string; readonly reason: string; readonly value: unknown}>
  /**
   * Set when the file exists but cannot be parsed as `{version, values}`.
   * Daemon startup logs this once; all values fall back to defaults.
   */
  readonly parseError?: string
  readonly values: Readonly<Record<string, number>>
}

/**
 * Persists and reads user-configurable operational settings.
 *
 * Errors:
 * - Unknown keys throw `UnknownSettingKeyError`.
 * - Invalid values (wrong type, out of range) throw `InvalidSettingValueError`.
 * Callers at the transport boundary map these to typed transport errors.
 */
export interface ISettingsStore {
  /** Returns the current value (or default if unset) for a single registered key. */
  get(key: string): Promise<SettingItem>

  /** Returns one item per registered key with its current and default values. */
  list(): Promise<readonly SettingItem[]>

  /**
   * Reads the on-disk file and partitions it into valid overrides plus a
   * list of rejected entries. Used by daemon startup to log a warning per
   * invalid entry while still applying the valid keys.
   */
  readStartupSnapshot(): Promise<SettingsStartupSnapshot>

  /** Removes any user override for `key`. The next read returns the default. */
  reset(key: string): Promise<void>

  /** Validates and persists an override for `key`. */
  set(key: string, value: unknown): Promise<void>
}
