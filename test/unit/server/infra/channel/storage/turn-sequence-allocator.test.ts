import {expect} from 'chai'

import {TurnSequenceAllocator} from '../../../../../../src/server/infra/channel/storage/turn-sequence-allocator.js'

// Slice 2.0 — per-turn sequence allocator.
//
// Phase 1 hard-codes seq values at the call site (`postTurn` writes the
// user message at seq 0 and the terminal turn_state_change at seq 1). Phase
// 2's streaming + cancel paths interleave events from the orchestrator, the
// driver, the permission broker, and the cancel coordinator, so seq must
// come from a single authoritative source per turn.
//
// Contract:
//  - `next` returns 0, 1, 2, ... starting at 0 for an unseeded turn (matches
//    Phase 1's `postTurn` convention where the user-prompt message sits at
//    seq 0).
//  - `seed(lastSeq)` sets the counter so the NEXT call returns `lastSeq + 1`.
//    Used on cold start when replaying `events.jsonl`.
//  - `reset` removes the in-memory entry when a turn reaches terminal state.
//  - Concurrent `next` callers receive strictly monotonic, unique values.
describe('TurnSequenceAllocator', () => {
  let allocator: TurnSequenceAllocator

  beforeEach(() => {
    allocator = new TurnSequenceAllocator()
  })

  it('returns 0 on the first call for a fresh turn (matches Phase 1 seq-0 message)', () => {
    expect(allocator.next({channelId: 'ch', turnId: 't1'})).to.equal(0)
  })

  it('returns 0, 1, 2, ... in order for sequential calls', () => {
    expect(allocator.next({channelId: 'ch', turnId: 't1'})).to.equal(0)
    expect(allocator.next({channelId: 'ch', turnId: 't1'})).to.equal(1)
    expect(allocator.next({channelId: 'ch', turnId: 't1'})).to.equal(2)
  })

  it('keeps independent counters per (channelId, turnId)', () => {
    expect(allocator.next({channelId: 'ch-A', turnId: 't1'})).to.equal(0)
    expect(allocator.next({channelId: 'ch-B', turnId: 't1'})).to.equal(0)
    expect(allocator.next({channelId: 'ch-A', turnId: 't2'})).to.equal(0)
    expect(allocator.next({channelId: 'ch-A', turnId: 't1'})).to.equal(1)
  })

  it('seed sets the counter so the next call returns lastSeq + 1', () => {
    allocator.seed({channelId: 'ch', lastSeq: 4, turnId: 't1'})
    expect(allocator.next({channelId: 'ch', turnId: 't1'})).to.equal(5)
    expect(allocator.next({channelId: 'ch', turnId: 't1'})).to.equal(6)
  })

  it('reset removes the counter so a subsequent next starts again at 0', () => {
    allocator.next({channelId: 'ch', turnId: 't1'})
    allocator.next({channelId: 'ch', turnId: 't1'})
    allocator.reset({channelId: 'ch', turnId: 't1'})
    expect(allocator.next({channelId: 'ch', turnId: 't1'})).to.equal(0)
  })

  it('concurrent next calls for the same turn return monotonic unique values', async () => {
    const callers = Array.from({length: 100}, () =>
      Promise.resolve().then(() => allocator.next({channelId: 'ch', turnId: 't1'})),
    )
    const values = await Promise.all(callers)
    const sorted = [...values].sort((a, b) => a - b)
    // Strictly monotonic across the sorted view → all unique.
    for (const [index, value] of sorted.entries()) {
      expect(value).to.equal(index)
    }
  })
})
