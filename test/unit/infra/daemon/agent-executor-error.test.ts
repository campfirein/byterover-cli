import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {createSandbox, SinonSandbox, SinonStub} from 'sinon'

import {SessionCancelledError} from '../../../../src/agent/core/domain/errors/session-error.js'
import {handleExecutorTerminalError} from '../../../../src/server/infra/daemon/agent-executor-error.js'

describe('handleExecutorTerminalError', () => {
  let sandbox: SinonSandbox
  let requestStub: SinonStub
  let logCalls: string[]
  let transport: Pick<ITransportClient, 'request'>

  beforeEach(() => {
    sandbox = createSandbox()
    requestStub = sandbox.stub()
    logCalls = []
    transport = {request: requestStub}
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('does NOT emit task:error when error is SessionCancelledError (T1.1 already emitted task:cancelled)', () => {
    const error = new SessionCancelledError('session-1')

    handleExecutorTerminalError({
      clientId: 'client-1',
      error,
      log: (msg: string) => logCalls.push(msg),
      projectPath: '/proj',
      taskId: 'task-cancel',
      transport,
    })

    expect(requestStub.called).to.equal(false)
    expect(logCalls.some((l) => l.includes('task-cancel') && l.toLowerCase().includes('cancel'))).to.equal(true)
  })

  it('emits task:error for non-cancellation errors', () => {
    const error = new Error('boom')

    handleExecutorTerminalError({
      clientId: 'client-1',
      error,
      log: (msg: string) => logCalls.push(msg),
      projectPath: '/proj',
      taskId: 'task-err',
      transport,
    })

    expect(requestStub.calledOnce).to.equal(true)
    const [eventName, payload] = requestStub.firstCall.args
    expect(eventName).to.equal('task:error')
    expect(payload).to.have.property('clientId', 'client-1')
    expect(payload).to.have.property('taskId', 'task-err')
    expect(payload).to.have.property('projectPath', '/proj')
    expect(payload.error).to.have.property('message')
  })

  it('emits task:error for unknown thrown values (non-Error)', () => {
    handleExecutorTerminalError({
      clientId: 'client-1',
      error: 'plain string',
      log: (msg: string) => logCalls.push(msg),
      projectPath: '/proj',
      taskId: 'task-str',
      transport,
    })

    expect(requestStub.calledOnce).to.equal(true)
    expect(requestStub.firstCall.args[0]).to.equal('task:error')
  })

  it('swallows transport.request throw, never propagates', () => {
    requestStub.throws(new Error('socket gone'))

    let thrown: unknown
    try {
      handleExecutorTerminalError({
        clientId: 'client-1',
        error: new Error('inner'),
        log: (msg: string) => logCalls.push(msg),
        projectPath: '/proj',
        taskId: 'task-2',
        transport,
      })
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.equal(undefined)
    expect(logCalls.some((l) => l.includes('task-2') && l.toLowerCase().includes('send failed'))).to.equal(true)
  })

  it('does NOT swallow non-cancel errors before logging — task:error path still logs the original error', () => {
    handleExecutorTerminalError({
      clientId: 'client-1',
      error: new Error('something broke'),
      log: (msg: string) => logCalls.push(msg),
      projectPath: '/proj',
      taskId: 'task-log',
      transport,
    })

    expect(logCalls.some((l) => l.includes('task:error') && l.includes('task-log'))).to.equal(true)
  })
})
