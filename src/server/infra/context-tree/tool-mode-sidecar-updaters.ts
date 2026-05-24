import type {ILogger} from '../../../agent/core/interfaces/i-logger.js'
import type {IRuntimeSignalStore} from '../../core/interfaces/storage/i-runtime-signal-store.js'

import {determineTier, recordCurateUpdate} from '../../core/domain/knowledge/memory-scoring.js'
import {createDefaultRuntimeSignals, type RuntimeSignals} from '../../core/domain/knowledge/runtime-signals-schema.js'
import {warnSidecarFailure} from '../../core/domain/knowledge/sidecar-logging.js'

const TOOL_MODE_CURATE_SITE = 'tool-mode-curate'

/**
 * Update the runtime-signal sidecar after a successful tool-mode curate write.
 *
 * - `existedBefore=false` → seed default signals (ADD path).
 * - `existedBefore=true`  → bump importance + recency + updateCount and
 *   recompute maturity (UPDATE path), mirroring the legacy curate-tool's
 *   `mirrorCurateUpdate`.
 *
 * Best-effort: a sidecar failure must never break the write that already
 * succeeded. When a `logger` is passed, the outer error is logged at WARN
 * level via `warnSidecarFailure`; without one, the helper is silent and
 * relies on the underlying `RuntimeSignalStore` (mandatory logger) to
 * surface storage-level failures.
 *
 * Note on the read-side: this module intentionally does NOT export a
 * `bumpSidecarOnQueryRead` helper. End-to-end testing on a real project
 * (PR #677) revealed that `SearchKnowledgeService` already mirrors access
 * hits into the sidecar via `flushAccessHits` → `mirrorHitsToSignalStore`
 * inside `acquireIndex`. Adding a second read-side bump would double-
 * count importance and prematurely promote topics to higher maturity
 * tiers. The curate write path stays — that one has no equivalent
 * legacy mechanism in tool-mode.
 */
export async function bumpSidecarOnCurateWrite(params: {
  existedBefore: boolean
  logger?: ILogger
  relPath: string
  store: IRuntimeSignalStore | undefined
}): Promise<void> {
  const {existedBefore, logger, relPath, store} = params
  if (!store) return

  if (existedBefore) {
    try {
      await store.update(relPath, (current: RuntimeSignals): RuntimeSignals => {
        const bumped = recordCurateUpdate(current)
        return {
          ...current,
          importance: bumped.importance,
          maturity: determineTier(bumped.importance, current.maturity),
          recency: bumped.recency,
          updateCount: bumped.updateCount,
        }
      })
    } catch (error) {
      warnSidecarFailure(logger, TOOL_MODE_CURATE_SITE, 'update', relPath, error)
    }

    return
  }

  try {
    await store.set(relPath, createDefaultRuntimeSignals())
  } catch (error) {
    warnSidecarFailure(logger, TOOL_MODE_CURATE_SITE, 'seed', relPath, error)
  }
}
