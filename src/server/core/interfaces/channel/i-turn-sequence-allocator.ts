/**
 * Per-turn monotonic sequence allocator (Phase 2, Slice 2.0).
 *
 * Phase 1 hard-coded seq values at the call site (`postTurn` writes the user
 * message at seq 0 and the terminal `turn_state_change` at seq 1). Phase 2's
 * streaming + cancel paths interleave events from the orchestrator, the
 * driver, the permission broker, and the cancel coordinator, so seq must
 * come from a single authoritative source per `(channelId, turnId)`.
 *
 * Contract:
 *  - `next` returns 0 on the first call for an unseeded turn so the
 *    user-prompt `message` event still lands at seq 0 (matches Phase 1's
 *    `postTurn` shape so replay parity is preserved across passive + active
 *    turns).
 *  - `seed(lastSeq)` makes the next `next` call return `lastSeq + 1`. Used
 *    on cold start when the orchestrator replays `events.jsonl`.
 *  - `reset` drops the in-memory counter when a turn reaches terminal state.
 */
export type TurnSequenceKey = {
  readonly channelId: string
  readonly turnId: string
}

export type SeedArgs = TurnSequenceKey & {
  readonly lastSeq: number
}

export interface ITurnSequenceAllocator {
  next(key: TurnSequenceKey): number
  reset(key: TurnSequenceKey): void
  seed(args: SeedArgs): void
}
