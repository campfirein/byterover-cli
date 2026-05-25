import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import {type WaitForTaskClient, waitForTaskCompletion} from '../../../../src/oclif/lib/task-client.js'

type EventHandler = (data: unknown) => void

/**
 * Build a WaitForTaskClient stub that exposes:
 *  - eventHandlers map keyed by event name with the registered listener
 *  - on/onStateChange returning unsubscribe stubs (counted for cleanup checks)
 *  - request stub for verifying the cancel emission
 *
 * Stub conforms to the narrow `WaitForTaskClient` contract — no cast needed.
 */
function makeStubClient(sandbox: SinonSandbox) {
  const eventHandlers = new Map<string, EventHandler>()
  const unsubscribeStubs: SinonStub[] = []

  const onStub = sandbox.stub().callsFake((event: string, handler: EventHandler) => {
    eventHandlers.set(event, handler)
    const unsub = sandbox.stub()
    unsubscribeStubs.push(unsub)
    return unsub
  })

  const stateUnsub = sandbox.stub()
  const onStateChangeStub = sandbox.stub().returns(stateUnsub)
  unsubscribeStubs.push(stateUnsub)

  const requestStub = sandbox.stub()

  const client: WaitForTaskClient = {
    on: onStub,
    onStateChange: onStateChangeStub,
    request: requestStub,
  }

  return {
    client,
    emit(event: string, data: unknown) {
      eventHandlers.get(event)?.(data)
    },
    onStub,
    requestStub,
    unsubscribeStubs,
  }
}

describe('waitForTaskCompletion — SIGINT cancel handling (T2.5)', () => {
  let sandbox: SinonSandbox
  let stderrWrites: string[]
  let stderrStub: SinonStub
  let exitStub: SinonStub
  let originalSigintListeners: Array<(() => void) | NodeJS.SignalsListener>

  beforeEach(() => {
    sandbox = createSandbox()
    stderrWrites = []
    stderrStub = sandbox.stub(process.stderr, 'write').callsFake((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })
    exitStub = sandbox.stub(process, 'exit')

    // Park existing SIGINT listeners so the test runner doesn't fire on emit.
    originalSigintListeners = process.listeners('SIGINT') as Array<(() => void) | NodeJS.SignalsListener>
    process.removeAllListeners('SIGINT')
  })

  afterEach(() => {
    process.removeAllListeners('SIGINT')
    for (const listener of originalSigintListeners) {
      process.on('SIGINT', listener as NodeJS.SignalsListener)
    }

    sandbox.restore()
  })

  it('treats task:cancelled as a terminal event and resolves with the cancelled shape', async () => {
    const stub = makeStubClient(sandbox)
    const cancelled: Array<{taskId: string}> = []

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'text',
        onCancelled: (result) => cancelled.push(result),
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    // Daemon broadcasts task:cancelled
    stub.emit('task:cancelled', {taskId: 'task-1'})

    await wait

    expect(cancelled).to.have.length(1)
    expect(cancelled[0]).to.include({taskId: 'task-1'})
  })

  it('ignores task:cancelled for a different taskId', async () => {
    const stub = makeStubClient(sandbox)
    const cancelled: Array<{taskId: string}> = []

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'text',
        onCancelled: (result) => cancelled.push(result),
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    stub.emit('task:cancelled', {taskId: 'task-2'})
    // No terminal event for our taskId yet — emit the real one
    stub.emit('task:cancelled', {taskId: 'task-1'})

    await wait

    expect(cancelled).to.have.length(1)
    expect(cancelled[0].taskId).to.equal('task-1')
  })

  it('on first SIGINT, emits task:cancel and writes a hint to stderr; does not exit', async () => {
    const stub = makeStubClient(sandbox)

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'text',
        onCancelled() {},
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    process.emit('SIGINT')

    expect(stub.requestStub.calledOnce).to.equal(true)
    expect(stub.requestStub.firstCall.args[0]).to.equal('task:cancel')
    expect(stub.requestStub.firstCall.args[1]).to.deep.equal({taskId: 'task-1'})

    expect(stderrWrites.some((s) => s.toLowerCase().includes('cancel'))).to.equal(true)
    expect(exitStub.called).to.equal(false)

    // End the test by resolving the wait
    stub.emit('task:cancelled', {taskId: 'task-1'})
    await wait
  })

  it('on second SIGINT, calls process.exit(130) without emitting another cancel', async () => {
    const stub = makeStubClient(sandbox)

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'text',
        onCancelled() {},
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    process.emit('SIGINT')
    expect(stub.requestStub.callCount).to.equal(1)

    process.emit('SIGINT')
    expect(stub.requestStub.callCount).to.equal(1) // not re-emitted
    expect(exitStub.calledOnceWithExactly(130)).to.equal(true)

    // Resolve so the test ends
    stub.emit('task:cancelled', {taskId: 'task-1'})
    await wait
  })

  it('removes the SIGINT handler after wait completes via task:completed', async () => {
    const stub = makeStubClient(sandbox)
    const listenersBefore = process.listenerCount('SIGINT')

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    // While waiting, exactly one SIGINT listener is installed.
    expect(process.listenerCount('SIGINT')).to.equal(listenersBefore + 1)

    stub.emit('task:completed', {result: 'ok', taskId: 'task-1'})
    await wait

    expect(process.listenerCount('SIGINT')).to.equal(listenersBefore)
  })

  it('removes the SIGINT handler after wait completes via task:cancelled', async () => {
    const stub = makeStubClient(sandbox)
    const listenersBefore = process.listenerCount('SIGINT')

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'text',
        onCancelled() {},
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    expect(process.listenerCount('SIGINT')).to.equal(listenersBefore + 1)

    stub.emit('task:cancelled', {taskId: 'task-1'})
    await wait

    expect(process.listenerCount('SIGINT')).to.equal(listenersBefore)
  })

  it('removes the SIGINT handler after wait rejects via task:error in text mode', async () => {
    const stub = makeStubClient(sandbox)
    const listenersBefore = process.listenerCount('SIGINT')

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'text',
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    stub.emit('task:error', {error: {code: 'X', message: 'boom', name: 'Error'}, taskId: 'task-1'})

    let rejected: unknown
    try {
      await wait
    } catch (error) {
      rejected = error
    }

    expect(rejected).to.be.an('error')
    expect(process.listenerCount('SIGINT')).to.equal(listenersBefore)
  })

  it('JSON mode hint goes to stderr, not stdout', async () => {
    const stub = makeStubClient(sandbox)
    const stdoutWrites: string[] = []
    sandbox.stub(process.stdout, 'write').callsFake((chunk: unknown) => {
      stdoutWrites.push(String(chunk))
      return true
    })

    const wait = waitForTaskCompletion(
      {
        client: stub.client,
        command: 'curate',
        format: 'json',
        onCompleted() {},
        onError() {},
        taskId: 'task-1',
      },
      () => {},
    )

    process.emit('SIGINT')

    expect(stderrStub.called).to.equal(true)
    expect(stdoutWrites.some((s) => s.toLowerCase().includes('cancelling'))).to.equal(false)

    stub.emit('task:cancelled', {taskId: 'task-1'})
    await wait
  })
})
