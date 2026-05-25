import {expect} from 'chai'

import {ChannelWriteSerializer} from '../../../../../../src/server/infra/channel/storage/write-serializer.js'

// Slice 1.3 — per-turn write lock so concurrent appends + the one-shot
// finalise snapshot serialise (CHANNEL_PROTOCOL.md §4.2; Phase 1 DoD §3).
//
// Phase 1 only exercises the lock from passive `channel:post` (one writer
// per turn), but the append-vs-finalise race test in
// `test/integration/channel-phase1-append-finalize-race.test.ts` requires
// the lock to handle concurrent calls across DIFFERENT turns in parallel
// while serialising calls to the SAME turn.
describe('ChannelWriteSerializer', () => {
  let serializer: ChannelWriteSerializer

  beforeEach(() => {
    serializer = new ChannelWriteSerializer()
  })

  it('serialises concurrent writes to the same turn key', async () => {
    const order: number[] = []
    const start = (n: number, delayMs: number) =>
      serializer.withLock('ch-1:turn-A', async () => {
        order.push(n)
        await new Promise((r) => { setTimeout(r, delayMs) })
        order.push(-n)
      })

    await Promise.all([start(1, 20), start(2, 5), start(3, 1)])

    // Each task must complete (push -n) before the next one starts (push n+1).
    // Legal interleavings are [1, -1, 2, -2, 3, -3] or any permutation that
    // respects "n must be followed immediately by -n".
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i]).to.equal(-order[i + 1])
    }
  })

  it('allows writes to different turn keys to run in parallel', async () => {
    let aStarted = false
    let aResolved = false
    let bStarted = false

    const aDone = serializer.withLock('ch-1:turn-A', async () => {
      aStarted = true
      // Hold the lock briefly to give B a chance to start in parallel.
      await new Promise((r) => { setTimeout(r, 30) })
      aResolved = true
    })

    // Give A a tick to enter the critical section.
    await new Promise((r) => { setTimeout(r, 5) })
    expect(aStarted).to.equal(true)
    expect(aResolved).to.equal(false)

    const bDone = serializer.withLock('ch-1:turn-B', async () => {
      bStarted = true
    })

    await bDone
    // B should have completed while A was still holding its OWN lock.
    expect(bStarted).to.equal(true)
    expect(aResolved).to.equal(false)

    await aDone
    expect(aResolved).to.equal(true)
  })

  it('propagates the inner result back to the caller', async () => {
    const result = await serializer.withLock('ch-1:turn-A', async () => 42)
    expect(result).to.equal(42)
  })

  it('releases the lock when the inner function throws', async () => {
    await serializer
      .withLock('ch-1:turn-A', async () => {
        throw new Error('boom')
      })
      .catch((error) => {
        expect((error as Error).message).to.equal('boom')
      })

    // The next call MUST run; if the lock leaked, this would hang and time out.
    const result = await serializer.withLock('ch-1:turn-A', async () => 'recovered')
    expect(result).to.equal('recovered')
  })
})
