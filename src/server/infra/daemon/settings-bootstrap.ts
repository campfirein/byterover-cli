import type {ISettingsStore, SettingsStartupSnapshot} from '../../core/interfaces/storage/i-settings-store.js'

import {
  AGENT_MAX_CONCURRENT_TASKS,
  AGENT_POOL_MAX_SIZE,
  TASK_HISTORY_DEFAULT_MAX_ENTRIES,
  TRANSPORT_HOST,
} from '../../constants.js'
import {SETTINGS_KEYS} from '../../core/domain/entities/settings.js'

const TRANSPORT_HOST_ENV = 'BRV_TRANSPORT_HOST'

/**
 * Daemon-side resolved view of every settings key the bootstrap path
 * consumes. Each field name mirrors the constructor option of the
 * downstream consumer so wiring at the daemon stays mechanical.
 */
export type ResolvedSettings = {
  /** Feeds `AgentPool({maxConcurrentTasks})`. */
  readonly agentMaxConcurrentTasks: number
  /** Feeds `AgentPool({maxSize})`. */
  readonly agentPoolMaxSize: number
  /** Feeds `FileTaskHistoryStore({maxEntries})` via the per-project cache. */
  readonly taskHistoryMaxEntries: number
  /**
   * Host interface both the Socket.IO transport server and the WebUI HTTP
   * server bind to at daemon startup. Resolved with precedence:
   *   BRV_TRANSPORT_HOST env > network.host setting > TRANSPORT_HOST default.
   */
  readonly transportHost: string
  /** Where `transportHost` was sourced from. Surfaced in the daemon boot log. */
  readonly transportHostSource: 'default' | 'env' | 'settings'
}

export type BootstrapSettingsOptions = {
  readonly log: (message: string) => void
  readonly store: ISettingsStore
}

/**
 * Reads the on-disk settings file once at daemon startup, logs a warning
 * for any unparseable file or rejected entries, and returns the resolved
 * numeric values the daemon hands to its consumers. Missing or invalid
 * keys silently fall back to the registered defaults from `constants.ts`.
 */
export async function bootstrapSettings(options: BootstrapSettingsOptions): Promise<ResolvedSettings> {
  const {log, store} = options
  const snapshot = await store.readStartupSnapshot()

  if (snapshot.parseError !== undefined) {
    log(`[settings] failed to read settings file: ${snapshot.parseError}. Falling back to defaults.`)
  }

  for (const entry of snapshot.invalid) {
    log(`[settings] ignoring invalid entry '${entry.key}': ${entry.reason}. Falling back to default.`)
  }

  const envHost = process.env[TRANSPORT_HOST_ENV]?.trim()
  let transportHost: string
  let transportHostSource: 'default' | 'env' | 'settings'
  if (envHost !== undefined && envHost.length > 0) {
    transportHost = envHost
    transportHostSource = 'env'
  } else {
    const settingsHost = readString(snapshot, SETTINGS_KEYS.NETWORK_HOST)
    if (settingsHost === undefined) {
      transportHost = TRANSPORT_HOST
      transportHostSource = 'default'
    } else {
      transportHost = settingsHost
      transportHostSource = 'settings'
    }
  }

  return {
    agentMaxConcurrentTasks: readNumber(snapshot, SETTINGS_KEYS.AGENT_POOL_MAX_CONCURRENT_TASKS, AGENT_MAX_CONCURRENT_TASKS),
    agentPoolMaxSize: readNumber(snapshot, SETTINGS_KEYS.AGENT_POOL_MAX_SIZE, AGENT_POOL_MAX_SIZE),
    taskHistoryMaxEntries: readNumber(snapshot, SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES, TASK_HISTORY_DEFAULT_MAX_ENTRIES),
    transportHost,
    transportHostSource,
  }
}

function readNumber(snapshot: SettingsStartupSnapshot, key: string, fallback: number): number {
  const value = snapshot.values[key]
  return typeof value === 'number' ? value : fallback
}

/**
 * Returns the trimmed snapshot value for `key`, or `undefined` if missing /
 * not-a-string / empty / whitespace-only. Caller picks the fallback so the
 * `transportHostSource` distinction (env vs settings vs default) stays
 * accurate even when the persisted value happens to equal the default.
 */
function readString(snapshot: SettingsStartupSnapshot, key: string): string | undefined {
  const value = snapshot.values[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
