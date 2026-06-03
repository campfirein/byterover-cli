/** Arguments identifying the per-turn sequence stream. */
export type TurnSequenceKey = {
  readonly channelId: string
  readonly turnId: string
}

/**
 * Allocates the gap-free monotonic `seq` the orchestrator stamps onto every
 * persisted turn event. Sequencing is per-turn (each turn starts at 0) and must
 * come from a single writer so transcript ordering is well-defined.
 */
export interface ITurnSequenceAllocator {
  /** Returns the next sequence number for this turn (0, 1, 2, …). */
  next(key: TurnSequenceKey): number
  /** Clears the counter for this turn (call at dispatch start and on finalise). */
  reset(key: TurnSequenceKey): void
}
