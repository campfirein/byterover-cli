import type {StoredAnalyticsRecord} from '../../../shared/analytics/stored-record.js'
import type {IAnalyticsQueue} from '../../core/interfaces/analytics/i-analytics-queue.js'

const DEFAULT_MAX_SIZE = 1000

/**
 * In-memory bounded queue with drop-oldest semantics. Newest pushes
 * always succeed; if the queue is at capacity, the oldest record is
 * removed first. `droppedCount` is cumulative across the queue's
 * lifetime — neither `drain` nor any other method resets it.
 *
 * Backing store is a plain Array; at the default `maxSize` of 1000 the
 * O(n) cost of `Array.prototype.shift()` on overflow is negligible.
 *
 * Since M9.3 the queue carries `StoredAnalyticsRecord` (with `id` local
 * metadata) as a fast in-memory mirror of the JSONL source-of-truth.
 * Drop-oldest evictions here are recoverable because M10.2's `flush()`
 * reads from JSONL, not from this queue.
 */
export class BoundedQueue implements IAnalyticsQueue {
  private dropped = 0
  private readonly maxSize: number
  private records: StoredAnalyticsRecord[] = []

  public constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    if (!Number.isInteger(maxSize) || maxSize < 0) {
      throw new Error(`BoundedQueue maxSize must be a non-negative integer; got ${maxSize}`)
    }

    this.maxSize = maxSize
  }

  public drain(): StoredAnalyticsRecord[] {
    const drained = this.records
    this.records = []
    return drained
  }

  public droppedCount(): number {
    return this.dropped
  }

  public push(record: StoredAnalyticsRecord): void {
    this.records.push(record)
    while (this.records.length > this.maxSize) {
      this.records.shift()
      this.dropped++
    }
  }

  public size(): number {
    return this.records.length
  }
}
