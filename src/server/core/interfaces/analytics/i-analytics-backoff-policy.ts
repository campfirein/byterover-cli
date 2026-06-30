/**
 * M4.5 failure-resilience policy for the analytics flush scheduler.
 *
 * Pure in-memory state — no persistence. A daemon restart starts from
 * the base interval; passive failure tracking is the goal, not exact
 * accounting across restarts.
 *
 * Backoff schedule: `30s → 60s → 2m → 5m`, cap at `5m`. First success
 * resets to `30s`. The schedule lives inside the implementation; this
 * interface only exposes the next effective delay and the state-mutation
 * callbacks.
 *
 * The reachability state (healthy / degraded / unreachable) used by
 * `brv settings get analytics.status` (M4.6) is DERIVED from `consecutiveFailures()`
 * by the caller, not exposed here. Mapping (M4.6 owns the labels):
 *   - 0 failures → healthy
 *   - 1-2 failures → degraded
 *   - 3+ failures → unreachable
 */
export interface IAnalyticsBackoffPolicy {
  /**
   * M5.4 (ENG-2658): honor a server-supplied retry delay (HTTP 429
   * `Retry-After`, or a 503 from the nginx edge backstop). Overrides the
   * next effective delay with `max(retryAfterMs, scheduled delay)` so a
   * misbehaving server can never pull retries below the safe minimum, and
   * marks the policy rate-limited (see `isRateLimited()`). Does NOT advance
   * `consecutiveFailures()` — a throttled endpoint is reachable, not failing,
   * so it must never tip the daemon into the "unreachable" reachability band.
   * Cleared by the next `onSuccess()` or `onFailure()`.
   */
  applyServerHint(retryAfterMs: number): void

  /**
   * Number of failures since the last `onSuccess()`. Unbounded — used
   * by M4.6 to classify reachability beyond the backoff cap (a daemon
   * that has been offline for hours should display "unreachable", not
   * just "delay capped at 5m").
   */
  consecutiveFailures(): number

  /**
   * M5.4 (ENG-2658): true while the last flush outcome was a server-driven
   * rate-limit (429/503) and no success/failure has cleared it since. The
   * M4.6 status snapshot maps this to a distinct `rate_limited` reachability
   * state so on-call can tell throttling apart from an unreachable backend.
   */
  isRateLimited(): boolean

  /**
   * Effective next-tick delay in milliseconds. Reading this method is
   * pure: it does NOT advance the schedule. Callers should treat the
   * value as live (read at arm-time) so a concurrent success-or-failure
   * between two reads picks up correctly.
   */
  nextDelayMs(): number

  /**
   * Record a transient failure (HTTP 5xx, timeout, network). Advances
   * the schedule one step, up to the cap. `http_4xx` is a payload-shape
   * problem, not a transient signal — callers MUST NOT call this for 4xx.
   */
  onFailure(): void

  /**
   * Record a successful flush. Resets the schedule and the consecutive
   * counter to zero immediately, regardless of prior peak.
   */
  onSuccess(): void
}
