import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {IContextTreeService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-service.js'
import type {IContextTreeSnapshotService} from '../../../../../src/server/core/interfaces/context-tree/i-context-tree-snapshot-service.js'
import type {ITransportServer, RequestHandler} from '../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {ContextTreeNotInitializedError} from '../../../../../src/server/core/domain/errors/task-error.js'
import {ResetHandler} from '../../../../../src/server/infra/transport/handlers/reset-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {ResetEvents} from '../../../../../src/shared/transport/events/reset-events.js'

type Stubbed<T> = {[K in keyof T]: SinonStub & T[K]}

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

describe('ResetHandler analytics emits', () => {
  let sandbox: SinonSandbox
  let requestHandlers: Record<string, RequestHandler>
  let transport: Stubbed<ITransportServer>
  let contextTreeService: Stubbed<IContextTreeService>
  let contextTreeSnapshotService: Stubbed<IContextTreeSnapshotService>
  let analyticsClient: IAnalyticsClient & {trackSpy: SinonStub}

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
    contextTreeService = {
      delete: sandbox.stub().resolves(),
      exists: sandbox.stub().resolves(true),
      hasGitRepo: sandbox.stub().resolves(false),
      initialize: sandbox.stub().resolves('/proj/.brv/context-tree'),
      resolvePath: sandbox.stub().returns('/proj/.brv/context-tree'),
    }
    contextTreeSnapshotService = {
      getChanges: sandbox.stub(),
      getCurrentState: sandbox.stub(),
      getSnapshotState: sandbox.stub(),
      hasSnapshot: sandbox.stub(),
      initEmptySnapshot: sandbox.stub().resolves(),
      saveSnapshot: sandbox.stub(),
      saveSnapshotFromState: sandbox.stub(),
    }
    analyticsClient = makeFakeAnalyticsClient()
    new ResetHandler({
      analyticsClient,
      contextTreeService,
      contextTreeSnapshotService,
      curateLogStoreFactory: () => ({
        batchUpdateOperationReviewStatus: sandbox.stub().resolves(),
        list: sandbox.stub().resolves([]),
      }) as never,
      resolveProjectPath: sandbox.stub().returns('/proj') as never,
      reviewBackupStoreFactory: () => ({clear: sandbox.stub().resolves()}) as never,
      transport,
    }).setup()
  })

  afterEach(() => sandbox.restore())

  function emits(name: string): Array<{args: unknown[]}> {
    return analyticsClient.trackSpy.getCalls().filter((c) => c.args[0] === name)
  }

  it('emits daemon_reset_executed outcome=success with reset_scope=project', async () => {
    await requestHandlers[ResetEvents.EXECUTE](undefined, 'c1')
    const calls = emits(AnalyticsEventNames.DAEMON_RESET_EXECUTED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {outcome: string; reset_scope: string}
    expect(props.outcome).to.equal('success')
    expect(props.reset_scope).to.equal('project')
  })

  it('emits daemon_reset_executed outcome=failure failure_kind=not_initialized when context tree absent', async () => {
    contextTreeService.exists.resolves(false)
    try {
      await requestHandlers[ResetEvents.EXECUTE](undefined, 'c1')
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).to.be.instanceOf(ContextTreeNotInitializedError)
    }

    const calls = emits(AnalyticsEventNames.DAEMON_RESET_EXECUTED)
    expect(calls.length).to.equal(1)
    const props = calls[0].args[1] as {failure_kind?: string; outcome: string}
    expect(props.outcome).to.equal('failure')
    expect(props.failure_kind).to.equal('not_initialized')
  })

  it('is a no-op when analyticsClient is not injected', async () => {
    const local: Record<string, RequestHandler> = {}
    const tLocal = {...transport, onRequest: sandbox.stub().callsFake((e: string, h: RequestHandler) => {
      local[e] = h
    })} as never
    new ResetHandler({
      contextTreeService,
      contextTreeSnapshotService,
      curateLogStoreFactory: () => ({
        batchUpdateOperationReviewStatus: sandbox.stub().resolves(),
        list: sandbox.stub().resolves([]),
      }) as never,
      resolveProjectPath: sandbox.stub().returns('/proj') as never,
      reviewBackupStoreFactory: () => ({clear: sandbox.stub().resolves()}) as never,
      transport: tLocal,
    }).setup()
    await local[ResetEvents.EXECUTE](undefined, 'c1')
    expect(analyticsClient.trackSpy.called).to.equal(false)
  })
})
