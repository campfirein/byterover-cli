import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {createSandbox, SinonSandbox, SinonStub} from 'sinon'

import type {ICipherAgent} from '../../../../src/agent/core/interfaces/i-cipher-agent.js'

import {handleAgentCancelEvent} from '../../../../src/server/infra/daemon/agent-cancel-listener.js'

type CancelDeps = {
  agent: Pick<ICipherAgent, 'cancelTask'>
  log: (msg: string) => void
  taskId: string
  transport: Pick<ITransportClient, 'request'>
}

describe('handleAgentCancelEvent', () => {
  let sandbox: SinonSandbox
  let cancelTaskStub: SinonStub
  let requestStub: SinonStub
  let logCalls: string[]
  let deps: Omit<CancelDeps, 'taskId'>

  beforeEach(() => {
    sandbox = createSandbox()
    cancelTaskStub = sandbox.stub()
    requestStub = sandbox.stub()
    logCalls = []
    deps = {
      agent: {cancelTask: cancelTaskStub},
      log: (msg) => logCalls.push(msg),
      transport: {request: requestStub},
    }
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('emits task:cancelled when the agent reports it cancelled the task', async () => {
    cancelTaskStub.resolves(true)

    await handleAgentCancelEvent({taskId: 'task-1', ...deps})

    expect(cancelTaskStub.calledOnceWithExactly('task-1')).to.equal(true)
    expect(requestStub.calledOnceWithExactly('task:cancelled', {taskId: 'task-1'})).to.equal(true)
  })

  it('does NOT emit task:cancelled when the agent reports no controller was held', async () => {
    cancelTaskStub.resolves(false)

    await handleAgentCancelEvent({taskId: 'unknown-task', ...deps})

    expect(cancelTaskStub.calledOnceWithExactly('unknown-task')).to.equal(true)
    expect(requestStub.called).to.equal(false)
  })

  it('does NOT emit, never throws when agent.cancelTask rejects (best-effort)', async () => {
    cancelTaskStub.rejects(new Error('agent boom'))

    let thrown: unknown
    try {
      await handleAgentCancelEvent({taskId: 'task-err', ...deps})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.equal(undefined)
    expect(requestStub.called).to.equal(false)
    expect(logCalls.some((l) => l.includes('task-err') && l.toLowerCase().includes('err'))).to.equal(true)
  })

  it('does NOT emit, never throws when transport.request throws synchronously', async () => {
    cancelTaskStub.resolves(true)
    requestStub.throws(new Error('transport boom'))

    let thrown: unknown
    try {
      await handleAgentCancelEvent({taskId: 'task-2', ...deps})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.equal(undefined)
    expect(logCalls.some((l) => l.includes('task-2') && l.toLowerCase().includes('err'))).to.equal(true)
  })

  it('logs receipt of every cancel request (matched or not)', async () => {
    cancelTaskStub.resolves(false)

    await handleAgentCancelEvent({taskId: 'log-test', ...deps})

    expect(logCalls.some((l) => l.includes('log-test'))).to.equal(true)
  })

  it('is idempotent: second call after the controller is gone returns silently', async () => {
    cancelTaskStub.onFirstCall().resolves(true)
    cancelTaskStub.onSecondCall().resolves(false)

    await handleAgentCancelEvent({taskId: 'task-idem', ...deps})
    await handleAgentCancelEvent({taskId: 'task-idem', ...deps})

    expect(requestStub.callCount).to.equal(1)
    expect(requestStub.firstCall.args[1]).to.deep.equal({taskId: 'task-idem'})
  })
})
