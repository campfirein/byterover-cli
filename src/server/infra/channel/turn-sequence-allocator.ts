import type {ITurnSequenceAllocator, TurnSequenceKey} from '../../core/interfaces/channel/i-turn-sequence-allocator.js'

/**
 * In-memory {@link ITurnSequenceAllocator}. Holds one counter per
 * `(channelId, turnId)` so concurrent turns never share a sequence stream.
 */
export class TurnSequenceAllocator implements ITurnSequenceAllocator {
  private readonly counters = new Map<string, number>()

  private static key(key: TurnSequenceKey): string {
    return `${key.channelId}\0${key.turnId}`
  }

  next(key: TurnSequenceKey): number {
    const k = TurnSequenceAllocator.key(key)
    const current = this.counters.get(k) ?? 0
    this.counters.set(k, current + 1)
    return current
  }

  reset(key: TurnSequenceKey): void {
    this.counters.delete(TurnSequenceAllocator.key(key))
  }
}
