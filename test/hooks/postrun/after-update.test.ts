import {expect} from 'chai'
import {restore, stub} from 'sinon'

import {handleRestartAfterUpdate} from '../../../src/oclif/hooks/postrun/after-update.js'

describe('after-update hook', () => {
  let spawnRestartStub: ReturnType<typeof stub>
  let fakeChild: {unref: ReturnType<typeof stub>}
  let logStub: ReturnType<typeof stub>

  beforeEach(() => {
    fakeChild = {unref: stub()}
    spawnRestartStub = stub().returns(fakeChild)
    logStub = stub()
  })

  afterEach(() => {
    restore()
  })

  it('should spawn brv restart after manual brv update', async () => {
    await handleRestartAfterUpdate({
      argv: [],
      commandId: 'update',
      log: logStub,
      spawnRestartFn: spawnRestartStub,
    })

    expect(spawnRestartStub.calledOnce).to.be.true
    expect(fakeChild.unref.calledOnce).to.be.true
    expect(
      logStub.calledWith(
        'Restarting ByteRover in the background. Please wait a few seconds before running brv again.',
      ),
    ).to.be.true
  })

  it('should skip restart for auto-update (--autoupdate flag)', async () => {
    await handleRestartAfterUpdate({
      argv: ['--autoupdate'],
      commandId: 'update',
      log: logStub,
      spawnRestartFn: spawnRestartStub,
    })

    expect(logStub.called).to.be.false
    expect(spawnRestartStub.called).to.be.false
  })

  it('should skip restart for non-update commands', async () => {
    await handleRestartAfterUpdate({
      argv: [],
      commandId: 'status',
      log: logStub,
      spawnRestartFn: spawnRestartStub,
    })

    expect(logStub.called).to.be.false
    expect(spawnRestartStub.called).to.be.false
  })

  it('should not throw if spawn fails', async () => {
    spawnRestartStub.throws(new Error('spawn failed'))

    await handleRestartAfterUpdate({
      argv: [],
      commandId: 'update',
      log: logStub,
      spawnRestartFn: spawnRestartStub,
    })

    expect(spawnRestartStub.calledOnce).to.be.true
    expect(logStub.calledWith('Failed to restart ByteRover. Please restart it manually by running `brv restart`.')).to.be.true
  })

  it('should skip restart when commandId is undefined', async () => {
    await handleRestartAfterUpdate({
      argv: [],
      commandId: undefined,
      log: logStub,
      spawnRestartFn: spawnRestartStub,
    })

    expect(logStub.called).to.be.false
    expect(spawnRestartStub.called).to.be.false
  })
})
