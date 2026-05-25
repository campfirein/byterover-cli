import type {ISettingsStore} from '../../core/interfaces/storage/i-settings-store.js'

import {
  AGENT_MAX_CONCURRENT_TASKS,
  AGENT_POOL_MAX_SIZE,
  TASK_HISTORY_DEFAULT_MAX_ENTRIES,
} from '../../constants.js'
import {SETTINGS_KEYS} from '../../core/domain/entities/settings.js'

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

  return {
    agentMaxConcurrentTasks: snapshot.values[SETTINGS_KEYS.AGENT_POOL_MAX_CONCURRENT_TASKS] ?? AGENT_MAX_CONCURRENT_TASKS,
    agentPoolMaxSize: snapshot.values[SETTINGS_KEYS.AGENT_POOL_MAX_SIZE] ?? AGENT_POOL_MAX_SIZE,
    taskHistoryMaxEntries: snapshot.values[SETTINGS_KEYS.TASK_HISTORY_MAX_ENTRIES] ?? TASK_HISTORY_DEFAULT_MAX_ENTRIES,
  }
}
