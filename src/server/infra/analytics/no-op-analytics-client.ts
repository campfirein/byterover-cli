import type {AnalyticsEventName} from '../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../shared/analytics/events/index.js'
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'

import {AnalyticsBatch} from '../../core/domain/analytics/batch.js'

/**
 * Default analytics client used by the daemon before the real client is
 * wired (M2.5) and by tests that need a stand-in. `track()` is a true
 * no-op — no buffering, no resolver calls; `flush()` always resolves to
 * an empty batch.
 */
export class NoOpAnalyticsClient implements IAnalyticsClient {
  public abort(): void {
    // intentional no-op — no in-flight flush to cancel.
  }

  public async flush(): Promise<AnalyticsBatch> {
    return AnalyticsBatch.create([])
  }

  public async getRuntimeState(): Promise<{
    droppedCount: number
    lastSuccessfulFlushAt: number | undefined
    queueDepth: number
  }> {
    return {droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}
  }

  public async onAuthTransition(): Promise<void> {
    // intentional no-op
  }

  public track<E extends AnalyticsEventName>(_event: E, ..._rest: PropsArg<E>): void {
    // intentional no-op
  }
}
