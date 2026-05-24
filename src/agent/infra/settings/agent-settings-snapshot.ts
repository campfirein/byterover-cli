import type {ITransportClient} from '@campfirein/brv-transport-client'

import type {SettingsListResponse} from '../../../shared/transport/events/settings-events.js'

import {SettingsEvents} from '../../../shared/transport/events/settings-events.js'

/**
 * Agent-side cache of `SettingsEvents.LIST` snapshot.
 *
 * The agent process reads the cache at module load time once at agent
 * bootstrap (after `connectToTransport`) and afterwards lookups are
 * synchronous and free. The daemon is the writer-of-record for
 * `settings.json`; the agent caches the resolved values for the
 * lifetime of the agent process so per-session services observe a
 * consistent configuration.
 *
 * The cache is intentionally NOT refreshed on `settings:*` events
 * during the agent's runtime — restart-required semantics live on the
 * daemon side too. M3 reuses the same cache for `llm.requestTimeoutMs`.
 */

let snapshot: Readonly<Record<string, number>> | undefined
let loaded = false

/**
 * Calls `SettingsEvents.LIST` once and caches the response by key.
 * Subsequent calls within the same process are no-ops. Failures (the
 * daemon doesn't answer, the response is malformed) leave the cache
 * empty so `getAgentSettingValue` falls back to undefined and each
 * consumer applies its own default.
 */
export async function loadAgentSettingsSnapshot(client: ITransportClient): Promise<void> {
  if (loaded) return
  loaded = true

  try {
    const response = await client.requestWithAck<SettingsListResponse>(SettingsEvents.LIST)
    const values: Record<string, number> = {}
    for (const item of response.items) {
      values[item.key] = item.current
    }

    snapshot = values
  } catch {
    snapshot = undefined
  }
}

/**
 * Returns the cached value for `key`, or undefined if the snapshot
 * hasn't been loaded or the key is absent from it. Synchronous so it
 * can be called from any code path during session construction.
 */
export function getAgentSettingValue(key: string): number | undefined {
  return snapshot?.[key]
}

/** Test-only: clear module-scope state so each test sees a fresh cache. */
export function resetAgentSettingsSnapshotForTests(): void {
  snapshot = undefined
  loaded = false
}
