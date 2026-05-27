import type {ITransportClient} from '@campfirein/brv-transport-client'

import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import {runCancelBranchWithRetry} from '../../../../src/oclif/lib/cancel-task.js'

describe('runCancelBranchWithRetry', () => {
  let sandbox: SinonSandbox
  let requestStub: SinonStub
  let logCalls: string[]
  let transportErrors: unknown[]
  let stdoutWriteStub: SinonStub

  beforeEach(() => {
    sandbox = createSandbox()
    requestStub = sandbox.stub()
    logCalls = []
    transportErrors = []
    stdoutWriteStub = sandbox.stub(process.stdout, 'write').returns(true)
  })

  afterEach(() => {
    sandbox.restore()
  })

  /**
   * Inject a fake `transportConnector` so the helper goes through real
   * `withDaemonRetry` plumbing without needing a live daemon. The connector
   * always returns the same in-memory client; the retry behaviour itself is
   * covered by `daemon-client` unit tests — what we verify here is the
   * cancel-branch wiring around it.
   */
  function makeOptions() {
    const fakeClient = {
      disconnect: sandbox.stub().resolves(),
      requestWithAck: requestStub,
    } as unknown as ITransportClient

    return {
      command: 'curate',
      daemonClientOptions: {
        maxRetries: 1,
        retryDelayMs: 0,
        transportConnector: async () => ({
          client: fakeClient,
          projectRoot: '/proj',
        }),
      },
      format: 'text' as const,
      log: (msg: string) => logCalls.push(msg),
      onTransportError: (error: unknown) => transportErrors.push(error),
      taskId: 'task-1',
    }
  }

  it('returns true and prints the success line when the daemon reports success', async () => {
    requestStub.resolves({success: true})

    const result = await runCancelBranchWithRetry(makeOptions())

    expect(result).to.equal(true)
    expect(logCalls).to.include('Cancelled task-1')
    expect(transportErrors).to.have.length(0)
    expect(stdoutWriteStub.called).to.equal(false)
  })

  it('returns false when the daemon reports failure (no transport throw)', async () => {
    requestStub.resolves({error: 'Task not found', success: false})

    const result = await runCancelBranchWithRetry(makeOptions())

    expect(result).to.equal(false)
    expect(logCalls.some((l) => l.includes('Failed to cancel task-1') && l.includes('Task not found'))).to.equal(true)
    expect(transportErrors).to.have.length(0)
  })

  it('returns false and invokes onTransportError when withDaemonRetry rethrows', async () => {
    const boom = new Error('connection refused')
    requestStub.rejects(boom)

    const result = await runCancelBranchWithRetry(makeOptions())

    expect(result).to.equal(false)
    expect(transportErrors).to.have.length(1)
    expect(transportErrors[0]).to.equal(boom)
  })
})
