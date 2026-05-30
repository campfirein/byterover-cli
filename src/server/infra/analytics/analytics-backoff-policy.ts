import type {IAnalyticsBackoffPolicy} from '../../core/interfaces/analytics/i-analytics-backoff-policy.js'

// Schedule fixed by the M4.5 ticket: 30s, 60s, 2m, 5m, capped at 5m.
// Index = consecutiveFailures clamped to [0, length - 1].
const BACKOFF_STEPS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000]

// M5.4 (ENG-2658): upper bound on an honored server Retry-After. A hint above
// this is clamped down. Rationale: (1) well under Node's setTimeout ceiling
// (2^31-1 ms ≈ 24.8 days), past which a delay silently overflows and fires
// immediately — which would IGNORE the rate-limit; (2) a throttle window longer
// than an hour is unreasonable for opt-in telemetry and would otherwise stall
// shipping for days. The lower bound is handled separately by `nextDelayMs`'s
// max() with the schedule.
const MAX_SERVER_HINT_MS = 3_600_000 // 1 hour

/**
 * In-memory exponential-backoff policy. See `IAnalyticsBackoffPolicy`
 * for the contract.
 *
 * Single private counter `failures` is the load-bearing state. The
 * schedule lookup is a clamped index into `BACKOFF_STEPS_MS`, so the
 * cap behavior falls out of the data shape rather than a separate
 * conditional.
 *
 * Not thread-safe. The daemon runs in a single Node event loop; the
 * scheduler's serialized tick chain is the only writer.
 */
export class AnalyticsBackoffPolicy implements IAnalyticsBackoffPolicy {
  private failures = 0
  // M5.4: true while the last outcome was a server-driven rate-limit. Distinct
  // from `failures` because a throttled endpoint is reachable, not failing.
  private rateLimited = false
  // M5.4 (ENG-2658): one-shot server-supplied delay from a 429 `Retry-After`
  // or a 503 edge backstop. `undefined` = no active hint. Cleared on the next
  // success or transient failure so it never outlives the rate-limit window.
  private serverHintMs: number | undefined = undefined

  public applyServerHint(retryAfterMs: number): void {
    // Ignore a non-positive / NaN hint for the delay floor (a bad server value
    // must not shorten the wait), and clamp an absurdly large one to the safe
    // maximum (a bad value must not overflow setTimeout or stall shipping for
    // days). Either way, record that we were rate-limited.
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.serverHintMs = Math.min(retryAfterMs, MAX_SERVER_HINT_MS)
    }

    this.rateLimited = true
  }

  public consecutiveFailures(): number {
    return this.failures
  }

  public isRateLimited(): boolean {
    return this.rateLimited
  }

  public nextDelayMs(): number {
    const index = Math.min(this.failures, BACKOFF_STEPS_MS.length - 1)
    // Take the larger of the scheduled delay and any server hint so a server
    // can stretch the wait but never accelerate it below the safe minimum.
    return Math.max(BACKOFF_STEPS_MS[index], this.serverHintMs ?? 0)
  }

  public onFailure(): void {
    this.failures += 1
    // A genuine transient failure supersedes any prior rate-limit hint: resume
    // the pure exponential schedule rather than honoring a stale 429 delay.
    this.serverHintMs = undefined
    this.rateLimited = false
  }

  public onSuccess(): void {
    this.failures = 0
    this.serverHintMs = undefined
    this.rateLimited = false
  }
}
