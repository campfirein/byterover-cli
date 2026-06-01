import {expect} from 'chai'

import type {
  AgentDriverStatus,
  IAgentDriver,
  TurnEventPayload,
} from '../../../../../../src/server/core/interfaces/channel/i-agent-driver.js'
import type {DriverPoolKey} from '../../../../../../src/server/core/interfaces/channel/i-driver-pool.js'

import {DriverPool} from '../../../../../../src/server/infra/channel/drivers/driver-pool.js'

// DriverPool is pure lifecycle bookkeeping over IAgentDriver instances keyed on
// {channelId, memberHandle}. It never constructs drivers; the orchestrator hands
// over already-started drivers via register() and the pool stop()s them on
// eviction. These tests use a fake driver (no subprocess) that counts stop()s.

/** Inert {@link IAgentDriver} that counts stop() calls — no subprocess, no I/O. */
class FakeDriver implements IAgentDriver {
  public readonly handle: string
  public status: AgentDriverStatus = 'idle'
  public stopCount = 0
  private readonly failStop: boolean

  public constructor(handle = '@fake', failStop = false) {
    this.handle = handle
    this.failStop = failStop
  }

  async cancel(): Promise<void> {}

  async *prompt(): AsyncIterableIterator<TurnEventPayload> {
    // The pool never drives prompts; this yields nothing.
  }

  async respondToPermission(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopCount += 1
    this.status = 'stopped'
    if (this.failStop) throw new Error(`stop failed for ${this.handle}`)
  }
}

/** Resolves on the next macrotask, after fire-and-forget stop() microtasks settle. */
const nextTick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve)
  })

const key = (channelId: string, memberHandle: string): DriverPoolKey => ({channelId, memberHandle})

