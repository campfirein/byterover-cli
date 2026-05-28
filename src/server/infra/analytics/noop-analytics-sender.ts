import type {StoredAnalyticsRecord} from '../../../shared/analytics/stored-record.js'
import type {
  AnalyticsSenderOptions,
  IAnalyticsSender,
  SendResult,
} from '../../core/interfaces/analytics/i-analytics-sender.js'

/**
 * Graceful-degradation sender. `wireAnalyticsHttpSender` swaps this in
 * when `BRV_ANALYTICS_BASE_URL` resolves to `undefined` (absent, empty
 * after trim, or malformed). No HTTP client is constructed; the axios
 * layer is never touched, so a misconfigured build never burns retries
 * or leaks events into the upstream backend.
 *
 * Every input record is reported as `succeeded` so the flush wiring
 * transitions the matching JSONL rows to `status='sent'` and the
 * pending count stays at 0. This drains the queue and optimizes for the
 * "never ship" case (open-source forks, CI, air-gapped installs).
 *
 * Contrast with the test-seam `NoOpAnalyticsSender` at
 * `no-op-analytics-sender.ts`:
 *   - `NoOpAnalyticsSender`   - both arrays empty, JSONL stays pending.
 *                               Used by tests to assert the
 *                               "leave-JSONL-untouched" invariant; NOT
 *                               wired in production.
 *   - `NoopAnalyticsSender`   - this class. Marks all-succeeded, JSONL
 *                               drains. Wired in production whenever
 *                               the env var is absent or unusable.
 */
export class NoopAnalyticsSender implements IAnalyticsSender {
  public async send(
    records: readonly StoredAnalyticsRecord[],
    _options?: AnalyticsSenderOptions,
  ): Promise<SendResult> {
    // `_options.signal` intentionally ignored: there is no transport to
    // cancel. Accepting the parameter keeps structural assignability to
    // `IAnalyticsSender` clean.
    return {failed: [], succeeded: records.map((record) => record.id)}
  }
}
