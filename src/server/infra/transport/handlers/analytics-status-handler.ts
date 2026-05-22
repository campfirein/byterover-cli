import type {IAnalyticsBackoffPolicy} from '../../../core/interfaces/analytics/i-analytics-backoff-policy.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  AnalyticsEvents,
  type AnalyticsStatusResponse,
} from '../../../../shared/transport/events/analytics-events.js'

/**
 * User-facing reachability label derived from the M4.5 backoff policy's
 * `consecutiveFailures()` counter. Boundaries fixed by the M4.6 ticket:
 *   - 0 failures      → healthy
 *   - 1 or 2 failures → degraded
 *   - 3+ failures     → unreachable
 *
 * The mapper is pure and lives here (presentation layer) rather than in
 * the policy itself, so the policy stays free of UX concerns and so
 * non-status consumers of `consecutiveFailures()` can apply different
 * labels if needed.
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

export interface AnalyticsStatusHandlerDeps {
  readonly analyticsClient: IAnalyticsClient
  readonly backoffPolicy: IAnalyticsBackoffPolicy
  /**
   * Resolved `BRV_ANALYTICS_BASE_URL`. Empty string when the env var
   * isn't set; the handler substitutes the `(not configured)` placeholder
   * AND forces `backoff.state = 'unreachable'` to reflect that no real
   * health signal is possible.
   */
  readonly endpoint: string
  readonly isAnalyticsEnabled: () => boolean
  readonly transport: ITransportServer
}

/**
 * Composes the `analytics:status` wire response for `brv analytics
 * status` (M4.6). Pulls together:
 *   - enabled flag (GlobalConfigHandler's cached value)
 *   - client runtime state (last-flush ts, queue depth, dropped count)
 *   - backoff state (M4.5 policy + derived reachability label)
 *   - endpoint URL (or placeholder when unset)
 *
 * Kept as a focused handler rather than extending the existing
 * `AnalyticsHandler` so the track/list domain stays clean and the
 * status surface can evolve (M4.6 may grow more fields) without
 * accreting unrelated dependencies on the track handler's class.
 */
export class AnalyticsStatusHandler {
  private readonly deps: AnalyticsStatusHandlerDeps

  public constructor(deps: AnalyticsStatusHandlerDeps) {
    this.deps = deps
  }

  public setup(): void {
    this.deps.transport.onRequest<void, AnalyticsStatusResponse>(AnalyticsEvents.STATUS, async () => this.compose())
  }

  /**
   * Compose the wire payload. Visible for tests; production caller is
   * the transport handler registered in `setup()`.
   */
  private async compose(): Promise<AnalyticsStatusResponse> {
    const runtime = await this.deps.analyticsClient.getRuntimeState()
    const consecutiveFailures = this.deps.backoffPolicy.consecutiveFailures()
    const nextDelayMs = this.deps.backoffPolicy.nextDelayMs()
    const endpointConfigured = this.deps.endpoint !== ''
    const endpoint = endpointConfigured ? this.deps.endpoint : NOT_CONFIGURED_ENDPOINT
    // M4.6 override: when no endpoint is configured the daemon has
    // nothing to be "healthy" against — surface unreachable so the user
    // doesn't see a misleading "healthy" label paired with "(not configured)".
    const state: ReachabilityState = endpointConfigured
      ? consecutiveFailuresToReachabilityState(consecutiveFailures)
      : 'unreachable'

    return {
      backoff: {consecutiveFailures, nextDelayMs, state},
      droppedCount: runtime.droppedCount,
      enabled: this.deps.isAnalyticsEnabled(),
      endpoint,
      ...(runtime.lastSuccessfulFlushAt === undefined ? {} : {lastFlushAt: runtime.lastSuccessfulFlushAt}),
      queueDepth: runtime.queueDepth,
    }
  }
}
