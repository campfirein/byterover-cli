import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {createSandbox, SinonSandbox, SinonStub} from 'sinon'

import type {TaskCancelResponse} from '../../../../src/shared/transport/events/task-events.js'

import {runCancelTask} from '../../../../src/oclif/lib/cancel-task.js'

describe('runCancelTask', () => {
  let sandbox: SinonSandbox
  let requestStub: SinonStub
  let client: Pick<ITransportClient, 'requestWithAck'>
  let logCalls: string[]
  let stdoutWrites: string[]
  let stdoutWriteStub: SinonStub

  beforeEach(() => {
    sandbox = createSandbox()
    requestStub = sandbox.stub()
    client = {requestWithAck: requestStub} as unknown as Pick<ITransportClient, 'requestWithAck'>
    logCalls = []
    stdoutWrites = []
    stdoutWriteStub = sandbox.stub(process.stdout, 'write').callsFake((chunk: unknown) => {
      stdoutWrites.push(String(chunk))
      return true
    })
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('emits task:cancel with the given taskId on the transport client', async () => {
    requestStub.resolves({success: true} as TaskCancelResponse)

    await runCancelTask({
      client: client as ITransportClient,
      command: 'curate',
      format: 'text',
      log: (msg: string) => logCalls.push(msg),
      taskId: 'task-A',
    })

    expect(requestStub.calledOnce).to.equal(true)
    expect(requestStub.firstCall.args[0]).to.equal('task:cancel')
    expect(requestStub.firstCall.args[1]).to.deep.equal({taskId: 'task-A'})
  })

  it('returns true and prints "Cancelled <id>" on success (text format)', async () => {
    requestStub.resolves({success: true} as TaskCancelResponse)

    const result = await runCancelTask({
      client: client as ITransportClient,
      command: 'curate',
      format: 'text',
      log: (msg: string) => logCalls.push(msg),
      taskId: 'task-B',
    })

    expect(result).to.equal(true)
    expect(logCalls).to.include('Cancelled task-B')
    expect(stdoutWriteStub.called).to.equal(false)
  })

  it('returns false and prints "Failed to cancel <id>: <reason>" on failure (text format)', async () => {
    requestStub.resolves({error: 'Task not found', success: false} as TaskCancelResponse)

    const result = await runCancelTask({
      client: client as ITransportClient,
      command: 'curate',
      format: 'text',
      log: (msg: string) => logCalls.push(msg),
      taskId: 'task-X',
    })

    expect(result).to.equal(false)
    expect(logCalls.some((l) => l.includes('Failed to cancel task-X') && l.includes('Task not found'))).to.equal(true)
  })

  it('writes JSON success payload via writeJsonResponse (JSON format)', async () => {
    requestStub.resolves({success: true} as TaskCancelResponse)

    const result = await runCancelTask({
      client: client as ITransportClient,
      command: 'curate',
      format: 'json',
      log: (msg: string) => logCalls.push(msg),
      taskId: 'task-J',
    })

    expect(result).to.equal(true)
    expect(logCalls).to.have.length(0)

    expect(stdoutWrites).to.have.length(1)
    const payload = JSON.parse(stdoutWrites[0])
    expect(payload).to.include({command: 'curate', success: true})
    expect(payload.data).to.deep.include({status: 'cancelled', taskId: 'task-J'})
    expect(payload).to.have.property('timestamp')
  })

  it('writes JSON failure payload with error reason (JSON format)', async () => {
    requestStub.resolves({error: 'Task not found', success: false} as TaskCancelResponse)

    const result = await runCancelTask({
      client: client as ITransportClient,
      command: 'dream',
      format: 'json',
      log: (msg: string) => logCalls.push(msg),
      taskId: 'task-K',
    })

    expect(result).to.equal(false)

    const payload = JSON.parse(stdoutWrites[0])
    expect(payload).to.include({command: 'dream', success: false})
    expect(payload.data).to.deep.include({error: 'Task not found', status: 'error', taskId: 'task-K'})
  })

  it('falls back to a generic error message when the daemon omits one', async () => {
    requestStub.resolves({success: false} as TaskCancelResponse)

    await runCancelTask({
      client: client as ITransportClient,
      command: 'query',
      format: 'text',
      log: (msg: string) => logCalls.push(msg),
      taskId: 'task-Y',
    })

    // The exact wording is implementation-defined; we just require the
    // taskId, an error label, and that no "undefined" leaks into output.
    const line = logCalls.find((l) => l.includes('task-Y'))
    expect(line).to.exist
    expect(line!.toLowerCase()).to.include('fail')
    expect(line!).to.not.include('undefined')
  })

  it('passes the caller-supplied command verbatim into the JSON payload', async () => {
    requestStub.resolves({success: true} as TaskCancelResponse)

    await runCancelTask({
      client: client as ITransportClient,
      command: 'query',
      format: 'json',
      log() {},
      taskId: 'task-Q',
    })

    const payload = JSON.parse(stdoutWrites[0])
    expect(payload.command).to.equal('query')
  })
})
