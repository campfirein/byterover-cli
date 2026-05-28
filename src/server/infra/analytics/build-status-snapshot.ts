import type {AnalyticsStatusResponse} from '../../../shared/transport/events/analytics-events.js'
import type {IAnalyticsBackoffPolicy} from '../../core/interfaces/analytics/i-analytics-backoff-policy.js'
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'

/**
 * User-facing reachability label derived from the M4.5 backoff policy's
 * `consecutiveFailures()` counter. Boundaries fixed by the M4.6 ticket:
 *   - 0 failures      -> healthy
 *   - 1 or 2 failures -> degraded
 *   - 3+ failures     -> unreachable
 *
 * The mapper is pure (presentation layer) so the policy stays free of
 * UX concerns and so non-status consumers of `consecutiveFailures()`
 * can apply different labels if needed.
 *
 * Defensive on invalid input: negative or NaN inputs return 'healthy'
 * (the most optimistic label) rather than throw, so a malformed counter
 * never breaks the status command's hot path.
 */
export type ReachabilityState = 'degraded' | 'healthy' | 'unreachable'

export function consecutiveFailuresToReachabilityState(consecutiveFailures: number): ReachabilityState {
  if (!Number.isFinite(consecutiveFailures) || consecutiveFailures < 1) return 'healthy'
  if (consecutiveFailures < 3) return 'degraded'
  return 'unreachable'
}

const NOT_CONFIGURED_ENDPOINT = '(not configured)'

export interface BuildAnalyticsStatusSnapshotDeps {
  readonly analyticsClient: IAnalyticsClient
  readonly backoffPolicy: IAnalyticsBackoffPolicy
  /**
   * Resolved `BRV_ANALYTICS_BASE_URL`. Empty string when the env var
   * isn't set; the builder substitutes the `(not configured)` placeholder
   * AND forces `backoff.state = 'unreachable'` to reflect that no real
   * health signal is possible.
   */
  readonly endpoint: string
  readonly isAnalyticsEnabled: () => boolean
}

/**
 * Composes the analytics-status wire response from runtime state, backoff
 * state, endpoint, and the enabled flag.
 *
 * Shared between the legacy `analytics:status` transport event (M4.6
 * `AnalyticsStatusHandler`) and the new `settings:get` / `settings:list`
 * routing for the `analytics.status` readonly-info descriptor (M16.3).
 *
 * Pure async function — no transport, no side effects. Throwing is fatal
 * to the caller; the M16.1 `SettingsHandler` LIST path isolates per-row
 * provider errors via `Promise.allSettled`-style catching, so a transient
 * failure here surfaces as `current: undefined` on the row rather than
 * blanking the whole settings response.
 */
export async function buildAnalyticsStatusSnapshot(
  deps: BuildAnalyticsStatusSnapshotDeps,
): Promise<AnalyticsStatusResponse> {
  const runtime = await deps.analyticsClient.getRuntimeState()
  const consecutiveFailures = deps.backoffPolicy.consecutiveFailures()
  const nextDelayMs = deps.backoffPolicy.nextDelayMs()
  const endpointConfigured = deps.endpoint !== ''
  const endpoint = endpointConfigured ? deps.endpoint : NOT_CONFIGURED_ENDPOINT
  // M4.6 override: when no endpoint is configured the daemon has
  // nothing to be "healthy" against — surface unreachable so the user
  // doesn't see a misleading "healthy" label paired with "(not configured)".
  const state: ReachabilityState = endpointConfigured
    ? consecutiveFailuresToReachabilityState(consecutiveFailures)
    : 'unreachable'

  return {
    backoff: {consecutiveFailures, nextDelayMs, state},
    droppedCount: runtime.droppedCount,
    enabled: deps.isAnalyticsEnabled(),
    endpoint,
    ...(runtime.lastSuccessfulFlushAt === undefined ? {} : {lastFlushAt: runtime.lastSuccessfulFlushAt}),
    queueDepth: runtime.queueDepth,
  }
}
