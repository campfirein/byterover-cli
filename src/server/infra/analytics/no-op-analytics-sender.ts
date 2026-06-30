import type {StoredAnalyticsRecord} from '../../../shared/analytics/stored-record.js'
import type {IAnalyticsSender, SendResult} from '../../core/interfaces/analytics/i-analytics-sender.js'

/**
 * Semantically inert sender. `send()` returns both arrays empty, so when
 * M10.2's flush mirrors the result back to JSONL via
 * `updateStatus(succeeded, 'sent')` and `updateStatus(failed, 'failed')`,
 * both calls receive empty input and become no-ops. Pending JSONL rows
 * stay at `status='pending'`.
 *
 * Returning empty arrays — rather than echoing every input id as
 * `failed` — eliminates the data-loss hazard that would otherwise appear
 * if the flush scheduler runs without a working sender (M4.3 scheduler +
 * M4.2 HTTP sender). Scheduled ticks remain observable but non-destructive.
 *
 * Status (post-M4.2): no longer wired into the daemon — `HttpAnalyticsSender`
 * is the production default. Kept as a test seam: `analytics-client.test.ts`
 * uses it to assert the "leave-JSONL-untouched" invariant against the real
 * flush wiring, and future test harnesses (e.g. M4.3 scheduler tests) can
 * drop it in to isolate scheduling behavior from transport.
 */
export class NoOpAnalyticsSender implements IAnalyticsSender {
  public async send(_records: readonly StoredAnalyticsRecord[]): Promise<SendResult> {
    // M4.4 `AnalyticsSenderOptions` (signal) intentionally accepted by
    // the interface but ignored here — the no-op sender never reaches a
    // transport that could be cancelled. Omitting the parameter keeps
    // the structural-type assignment to `IAnalyticsSender` valid (optional
    // parameter).
    return {failed: [], succeeded: []}
  }
}
