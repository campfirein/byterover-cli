import {expect} from 'chai'
import {restore, type SinonFakeTimers, useFakeTimers} from 'sinon'

import {TaskHeartbeatManager} from '../../../../src/server/infra/process/task-heartbeat-manager.js'
import {TaskEvents} from '../../../../src/shared/transport/events/task-events.js'

type EmittedHeartbeat = {clientId: string; projectPath: string | undefined; taskId: string}

function makeManager(intervalMs = 10_000): {
  emitted: EmittedHeartbeat[]
  manager: TaskHeartbeatManager
} {
  const emitted: EmittedHeartbeat[] = []
  const manager = new TaskHeartbeatManager({
    emit(taskId, clientId, projectPath) {
      emitted.push({clientId, projectPath, taskId})
    },
    intervalMs,
  })
  return {emitted, manager}
}

describe('TaskHeartbeatManager', () => {
  let clock: SinonFakeTimers

  beforeEach(() => {
    clock = useFakeTimers()
  })

  afterEach(() => {
    restore()
  })

  it('emits a heartbeat once the interval elapses with no activity', async () => {
    const {emitted, manager} = makeManager(1000)
    manager.register('t1', 'client-1', '/p')

    expect(emitted).to.have.lengthOf(0)
    await clock.tickAsync(999)
    expect(emitted).to.have.lengthOf(0)
    await clock.tickAsync(1)
    expect(emitted).to.deep.equal([{clientId: 'client-1', projectPath: '/p', taskId: 't1'}])
  })

  it('keeps emitting periodically while the task is active', async () => {
    const {emitted, manager} = makeManager(1000)
    manager.register('t1', 'client-1', '/p')

    await clock.tickAsync(1000)
    await clock.tickAsync(1000)
    await clock.tickAsync(1000)

    expect(emitted).to.have.lengthOf(3)
  })

  it('resets the interval on recordActivity so a noisy task never emits redundant heartbeats', async () => {
    const {emitted, manager} = makeManager(1000)
    manager.register('t1', 'client-1', '/p')

    await clock.tickAsync(500)
    manager.recordActivity('t1')
    await clock.tickAsync(500)
    manager.recordActivity('t1')
    await clock.tickAsync(500)

    // 1500ms total elapsed but every 500ms tick the timer reset; no heartbeat yet.
    expect(emitted).to.have.lengthOf(0)

    await clock.tickAsync(500)
    expect(emitted).to.have.lengthOf(1)
  })

  it('stops emission permanently on recordTermination', async () => {
    const {emitted, manager} = makeManager(1000)
    manager.register('t1', 'client-1', '/p')

    await clock.tickAsync(1000)
    expect(emitted).to.have.lengthOf(1)

    manager.recordTermination('t1')
    await clock.tickAsync(5000)

    expect(emitted).to.have.lengthOf(1)
  })

  it('recordActivity for an unknown taskId is a no-op (no late registration)', async () => {
    const {emitted, manager} = makeManager(1000)
    manager.recordActivity('never-registered')
    await clock.tickAsync(5000)
    expect(emitted).to.have.lengthOf(0)
  })

  it('recordTermination for an unknown taskId is a no-op', () => {
    const {manager} = makeManager(1000)
    expect(() => {
      manager.recordTermination('never-registered')
    }).to.not.throw()
  })

  it('tracks multiple tasks independently', async () => {
    const {emitted, manager} = makeManager(1000)
    manager.register('t1', 'client-1', '/a')
    manager.register('t2', 'client-2', '/b')

    await clock.tickAsync(500)
    manager.recordActivity('t1') // resets t1 only
    await clock.tickAsync(500) // t1 has 500ms left, t2 has 0ms left

    expect(emitted.map((e) => e.taskId)).to.deep.equal(['t2'])

    await clock.tickAsync(500) // now t1 fires
    expect(emitted.map((e) => e.taskId).sort()).to.deep.equal(['t1', 't2'])
  })

  it('dispose() clears every registered timer', async () => {
    const {emitted, manager} = makeManager(1000)
    manager.register('t1', 'client-1', '/p')
    manager.register('t2', 'client-2', '/p')

    manager.dispose()
    await clock.tickAsync(10_000)

    expect(emitted).to.deep.equal([])
  })

  it('exports TaskEvents.HEARTBEAT as the canonical event name for consumers', () => {
    expect(TaskEvents.HEARTBEAT).to.equal('task:heartbeat')
  })
})
