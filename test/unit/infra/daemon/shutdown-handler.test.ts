import type {IGlobalInstanceManager} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IDaemonResilience} from '../../../../src/server/core/interfaces/daemon/i-daemon-resilience.js'
import type {IHeartbeatWriter} from '../../../../src/server/core/interfaces/daemon/i-heartbeat-writer.js'
import type {IIdleTimeoutPolicy} from '../../../../src/server/core/interfaces/daemon/i-idle-timeout-policy.js'
import type {ITransportServer} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {ShutdownHandler} from '../../../../src/server/infra/daemon/shutdown-handler.js'

describe('shutdown-handler', () => {
  let sandbox: SinonSandbox
  let logStub: SinonStub
  let callOrder: string[]

  // Separate stub references for assertion without `as SinonStub`
  let transportStopStub: SinonStub
  let instanceReleaseStub: SinonStub
  let heartbeatStopStub: SinonStub
  let idleStopStub: SinonStub
  let resilienceUninstallStub: SinonStub

  // Full interface-typed mocks
  let mockTransportServer: ITransportServer
  let mockInstanceManager: IGlobalInstanceManager
  let mockHeartbeatWriter: IHeartbeatWriter
  let mockIdleTimeoutPolicy: IIdleTimeoutPolicy
  let mockDaemonResilience: IDaemonResilience

  beforeEach(() => {
    sandbox = createSandbox()
    sandbox.useFakeTimers({now: Date.now()})
    logStub = sandbox.stub()
    callOrder = []

    transportStopStub = sandbox.stub().callsFake(async () => {
      callOrder.push('transportServer.stop')
    })
    instanceReleaseStub = sandbox.stub().callsFake(() => {
      callOrder.push('instanceManager.release')
    })
    heartbeatStopStub = sandbox.stub().callsFake(() => {
      callOrder.push('heartbeatWriter.stop')
    })
    idleStopStub = sandbox.stub().callsFake(() => {
      callOrder.push('idleTimeoutPolicy.stop')
    })
    resilienceUninstallStub = sandbox.stub().callsFake(() => {
      callOrder.push('daemonResilience.uninstall')
    })

    mockTransportServer = {
      addToRoom: sandbox.stub(),
      broadcast: sandbox.stub(),
      broadcastTo: sandbox.stub(),
      getPort: sandbox.stub(),
      isRunning: sandbox.stub().returns(true),
      onConnection: sandbox.stub(),
      onDisconnection: sandbox.stub(),
      onRequest: sandbox.stub(),
      removeFromRoom: sandbox.stub(),
      sendTo: sandbox.stub(),
      start: sandbox.stub(),
      stop: transportStopStub,
    }

    mockInstanceManager = {
      acquire: sandbox.stub(),
      load: sandbox.stub(),
      release: instanceReleaseStub,
    }

    mockHeartbeatWriter = {
      refresh: sandbox.stub(),
      start: sandbox.stub(),
      stop: heartbeatStopStub,
    }

    mockIdleTimeoutPolicy = {
      getIdleStatus: sandbox.stub(),
      onClientConnected: sandbox.stub(),
      onClientDisconnected: sandbox.stub(),
      start: sandbox.stub(),
      stop: idleStopStub,
    }

    mockDaemonResilience = {
      install: sandbox.stub(),
      uninstall: resilienceUninstallStub,
    }
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should call shutdown steps in correct order', async () => {
    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    await handler.shutdown()

    expect(callOrder).to.deep.equal([
      'idleTimeoutPolicy.stop',
      'daemonResilience.uninstall',
      'heartbeatWriter.stop',
      'transportServer.stop',
      'instanceManager.release',
    ])
  })

  it('should prevent double-shutdown', async () => {
    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    await handler.shutdown()
    await handler.shutdown() // second call should be no-op

    // Each step should only be called once
    expect(idleStopStub.callCount).to.equal(1)
    expect(transportStopStub.callCount).to.equal(1)
    expect(instanceReleaseStub.callCount).to.equal(1)
  })

  it('should continue shutdown even if transport stop throws', async () => {
    transportStopStub.rejects(new Error('transport error'))

    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    await handler.shutdown()

    // Should still release instance even though transport failed
    expect(instanceReleaseStub.calledOnce).to.be.true
  })

  it('should continue shutdown even if idle timeout stop throws', async () => {
    idleStopStub.throws(new Error('idle error'))

    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    await handler.shutdown()

    // Should still continue with remaining steps
    expect(resilienceUninstallStub.calledOnce).to.be.true
    expect(transportStopStub.calledOnce).to.be.true
    expect(instanceReleaseStub.calledOnce).to.be.true
  })

  it('should continue shutdown even if heartbeat stop throws', async () => {
    heartbeatStopStub.throws(new Error('heartbeat error'))

    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    await handler.shutdown()

    // Should still continue with transport stop and instance release
    expect(transportStopStub.calledOnce).to.be.true
    expect(instanceReleaseStub.calledOnce).to.be.true
  })

  it('should continue shutdown even if resilience uninstall throws', async () => {
    resilienceUninstallStub.throws(new Error('resilience error'))

    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    await handler.shutdown()

    // Should still continue with heartbeat, transport, and instance release
    expect(heartbeatStopStub.calledOnce).to.be.true
    expect(transportStopStub.calledOnce).to.be.true
    expect(instanceReleaseStub.calledOnce).to.be.true
  })

  it('should continue shutdown even if instance release throws', async () => {
    instanceReleaseStub.throws(new Error('release error'))

    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    // Should not throw even though release fails
    await handler.shutdown()

    // All prior steps should have been called
    expect(idleStopStub.calledOnce).to.be.true
    expect(resilienceUninstallStub.calledOnce).to.be.true
    expect(heartbeatStopStub.calledOnce).to.be.true
    expect(transportStopStub.calledOnce).to.be.true
  })

  it('should release instance even when transport stop hangs (timeout)', async () => {
    // Simulate transport.stop() that never resolves
    transportStopStub.callsFake(() => new Promise(() => {}))

    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    const shutdownPromise = handler.shutdown()

    // Advance past TRANSPORT_STOP_TIMEOUT_MS (3000ms)
    sandbox.clock.tick(3000)

    await shutdownPromise

    // Instance should still be released despite transport hanging
    expect(instanceReleaseStub.calledOnce).to.be.true
  })

  it('should log shutdown initiated and complete', async () => {
    const handler = new ShutdownHandler({
      daemonResilience: mockDaemonResilience,
      heartbeatWriter: mockHeartbeatWriter,
      idleTimeoutPolicy: mockIdleTimeoutPolicy,
      instanceManager: mockInstanceManager,
      log: logStub,
      transportServer: mockTransportServer,
    })

    await handler.shutdown()

    const messages = logStub.getCalls().map((c) => c.args[0])
    expect(messages.some((m: string) => m.includes('Shutdown initiated'))).to.be.true
    expect(messages.some((m: string) => m.includes('Shutdown complete'))).to.be.true
  })

  describe('M4.3 analyticsFinalFlush hook', () => {
    it('invokes analyticsFinalFlush after agent pool stops and before transport stops', async () => {
      const analyticsFlushStub = sandbox.stub().callsFake(async () => {
        callOrder.push('analyticsFinalFlush')
      })

      const handler = new ShutdownHandler({
        analyticsFinalFlush: analyticsFlushStub,
        daemonResilience: mockDaemonResilience,
        heartbeatWriter: mockHeartbeatWriter,
        idleTimeoutPolicy: mockIdleTimeoutPolicy,
        instanceManager: mockInstanceManager,
        log: logStub,
        transportServer: mockTransportServer,
      })

      await handler.shutdown()

      expect(analyticsFlushStub.calledOnce).to.equal(true)
      // Final flush sits between heartbeat.stop and transport.stop in this
      // config (no agent pool wired, so step 5 is a no-op).
      const heartbeatIdx = callOrder.indexOf('heartbeatWriter.stop')
      const flushIdx = callOrder.indexOf('analyticsFinalFlush')
      const transportIdx = callOrder.indexOf('transportServer.stop')
      expect(flushIdx).to.be.greaterThan(heartbeatIdx)
      expect(flushIdx).to.be.lessThan(transportIdx)
    })

    it('continues shutdown when analyticsFinalFlush rejects', async () => {
      const analyticsFlushStub = sandbox.stub().rejects(new Error('telemetry down'))

      const handler = new ShutdownHandler({
        analyticsFinalFlush: analyticsFlushStub,
        daemonResilience: mockDaemonResilience,
        heartbeatWriter: mockHeartbeatWriter,
        idleTimeoutPolicy: mockIdleTimeoutPolicy,
        instanceManager: mockInstanceManager,
        log: logStub,
        transportServer: mockTransportServer,
      })

      await handler.shutdown()

      // Subsequent steps still run despite the analytics rejection.
      expect(transportStopStub.calledOnce).to.equal(true)
      expect(instanceReleaseStub.calledOnce).to.equal(true)
      const messages = logStub.getCalls().map((c) => c.args[0])
      expect(messages.some((m: string) => m.includes('Error during final analytics flush'))).to.equal(true)
    })

    it('skips the hook when analyticsFinalFlush is not wired', async () => {
      const handler = new ShutdownHandler({
        daemonResilience: mockDaemonResilience,
        heartbeatWriter: mockHeartbeatWriter,
        idleTimeoutPolicy: mockIdleTimeoutPolicy,
        instanceManager: mockInstanceManager,
        log: logStub,
        transportServer: mockTransportServer,
      })

      await handler.shutdown()

      // No flush traces in the call order, just the pre-existing steps.
      expect(callOrder).to.not.include('analyticsFinalFlush')
    })
  })
})
