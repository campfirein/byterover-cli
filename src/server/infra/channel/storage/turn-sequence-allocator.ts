import type {
  ITurnSequenceAllocator,
  SeedArgs,
  TurnSequenceKey,
} from '../../../core/interfaces/channel/i-turn-sequence-allocator.js'

/**
 * In-memory allocator for per-turn monotonic seq values.
 *
 * Implementation notes:
 *  - `next` and `seed` are synchronous and not interleaved by the event loop
 *    between read and write, so concurrent callers (resolved via micro-task
 *    queue) each see a distinct counter value. The integration tests in
 *    Slice 2.4 exercise the contention path.
 *  - The state is intentionally in-process; on daemon restart the
 *    orchestrator seeds from disk via {@link seed}.
 */
export class TurnSequenceAllocator implements ITurnSequenceAllocator {
  // Stores the LAST returned seq per `(channelId, turnId)`. Absence means
  // the next call should return 0.
  private readonly lastSeqByKey = new Map<string, number>()

  private static toMapKey(key: TurnSequenceKey): string {
    return `${key.channelId}:${key.turnId}`
  }

  next(key: TurnSequenceKey): number {
    const mapKey = TurnSequenceAllocator.toMapKey(key)
    const previous = this.lastSeqByKey.get(mapKey)
    const next = previous === undefined ? 0 : previous + 1
    this.lastSeqByKey.set(mapKey, next)
    return next
  }

  reset(key: TurnSequenceKey): void {
    this.lastSeqByKey.delete(TurnSequenceAllocator.toMapKey(key))
  }

  seed(args: SeedArgs): void {
    this.lastSeqByKey.set(TurnSequenceAllocator.toMapKey(args), args.lastSeq)
  }
}
