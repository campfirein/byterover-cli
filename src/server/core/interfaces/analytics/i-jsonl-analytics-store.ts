import type {StoredAnalyticsRecord, StoredStatus} from '../../../../shared/analytics/stored-record.js'

/**
 * Filter and pagination options for `list()`.
 *
 * `offset >= 0`, `limit >= 1`. Caller validates bounds (M11.1 transport
 * schema enforces `limit 1..200`); the store does not re-validate.
 */
export type JsonlAnalyticsStoreListOptions = {
  eventName?: string
  limit: number
  offset: number
  status?: StoredStatus
}

/**
 * Result of `list()`. `total` is the post-filter row count (NOT total file
 * rows), so a UI can render "showing X-Y of total" correctly.
 */
export type JsonlAnalyticsStoreListResult = Readonly<{
  rows: StoredAnalyticsRecord[]
  total: number
}>

/**
 * The two terminal/transitional statuses callers may write. `'pending'` is
 * the implicit initial state set by `append()` and is NEVER a valid input
 * to `updateStatus`.
 */
export type JsonlAnalyticsStoreUpdateStatus = 'failed' | 'sent'

/**
 * Daemon-side durable JSONL store for analytics records (M9.2).
 *
 * Contract:
 * - `append` is the only producer; new rows always start at
 *   `status='pending', attempts=0`.
 * - `updateStatus(ids, 'sent')` flips to terminal `'sent'` (no attempts
 *   change).
 * - `updateStatus(ids, 'failed')` is the **retry-cap gate**: increments
 *   `attempts` and only transitions to terminal `'failed'` once
 *   `attempts >= MAX_ATTEMPTS`; otherwise the row stays at `'pending'`
 *   so the next flush retries. Callers do NOT branch on the cap.
 * - `loadPending()` returns rows at `status='pending'` only (which under
 *   the cap policy includes both fresh `attempts=0` rows and in-flight
 *   `attempts=1..MAX_ATTEMPTS-1` retries).
 * - `list()` paginates with optional filters; sort order is
 *   `(timestamp DESC, id DESC)`.
 * - All mutating calls (`append`, `updateStatus`) serialize through a
 *   single in-process Promise chain on the store instance — concurrent
 *   `append` and `updateStatus` cannot lose rows.
 * - File-size cap with drop-oldest-sent-first compaction. Pending and
 *   failed rows are never dropped by compaction.
 */
export interface IJsonlAnalyticsStore {
  /**
   * Append a new record (`status='pending', attempts=0`) to the JSONL
   * file with fsync. If the file-size cap would be exceeded, oldest
   * `'sent'` rows are dropped first; if dropping every available `'sent'`
   * row still leaves the file over cap, the append throws
   * `JsonlCapFullError` after incrementing `droppedFullCount()`.
   *
   * The throw is the only signal callers have that the record did NOT land
   * on disk — needed so the in-memory mirror queue (`IAnalyticsQueue`) does
   * not push a record that JSONL never persisted (JSONL=truth invariant).
   * Callers that don't care MUST still catch: analytics MUST NOT crash
   * the consumer.
   */
  append: (record: StoredAnalyticsRecord) => Promise<void>

  /**
   * Truncate the JSONL file: drop every row regardless of status.
   *
   * M4.1: invoked when AuthStateStore reports a login/logout transition.
   * Pending events tracked under the prior session must NOT be flushed
   * under the new session's identity. Clearing on transition guarantees
   * the queue is homogeneous per session, every event in the queue at
   * flush time was tracked under the current auth state.
   *
   * Concurrency: serializes through the same write chain as `append` /
   * `updateStatus`, so an in-flight append finishes before clear runs and
   * a clear in progress blocks subsequent appends. Atomic via tmp+rename.
   *
   * Counters (`droppedFullCount`, `droppedSentCount`) are NOT reset,
   * they're cumulative lifetime stats surfaced by `brv analytics status`.
   */
  clear: () => Promise<void>

  /**
   * Cumulative count of `append` calls dropped because the cap was full
   * with no `'sent'` rows to evict (file saturated with pending+failed).
   * Never reset; surfaced for `brv analytics status` (M4.6).
   */
  droppedFullCount: () => number

  /**
   * Cumulative count of `'sent'` rows dropped by compaction across the
   * store's lifetime. Never reset; surfaced for `brv analytics status`
   * (M4.6).
   */
  droppedSentCount: () => number

  /**
   * Read paginated, filtered rows. Sort order is
   * `(timestamp DESC, id DESC)`. `total` is the post-filter row count.
   * Returns empty result when the file does not exist yet.
   */
  list: (opts: JsonlAnalyticsStoreListOptions) => Promise<JsonlAnalyticsStoreListResult>

  /**
   * Read all rows currently at `status='pending'`. Used by M10.2's
   * `flush()` as the source-of-truth for what to ship next. Returns
   * empty array when the file does not exist yet.
   */
  loadPending: () => Promise<StoredAnalyticsRecord[]>

  /**
   * Mirror a per-record send result back to disk.
   *
   * `'sent'`: flip `status` to `'sent'`. `attempts` unchanged.
   *
   * `'failed'`: increment `attempts`. If `attempts >= MAX_ATTEMPTS` the
   * row transitions to terminal `status='failed'`; otherwise stays at
   * `status='pending'` (next flush retries). A `'failed'` update on a
   * row already at terminal `status='failed'` is a no-op (no overshoot).
   *
   * Empty `ids` array is a no-op. Non-matching ids are silently ignored.
   */
  updateStatus: (ids: readonly string[], status: JsonlAnalyticsStoreUpdateStatus) => Promise<void>
}
