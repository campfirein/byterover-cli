import type {IAnalyticsBackoffPolicy} from '../../core/interfaces/analytics/i-analytics-backoff-policy.js'

// Schedule fixed by the M4.5 ticket: 30s, 60s, 2m, 5m, capped at 5m.
// Index = consecutiveFailures clamped to [0, length - 1].
const BACKOFF_STEPS_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000]

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

  public consecutiveFailures(): number {
    return this.failures
  }

  public nextDelayMs(): number {
    const index = Math.min(this.failures, BACKOFF_STEPS_MS.length - 1)
    return BACKOFF_STEPS_MS[index]
  }

  public onFailure(): void {
    this.failures += 1
  }

  public onSuccess(): void {
    this.failures = 0
  }
}
