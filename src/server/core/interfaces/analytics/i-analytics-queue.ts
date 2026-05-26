import type {StoredAnalyticsRecord} from '../../../../shared/analytics/stored-record.js'

/**
 * In-memory queue contract for identity-stamped analytics records.
 * Implementations enforce a configurable cap with drop-oldest semantics
 * and track a cumulative dropped count for later observability.
 *
 * Carries `StoredAnalyticsRecord` (with `id`/`status`/`attempts` local
 * metadata) since M9.3 — JSONL is the durable source of truth and the
 * queue is a fast in-memory mirror. M10.2's `flush()` reads from JSONL
 * (not this queue), so any drop-oldest eviction here is recoverable.
 */
export interface IAnalyticsQueue {
  /**
   * Drains the queue and returns the records in FIFO order. Caller takes
   * ownership; the queue is empty afterwards. `droppedCount()` is NOT
   * reset by this call.
   */
  drain: () => StoredAnalyticsRecord[]

  /**
   * Returns the cumulative number of records dropped due to the cap
   * across the queue's lifetime. Never reset.
   */
  droppedCount: () => number

  /**
   * Pushes a record onto the queue. If the queue is at capacity, the
   * oldest record is dropped to make room and `droppedCount()` is
   * incremented.
   */
  push: (record: StoredAnalyticsRecord) => void

  /**
   * Returns the current number of records in the queue.
   */
  size: () => number
}
