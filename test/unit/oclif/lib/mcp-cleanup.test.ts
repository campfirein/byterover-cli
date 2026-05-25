import {expect} from 'chai'
import {type SinonFakeTimers, type SinonStub, stub, useFakeTimers} from 'sinon'

import {runMcpCleanup} from '../../../../src/oclif/lib/mcp-cleanup.js'

type DepStubs = {
  exit: SinonStub
}

const makeDeps = (overrides: Partial<DepStubs> = {}): DepStubs => ({
  exit: stub(),
  ...overrides,
})

describe('runMcpCleanup', () => {
  let clock: SinonFakeTimers

  beforeEach(() => {
    clock = useFakeTimers()
  })

  afterEach(() => {
    clock.restore()
  })

  it('exits(0) immediately when stop resolves before timeout', async () => {
    const deps = makeDeps()
    const stop = stub().resolves()

    const promise = runMcpCleanup(stop, 2000, deps)
    await clock.tickAsync(0) // let microtasks flush
    await promise

    expect(stop.callCount).to.equal(1)
    expect(deps.exit.callCount).to.equal(1)
    expect(deps.exit.firstCall.args[0]).to.equal(0)
  })

  it('exits(0) after timeout when stop hangs', async () => {
    const deps = makeDeps()
    const stop = stub().returns(new Promise<void>(() => {})) // hangs forever

    const promise = runMcpCleanup(stop, 2000, deps)
    await clock.tickAsync(2000)
    await promise

    expect(deps.exit.callCount).to.equal(1)
    expect(deps.exit.firstCall.args[0]).to.equal(0)
  })

  it('clears the pending timer when stop resolves first (no leak)', async () => {
    const deps = makeDeps()
    const stop = stub().resolves()

    expect(clock.countTimers()).to.equal(0)
    const promise = runMcpCleanup(stop, 2000, deps)
    expect(clock.countTimers()).to.equal(1) // setTimeout scheduled
    await clock.tickAsync(0)
    await promise

    expect(clock.countTimers()).to.equal(0) // timer was cleared
  })

  it('swallows stop() rejection and still exits(0)', async () => {
    const deps = makeDeps()
    const stop = stub().rejects(new Error('stop blew up'))

    const promise = runMcpCleanup(stop, 2000, deps)
    await clock.tickAsync(0)
    await promise

    expect(deps.exit.callCount).to.equal(1)
    expect(deps.exit.firstCall.args[0]).to.equal(0)
  })

  it('still exits(0) when stop throws synchronously (belt-and-suspenders)', async () => {
    const deps = makeDeps()
    const stop = stub().throws(new Error('sync boom'))

    const promise = runMcpCleanup(stop, 2000, deps)
    await clock.tickAsync(2000) // wait for timeout path
    await promise

    expect(deps.exit.callCount).to.equal(1)
    expect(deps.exit.firstCall.args[0]).to.equal(0)
  })
})
