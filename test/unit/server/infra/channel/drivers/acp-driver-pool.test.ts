import {expect} from 'chai'

import type {IAcpDriver} from '../../../../../../src/server/core/interfaces/channel/i-acp-driver.js'

import {AcpDriverPool} from '../../../../../../src/server/infra/channel/drivers/acp-driver-pool.js'
import {MockAcpDriver} from '../../../../../../src/server/infra/channel/drivers/mock-driver.js'

// Slice 2.4 — driver pool tracks one driver per (channelId, memberHandle).
// The pool does NOT call `start()`; the orchestrator's `inviteMember` is
// responsible for spawning + starting the driver, then handing the started
// driver to the pool via `register()`.

const stoppedFlag = (driver: IAcpDriver): {stopped: boolean} => {
  const flag = {stopped: false}
  const original = driver.stop.bind(driver)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(driver as any).stop = async (): Promise<void> => {
    flag.stopped = true
    await original()
  }

  return flag
}

describe('AcpDriverPool', () => {
  let pool: AcpDriverPool

  beforeEach(() => {
    pool = new AcpDriverPool()
  })

  it('register + acquire returns the registered driver', () => {
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    pool.register({channelId: 'c1', driver})
    expect(pool.acquire({channelId: 'c1', memberHandle: '@mock'})).to.equal(driver)
  })

  it('acquire returns undefined when no driver registered for that (channel, handle)', () => {
    expect(pool.acquire({channelId: 'c1', memberHandle: '@mock'})).to.equal(undefined)
  })

  it('keeps drivers per (channelId, memberHandle) — different channels do not collide', () => {
    const a = new MockAcpDriver({events: [], handle: '@mock'})
    const b = new MockAcpDriver({events: [], handle: '@mock'})
    pool.register({channelId: 'c1', driver: a})
    pool.register({channelId: 'c2', driver: b})
    expect(pool.acquire({channelId: 'c1', memberHandle: '@mock'})).to.equal(a)
    expect(pool.acquire({channelId: 'c2', memberHandle: '@mock'})).to.equal(b)
  })

  it('release stops the driver and removes it', async () => {
    const driver = new MockAcpDriver({events: [], handle: '@mock'})
    await driver.start()
    const flag = stoppedFlag(driver)
    pool.register({channelId: 'c1', driver})

    await pool.release({channelId: 'c1', memberHandle: '@mock'})
    expect(flag.stopped).to.equal(true)
    expect(pool.acquire({channelId: 'c1', memberHandle: '@mock'})).to.equal(undefined)
  })

  it('releaseChannel stops every driver for that channel and removes them', async () => {
    const a = new MockAcpDriver({events: [], handle: '@a'})
    const b = new MockAcpDriver({events: [], handle: '@b'})
    await a.start()
    await b.start()
    const flagA = stoppedFlag(a)
    const flagB = stoppedFlag(b)
    pool.register({channelId: 'c1', driver: a})
    pool.register({channelId: 'c1', driver: b})

    await pool.releaseChannel('c1')
    expect(flagA.stopped).to.equal(true)
    expect(flagB.stopped).to.equal(true)
    expect(pool.acquire({channelId: 'c1', memberHandle: '@a'})).to.equal(undefined)
    expect(pool.acquire({channelId: 'c1', memberHandle: '@b'})).to.equal(undefined)
  })

  it('releaseAll stops every driver in the pool', async () => {
    const a = new MockAcpDriver({events: [], handle: '@a'})
    const b = new MockAcpDriver({events: [], handle: '@b'})
    pool.register({channelId: 'c1', driver: a})
    pool.register({channelId: 'c2', driver: b})
    const flagA = stoppedFlag(a)
    const flagB = stoppedFlag(b)

    await pool.releaseAll()
    expect(flagA.stopped).to.equal(true)
    expect(flagB.stopped).to.equal(true)
  })

  it('re-registering the same (channelId, handle) replaces the previous driver and stops it', async () => {
    const first = new MockAcpDriver({events: [], handle: '@mock'})
    const second = new MockAcpDriver({events: [], handle: '@mock'})
    const flagFirst = stoppedFlag(first)
    pool.register({channelId: 'c1', driver: first})
    pool.register({channelId: 'c1', driver: second})
    // Allow the swallowed stop() to settle.
    await new Promise((r) => {
      setTimeout(r, 5)
    })
    expect(flagFirst.stopped).to.equal(true)
    expect(pool.acquire({channelId: 'c1', memberHandle: '@mock'})).to.equal(second)
  })
})
