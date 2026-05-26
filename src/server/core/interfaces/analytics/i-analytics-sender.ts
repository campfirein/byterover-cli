import type {StoredAnalyticsRecord} from '../../../../shared/analytics/stored-record.js'

/**
 * Classification of a failure mode, surfaced by `HttpAnalyticsSender` so
 * `AnalyticsClient` can feed it into the M4.5 backoff policy.
 *
 *   - `timeout`  - request exceeded the 5s budget. Transient → back off.
 *   - `network`  - connection refused / DNS / TLS / aborted. Transient → back off.
 *   - `http_5xx` - server error. Transient → back off.
 *   - `http_4xx` - backend rejected the payload shape. NOT transient — the
 *     caller MUST NOT advance backoff on 4xx; retrying won't help.
 */
export type SendFailureReason = 'http_4xx' | 'http_5xx' | 'network' | 'timeout'

/**
 * Per-send outcome. Each input record's `id` is mirrored back in exactly
 * one of `succeeded` / `failed`; M10.2's flush wiring will then translate
 * those id arrays into `JsonlAnalyticsStore.updateStatus` calls.
 *
 * Both arrays empty is a valid result and is what `NoOpAnalyticsSender`
 * returns — it leaves JSONL state untouched ("nothing was processed").
 */
export type SendResult = Readonly<{
  failed: string[]
  /**
   * Present only when `failed.length > 0`. Absent on success and on
   * empty-batch no-op calls. Callers that don't care about backoff
   * (no-op senders, tests) may continue to ignore this field.
   */
  reason?: SendFailureReason
  succeeded: string[]
}>

/**
 * Per-send options. `signal` is the M4.4 cancellation hook so the
 * AnalyticsClient can abort an in-flight send when `brv analytics
 * disable` fires.
 */
export type AnalyticsSenderOptions = Readonly<{
  signal?: AbortSignal
}>

/**
 * Daemon-side sender contract. M10.2's `AnalyticsClient.flush` invokes
 * `send()` with a snapshot of pending JSONL rows; the sender's only
 * responsibility is to attempt transmission and return the per-record
 * outcome as id arrays.
 *
 * Implementations:
 * - `HttpAnalyticsSender` (M4.2, production default): serializes records to
 *   the wire format and POSTs the batch to the telemetry backend.
 * - `NoOpAnalyticsSender`: semantically inert (`{succeeded: [], failed: []}`).
 *   Test seam — used to assert the M10.2 "leave-JSONL-untouched" invariant
 *   without going through the real transport.
 */
export interface IAnalyticsSender {
  /**
   * Attempts to ship `records`. Returns the per-record outcome as id arrays.
   * MUST NOT throw — analytics MUST NOT crash the daemon. Implementations
   * that hit a transient error (network failure, 5xx) should classify
   * those records as `failed` and let M9.2's retry-cap policy handle them.
   */
  send: (records: readonly StoredAnalyticsRecord[], options?: AnalyticsSenderOptions) => Promise<SendResult>
}
