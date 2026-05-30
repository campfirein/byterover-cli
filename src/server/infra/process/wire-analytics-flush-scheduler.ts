import type {IAnalyticsBackoffPolicy} from '../../core/interfaces/analytics/i-analytics-backoff-policy.js'
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {IAnalyticsQueue} from '../../core/interfaces/analytics/i-analytics-queue.js'
import type {IJsonlAnalyticsStore} from '../../core/interfaces/analytics/i-jsonl-analytics-store.js'

import {AnalyticsFlushScheduler} from '../analytics/analytics-flush-scheduler.js'

export type AnalyticsFlushSchedulerWiring = {
  analyticsClient: IAnalyticsClient
  /**
   * M4.5: optional backoff policy. When wired, the scheduler arms its
   * next tick from `policy.nextDelayMs()` so a failing backend stretches
   * the inter-tick gap to 60s → 2m → 5m (capped). The `AnalyticsClient`
   * already feeds this same policy from inside `runFlush`, so the
   * scheduler just reads the live value.
   *
   * Omitted in tests / dev experiments → scheduler keeps its fixed
   * 30s default.
   */
  backoffPolicy?: IAnalyticsBackoffPolicy
  isEnabled: () => boolean
  /**
   * JSONL store used to count pending rows for the empty-skip gate. The
   * scheduler uses `loadPending().length` (NOT `queue.size()`) because
   * the in-memory queue mirror never decrements after a successful flush,
   * which would make the interval timer fire 30s indefinitely with
   * nothing left to ship.
   */
  jsonlStore: IJsonlAnalyticsStore
  /**
   * Direct override for the per-tick delay. Tests pass a closure to
   * exercise dynamic intervals without standing up a real policy.
   * Production code should pass `backoffPolicy` instead.
   *
   * If both `backoffPolicy` and `nextIntervalMs` are wired,
   * `backoffPolicy` wins.
   */
  nextIntervalMs?: () => number
  queue: IAnalyticsQueue
  /** Override the 20-event threshold (default) for tests / dev experiments. */
  thresholdCount?: number
}

/**
 * Compose the M4.3 flush scheduler.
 *
 * The scheduler is the orchestrator that decides WHEN to flush; it
 * delegates the actual flush work to `IAnalyticsClient.flush()`. Two
 * triggers (whichever first):
 *   - 30s interval timer
 *   - 20-event queue depth
 *
 * Returned `AnalyticsFlushScheduler` is owned by the composition root:
 *   - call `start()` after the AnalyticsClient is wired (so the first
 *     tick has a working sender).
 *   - call `stop()` in the shutdown sequence before `flushFinal()` so
 *     no new ticks fire mid-shutdown.
 *
 * Extracted from `feature-handlers.ts` so the wiring is testable in
 * isolation — mirrors the M4.1 / M4.2 wiring helper pattern.
 */
export function wireAnalyticsFlushScheduler(
  wiring: AnalyticsFlushSchedulerWiring,
): AnalyticsFlushScheduler {
  // M4.5 precedence: a real backoffPolicy wins over a literal
  // nextIntervalMs override. This keeps test ergonomics simple
  // (pass `nextIntervalMs: () => 50` for fast tests) while production
  // wiring (`backoffPolicy` only) reads the policy at arm-time.
  // Capture `policy` in a const so the arrow closure keeps the narrowed
  // type (avoiding the `!` non-null assertion that CLAUDE.md discourages).
  const policy = wiring.backoffPolicy
  const nextIntervalMs = policy === undefined ? wiring.nextIntervalMs : (): number => policy.nextDelayMs()
  return new AnalyticsFlushScheduler({
    flush: () => wiring.analyticsClient.flush(),
    isEnabled: wiring.isEnabled,
    // M5.4 (ENG-2658): wire the burst-trigger rate-limit gate to the policy so a
    // 429/503 suppresses threshold flushes (the stretched periodic tick ships
    // the backlog). Omitted when there's no policy; the scheduler then defaults
    // to never-rate-limited.
    ...(policy === undefined ? {} : {isRateLimited: (): boolean => policy.isRateLimited()}),
    ...(nextIntervalMs === undefined ? {} : {nextIntervalMs}),
    pendingCount: async () => (await wiring.jsonlStore.loadPending()).length,
    queueSize: () => wiring.queue.size(),
    ...(wiring.thresholdCount === undefined ? {} : {thresholdCount: wiring.thresholdCount}),
  })
}