describe('DriverPool', () => {
  it('register then acquire returns the same driver instance', () => {
    const pool = new DriverPool()
    const driver = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver, memberHandle: '@a'})
    expect(pool.acquire(key('c1', '@a'))).to.equal(driver)
  })

  it('re-register on the same key replaces the slot and stops the previous driver', async () => {
    const pool = new DriverPool()
    const oldDriver = new FakeDriver('@a')
    const newDriver = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver: oldDriver, memberHandle: '@a'})
    pool.register({channelId: 'c1', driver: newDriver, memberHandle: '@a'})
    await nextTick()
    expect(pool.acquire(key('c1', '@a'))).to.equal(newDriver)
    expect(oldDriver.stopCount).to.equal(1)
    expect(newDriver.stopCount).to.equal(0)
  })

  it('re-registering the same instance does not stop it', async () => {
    const pool = new DriverPool()
    const driver = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver, memberHandle: '@a'})
    pool.register({channelId: 'c1', driver, memberHandle: '@a'})
    await nextTick()
    expect(pool.acquire(key('c1', '@a'))).to.equal(driver)
    expect(driver.stopCount).to.equal(0)
  })

  it('acquire returns undefined for an unregistered key', () => {
    const pool = new DriverPool()
    expect(pool.acquire(key('nope', '@x'))).to.equal(undefined)
  })

  it('acquire returns undefined for a known channel but unknown member', () => {
    const pool = new DriverPool()
    pool.register({channelId: 'c1', driver: new FakeDriver('@a'), memberHandle: '@a'})
    expect(pool.acquire(key('c1', '@b'))).to.equal(undefined)
  })

  it('releaseChannel stops every driver in the channel and leaves other channels untouched', async () => {
    const pool = new DriverPool()
    const a1 = new FakeDriver('@a')
    const a2 = new FakeDriver('@b')
    const b1 = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver: a1, memberHandle: '@a'})
    pool.register({channelId: 'c1', driver: a2, memberHandle: '@b'})
    pool.register({channelId: 'c2', driver: b1, memberHandle: '@a'})
    await pool.releaseChannel('c1')
    expect(a1.stopCount).to.equal(1)
    expect(a2.stopCount).to.equal(1)
    expect(b1.stopCount).to.equal(0)
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
    expect(pool.acquire(key('c1', '@b'))).to.equal(undefined)
    expect(pool.acquire(key('c2', '@a'))).to.equal(b1)
  })

  it('releaseChannel does not evict a different channel whose id shares a prefix', async () => {
    const pool = new DriverPool()
    const d1 = new FakeDriver('@a')
    const d10 = new FakeDriver('@a')
    pool.register({channelId: 'chan1', driver: d1, memberHandle: '@a'})
    pool.register({channelId: 'chan10', driver: d10, memberHandle: '@a'})
    await pool.releaseChannel('chan1')
    expect(d1.stopCount).to.equal(1)
    expect(d10.stopCount).to.equal(0)
    expect(pool.acquire(key('chan10', '@a'))).to.equal(d10)
  })

  it('releaseChannel with a colon-bearing channelId does not over-match', async () => {
    const pool = new DriverPool()
    const da = new FakeDriver('@x')
    const dab = new FakeDriver('@x')
    pool.register({channelId: 'a', driver: da, memberHandle: '@x'})
    pool.register({channelId: 'a:b', driver: dab, memberHandle: '@x'})
    await pool.releaseChannel('a')
    expect(da.stopCount).to.equal(1)
    expect(dab.stopCount).to.equal(0)
    expect(pool.acquire(key('a:b', '@x'))).to.equal(dab)
  })

  it('release stops and evicts a single key; a later acquire returns undefined', async () => {
    const pool = new DriverPool()
    const driver = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver, memberHandle: '@a'})
    await pool.release(key('c1', '@a'))
    expect(driver.stopCount).to.equal(1)
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
  })

  it('release of one member leaves other members of the channel intact', async () => {
    const pool = new DriverPool()
    const a = new FakeDriver('@a')
    const b = new FakeDriver('@b')
    pool.register({channelId: 'c1', driver: a, memberHandle: '@a'})
    pool.register({channelId: 'c1', driver: b, memberHandle: '@b'})
    await pool.release(key('c1', '@a'))
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
    expect(pool.acquire(key('c1', '@b'))).to.equal(b)
    expect(b.stopCount).to.equal(0)
  })

  it('release is a no-op when the member is absent and leaves neighbors untouched', async () => {
    const pool = new DriverPool()
    const a = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver: a, memberHandle: '@a'})
    await pool.release(key('c1', '@b'))
    await pool.release(key('ghost', '@x'))
    expect(a.stopCount).to.equal(0)
    expect(pool.acquire(key('c1', '@a'))).to.equal(a)
  })

  it('releaseChannel is a no-op when the channel is absent', async () => {
    const pool = new DriverPool()
    const a = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver: a, memberHandle: '@a'})
    await pool.releaseChannel('ghost')
    expect(a.stopCount).to.equal(0)
    expect(pool.acquire(key('c1', '@a'))).to.equal(a)
  })

  it('releaseAll stops every driver and empties the pool', async () => {
    const pool = new DriverPool()
    const a = new FakeDriver('@a')
    const b = new FakeDriver('@b')
    pool.register({channelId: 'c1', driver: a, memberHandle: '@a'})
    pool.register({channelId: 'c2', driver: b, memberHandle: '@b'})
    await pool.releaseAll()
    expect(a.stopCount).to.equal(1)
    expect(b.stopCount).to.equal(1)
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
    expect(pool.acquire(key('c2', '@b'))).to.equal(undefined)
  })

  it('releaseAll on an empty pool resolves without error', async () => {
    const pool = new DriverPool()
    await pool.releaseAll()
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
  })

  it('a driver registered during releaseChannel is not stopped by that call', async () => {
    const pool = new DriverPool()
    const d1 = new FakeDriver('@a')
    const d2 = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver: d1, memberHandle: '@a'})
    const pending = pool.releaseChannel('c1')
    pool.register({channelId: 'c1', driver: d2, memberHandle: '@a'})
    await pending
    expect(d1.stopCount).to.equal(1)
    expect(d2.stopCount).to.equal(0)
    expect(pool.acquire(key('c1', '@a'))).to.equal(d2)
  })

  it('release propagates a failed stop() rejection to the caller', async () => {
    const pool = new DriverPool()
    const driver = new FakeDriver('@a', true)
    pool.register({channelId: 'c1', driver, memberHandle: '@a'})
    let caught: unknown
    await pool.release(key('c1', '@a')).catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(Error)
    expect(driver.stopCount).to.equal(1)
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
  })

  it('releaseAll throws AggregateError on a failed stop but still stops and evicts every driver', async () => {
    const pool = new DriverPool()
    const ok = new FakeDriver('@a')
    const bad = new FakeDriver('@b', true)
    pool.register({channelId: 'c1', driver: ok, memberHandle: '@a'})
    pool.register({channelId: 'c2', driver: bad, memberHandle: '@b'})
    let caught: unknown
    await pool.releaseAll().catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(AggregateError)
    if (caught instanceof AggregateError) {
      expect(caught.errors).to.have.lengthOf(1)
    }

    expect(ok.stopCount).to.equal(1)
    expect(bad.stopCount).to.equal(1)
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
    expect(pool.acquire(key('c2', '@b'))).to.equal(undefined)
  })

  it('releaseChannel throws AggregateError on a failed stop, still evicts the channel, and leaves others untouched', async () => {
    const pool = new DriverPool()
    const bad = new FakeDriver('@a', true)
    const ok = new FakeDriver('@b')
    const other = new FakeDriver('@a')
    pool.register({channelId: 'c1', driver: bad, memberHandle: '@a'})
    pool.register({channelId: 'c1', driver: ok, memberHandle: '@b'})
    pool.register({channelId: 'c2', driver: other, memberHandle: '@a'})
    let caught: unknown
    await pool.releaseChannel('c1').catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(AggregateError)
    expect(bad.stopCount).to.equal(1)
    expect(ok.stopCount).to.equal(1)
    expect(pool.acquire(key('c1', '@a'))).to.equal(undefined)
    expect(pool.acquire(key('c1', '@b'))).to.equal(undefined)
    expect(pool.acquire(key('c2', '@a'))).to.equal(other)
    expect(other.stopCount).to.equal(0)
  })

  it('aggregates every failed stop in releaseAll', async () => {
    const pool = new DriverPool()
    const bad1 = new FakeDriver('@a', true)
    const bad2 = new FakeDriver('@b', true)
    pool.register({channelId: 'c1', driver: bad1, memberHandle: '@a'})
    pool.register({channelId: 'c2', driver: bad2, memberHandle: '@b'})
    let caught: unknown
    await pool.releaseAll().catch((error: unknown) => {
      caught = error
    })
    expect(caught).to.be.instanceOf(AggregateError)
    if (caught instanceof AggregateError) {
      expect(caught.errors).to.have.lengthOf(2)
    }
  })
})
