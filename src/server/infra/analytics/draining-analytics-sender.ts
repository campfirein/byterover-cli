import type {StoredAnalyticsRecord} from '../../../shared/analytics/stored-record.js'
import type {
  AnalyticsSenderOptions,
  IAnalyticsSender,
  SendResult,
} from '../../core/interfaces/analytics/i-analytics-sender.js'

/**
 * Draining sender: reports every input record as `succeeded` without any
 * network I/O, so the flush wiring transitions the matching JSONL rows to
 * `status='sent'` and the pending count stays at 0.
 *
 * `wireAnalyticsHttpSender` swaps this in when `BRV_ANALYTICS_BASE_URL`
 * resolves to `undefined` (absent, empty after trim, or malformed). No HTTP
 * client is constructed; the axios layer is never touched, so a misconfigured
 * build never burns retries or leaks events into the upstream backend. This
 * optimizes for the "never ship" case (open-source forks, CI, air-gapped
 * installs).
 *
 * Contrast with the test-seam `NoOpAnalyticsSender` (no-op-analytics-sender.ts),
 * which returns BOTH arrays empty so the JSONL rows stay `pending` — used by
 * tests to assert the "leave-JSONL-untouched" invariant; never wired in
 * production. The behavioural name `Draining` is deliberately distinct from
 * the test seam's `NoOp` so the production wiring can never grab the wrong
 * sender (the prior `Noop`/`NoOp` pair differed by a single letter).
 */
export class DrainingAnalyticsSender implements IAnalyticsSender {
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
