import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  AnalyticsEvents,
  type AnalyticsStatusResponse,
} from '../../../../shared/transport/events/analytics-events.js'
import {
  buildAnalyticsStatusSnapshot,
  type BuildAnalyticsStatusSnapshotDeps,
} from '../../analytics/build-status-snapshot.js'

// Re-export the reachability mapper for back-compat with existing tests
// and any external consumer that depended on its prior location.
export {consecutiveFailuresToReachabilityState, type ReachabilityState} from '../../analytics/build-status-snapshot.js'

export interface AnalyticsStatusHandlerDeps extends BuildAnalyticsStatusSnapshotDeps {
  readonly transport: ITransportServer
}

/**
 * Composes the `analytics:status` wire response for `brv analytics
 * status` (M4.6). Delegates the actual snapshot composition to the
 * shared `buildAnalyticsStatusSnapshot` builder so the legacy transport
 * event and the new M16.3 settings handler share the same implementation.
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
    return buildAnalyticsStatusSnapshot(this.deps)
  }
}
