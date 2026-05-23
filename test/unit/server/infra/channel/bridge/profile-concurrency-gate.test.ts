import {expect} from 'chai'

import {createProfileConcurrencyGate} from '../../../../../../src/server/infra/channel/bridge/profile-concurrency-gate.js'

// Phase 9.5.3 — unit tests for the per-profile concurrency semaphore.

describe('ProfileConcurrencyGate (phase 9.5.3)', () => {
  it('acquire/release single profile — resolve immediately when cap not reached', async () => {
    const gate = createProfileConcurrencyGate({maxConcurrent: 2})
    const release = await gate.acquire('profile-a')
    expect(release).to.be.a('function')
    release()
  })

  it('concurrent acquires within cap all resolve immediately', async () => {
    const gate = createProfileConcurrencyGate({maxConcurrent: 3})
    const releases = await Promise.all([
      gate.acquire('x'),
      gate.acquire('x'),
      gate.acquire('x'),
    ])
    expect(releases).to.have.lengthOf(3)
    for (const r of releases) r()
  })

  it('acquires beyond cap queue and resolve in order', async () => {
    const gate = createProfileConcurrencyGate({maxConcurrent: 1})

    const order: number[] = []

    // Acquire the single slot.
    const release1 = await gate.acquire('p')

    // Two more acquires queue up — they don't resolve yet.
    const p2 = gate.acquire('p').then((r) => {
      order.push(2)
      return r
    })
    const p3 = gate.acquire('p').then((r) => {
      order.push(3)
      return r
    })

    // Nothing resolved yet.
    expect(order).to.deep.equal([])

    // Release 1 — p2 should now resolve.
    release1()
    const release2 = await p2
    expect(order).to.deep.equal([2])

    // Release 2 — p3 should now resolve.
    release2()
    const release3 = await p3
    expect(order).to.deep.equal([2, 3])
    release3()
  })

  it('different profiles do not block each other', async () => {
    const gate = createProfileConcurrencyGate({maxConcurrent: 1})

    // Fill profile-a's single slot.
    const releaseA = await gate.acquire('profile-a')

    // profile-b should still resolve immediately.
    const releaseB = await gate.acquire('profile-b')
    expect(releaseB).to.be.a('function')

    releaseA()
    releaseB()
  })

  it('release is idempotent — calling twice does not corrupt in-flight count', async () => {
    const gate = createProfileConcurrencyGate({maxConcurrent: 1})
    const release = await gate.acquire('q')
    release()
    release() // second call is a no-op

    // Should be able to acquire again without hanging.
    const release2 = await gate.acquire('q')
    release2()
  })
})
