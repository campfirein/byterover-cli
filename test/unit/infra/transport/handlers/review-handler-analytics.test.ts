import {expect} from 'chai'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer, RequestHandler} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {BRV_CONFIG_VERSION} from '../../../../../src/server/constants.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'
import {ReviewHandler} from '../../../../../src/server/infra/transport/handlers/review-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {ReviewEvents} from '../../../../../src/shared/transport/events/review-events.js'

type Stubbed<T> = {[K in keyof T]: SinonStub & T[K]}

const sha256HexRegex = /^[0-9a-f]{64}$/

function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: SinonStub} {
  const trackSpy = createSandbox().stub() as SinonStub
  return {
    abort: createSandbox().stub(),
    flush: createSandbox().stub().resolves({events: []}),
    getRuntimeState: createSandbox().stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: createSandbox().stub().resolves(),
    track: trackSpy,
    trackSpy,
  } as unknown as IAnalyticsClient & {trackSpy: SinonStub}
}

function makeConfig(): BrvConfig {
  return new BrvConfig({
    createdAt: '2024-01-01T00:00:00.000Z',
    cwd: '/proj',
    version: BRV_CONFIG_VERSION,
  })
}

describe('ReviewHandler analytics emits', () => {
  let sandbox: SinonSandbox
  let requestHandlers: Record<string, RequestHandler>
  let transport: Stubbed<ITransportServer>
  let analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}
  let projectDir: string
  let projectConfigStore: {exists: SinonStub; getModifiedTime: SinonStub; read: SinonStub; write: SinonStub}

  beforeEach(() => {
    sandbox = createSandbox()
    requestHandlers = {}
    transport = {
      addToRoom: sandbox.stub(),
      broadcast: sandbox.stub(),
      broadcastTo: sandbox.stub(),
      getPort: sandbox.stub(),
      isRunning: sandbox.stub(),
      onConnection: sandbox.stub(),
      onDisconnection: sandbox.stub(),
      onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
        requestHandlers[event] = handler
      }),
      removeFromRoom: sandbox.stub(),
      sendTo: sandbox.stub(),
      start: sandbox.stub().resolves(),
      stop: sandbox.stub().resolves(),
    }

    projectDir = mkdtempSync(join(tmpdir(), 'brv-review-proj-'))

    projectConfigStore = {
      exists: sandbox.stub().resolves(true),
      getModifiedTime: sandbox.stub().resolves(),
      read: sandbox.stub().resolves(makeConfig()),
      write: sandbox.stub().resolves(),
    }

    analyticsClient = makeFakeAnalyticsClient()
  })

  afterEach(() => {
    sandbox.restore()
    rmSync(projectDir, {force: true, recursive: true})
  })

  function makeHandler(opts: {curateLog?: never[]; injectClient?: boolean} = {}): void {
    const entries = opts.curateLog ?? []
    new ReviewHandler({
      analyticsClient: opts.injectClient === false ? undefined : analyticsClient,
      curateLogStoreFactory: () => ({
        batchUpdateOperationReviewStatus: sandbox.stub().resolves(),
        list: sandbox.stub().resolves(entries),
      }) as never,
      projectConfigStore: projectConfigStore as never,
      resolveProjectPath: sandbox.stub().returns(projectDir) as never,
      reviewBackupStoreFactory: () => ({
        clear: sandbox.stub().resolves(),
        delete: sandbox.stub().resolves(),
        read: sandbox.stub().resolves(null),
      }) as never,
      transport,
    }).setup()
  }

  function emits(name: string): Array<{args: unknown[]}> {
    return analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
  }

  it('emits review_toggled outcome=success with new_state=disabled on disable', async () => {
    makeHandler()
    await requestHandlers[ReviewEvents.SET_DISABLED]({reviewDisabled: true}, 'c1')
    const calls = emits(AnalyticsEventNames.REVIEW_TOGGLED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {new_state?: string; outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('success')
    expect(props.new_state).to.equal('disabled')
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('emits review_toggled new_state=enabled on enable', async () => {
    makeHandler()
    await requestHandlers[ReviewEvents.SET_DISABLED]({reviewDisabled: false}, 'c1')
    const calls = emits(AnalyticsEventNames.REVIEW_TOGGLED)
    const props = calls[0].args[1] as {new_state?: string}
    expect(props.new_state).to.equal('enabled')
  })

  it('emits review_toggled outcome=failure failure_kind=config_write on write failure', async () => {
    projectConfigStore.write.rejects(new Error('disk full'))
    makeHandler()
    try {
      await requestHandlers[ReviewEvents.SET_DISABLED]({reviewDisabled: true}, 'c1')
      expect.fail('should throw')
    } catch {
      // expected
    }

    const calls = emits(AnalyticsEventNames.REVIEW_TOGGLED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('config_write')
  })

  it('emits review_approved per file with operation_kind on approve', async () => {
    const contextTreeDir = join(projectDir, '.brv', 'context-tree')
    const fakeEntry = {
      id: 'log-1',
      operations: [
        {
          filePath: join(contextTreeDir, 'topic-a.md'),
          path: 'topic-a',
          reviewStatus: 'pending',
          status: 'completed',
          type: 'ADD',
        },
      ],
      startedAt: 1,
      status: 'completed',
      taskId: 't1',
    }
    makeHandler({curateLog: [fakeEntry] as never})
    await requestHandlers[ReviewEvents.DECIDE_TASK]({decision: 'approved', taskId: 't1'}, 'c1')
    const calls = emits(AnalyticsEventNames.REVIEW_APPROVED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {operation_kind: string; outcome: string; project_path_hash: string}
    expect(props.outcome).to.equal('success')
    expect(props.operation_kind).to.equal('add')
    expect(props.project_path_hash).to.match(sha256HexRegex)
  })

  it('emits review_rejected per file with operation_kind on reject', async () => {
    const contextTreeDir = join(projectDir, '.brv', 'context-tree')
    const fakeEntry = {
      id: 'log-1',
      operations: [
        {
          filePath: join(contextTreeDir, 'topic-a.md'),
          path: 'topic-a',
          reviewStatus: 'pending',
          status: 'completed',
          type: 'DELETE',
        },
      ],
      startedAt: 1,
      status: 'completed',
      taskId: 't1',
    }
    makeHandler({curateLog: [fakeEntry] as never})
    await requestHandlers[ReviewEvents.DECIDE_TASK]({decision: 'rejected', taskId: 't1'}, 'c1')
    const calls = emits(AnalyticsEventNames.REVIEW_REJECTED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {operation_kind: string; outcome: string}
    expect(props.operation_kind).to.equal('delete')
  })

  it('emits review_approved outcome=failure failure_kind=not_found when taskId has no pending ops', async () => {
    makeHandler({curateLog: [] as never})
    await requestHandlers[ReviewEvents.DECIDE_TASK]({decision: 'approved', taskId: 'nope'}, 'c1')
    const calls = emits(AnalyticsEventNames.REVIEW_APPROVED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('not_found')
  })

  it('is a no-op when analyticsClient is not injected', async () => {
    makeHandler({injectClient: false})
    await requestHandlers[ReviewEvents.SET_DISABLED]({reviewDisabled: true}, 'c1')
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })
})
