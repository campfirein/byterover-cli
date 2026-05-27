import type {SinonStub} from 'sinon'

import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'

import {GitVcInitializedError} from '../../../../../src/server/core/domain/errors/task-error.js'
import {InitHandler} from '../../../../../src/server/infra/transport/handlers/init-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {InitEvents} from '../../../../../src/shared/transport/events/init-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

function makeFakeAnalyticsClient(): IAnalyticsClient & {trackSpy: ReturnType<typeof stub>} {
  const trackSpy = stub()
  return {
    abort: stub(),
    flush: stub().resolves({events: []}),
    getRuntimeState: stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: stub().resolves(),
    track: trackSpy,
    trackSpy,
  } as unknown as IAnalyticsClient & {trackSpy: ReturnType<typeof stub>}
}

const sha256HexRegex = /^[0-9a-f]{64}$/

// ==================== Tests ====================

describe('InitHandler', () => {
  let contextTreeService: {
    delete: SinonStub
    exists: SinonStub
    hasGitRepo: SinonStub
    initialize: SinonStub
    resolvePath: SinonStub
  }
  let projectConfigStore: {exists: SinonStub; getModifiedTime: SinonStub; read: SinonStub; write: SinonStub}
  let resolveProjectPath: SinonStub
  let tokenStore: {clear: SinonStub; load: SinonStub; save: SinonStub}
  let transport: MockTransportServer

  beforeEach(() => {
    contextTreeService = {
      delete: stub(),
      exists: stub().resolves(false),
      hasGitRepo: stub().resolves(false),
      initialize: stub().resolves('/test/.brv/context-tree'),
      resolvePath: stub().callsFake((p: string) => p),
    }
    projectConfigStore = {
      exists: stub().resolves(false),
      getModifiedTime: stub(),
      read: stub(),
      write: stub().resolves(),
    }
    resolveProjectPath = stub().returns('/test/project')
    tokenStore = {clear: stub(), load: stub(), save: stub()}
    transport = createMockTransportServer()
  })

  afterEach(() => {
    restore()
  })

  function createHandler(overrides: {analyticsClient?: IAnalyticsClient} = {}): void {
    const handler = new InitHandler({
      analyticsClient: overrides.analyticsClient,
      broadcastToProject: stub() as never,
      cogitPullService: {pull: stub()} as never,
      connectorManagerFactory: stub() as never,
      contextTreeService: contextTreeService as never,
      contextTreeSnapshotService: {
        getChanges: stub(),
        getCurrentState: stub(),
        getSnapshotState: stub(),
        hasSnapshot: stub(),
        initEmptySnapshot: stub(),
        saveSnapshot: stub(),
        saveSnapshotFromState: stub(),
      } as never,
      contextTreeWriterService: {sync: stub()} as never,
      projectConfigStore: projectConfigStore as never,
      resolveProjectPath,
      spaceService: {getSpaces: stub()} as never,
      teamService: {getTeams: stub()} as never,
      tokenStore: tokenStore as never,
      transport,
    })
    handler.setup()
  }

  const defaultExecuteData = {spaceId: 'space-1', teamId: 'team-1'}

  async function callExecuteHandler(
    data: Record<string, string> = defaultExecuteData,
    clientId = 'client-1',
  ): Promise<unknown> {
    const handler = transport._handlers.get(InitEvents.EXECUTE)
    expect(handler, 'init:execute handler should be registered').to.exist
    return handler!(data, clientId)
  }

  const defaultLocalData = {}

  async function callLocalInitHandler(
    data: Record<string, unknown> = defaultLocalData,
    clientId = 'client-1',
  ): Promise<unknown> {
    const handler = transport._handlers.get(InitEvents.LOCAL)
    expect(handler, 'init:local handler should be registered').to.exist
    return handler!(data, clientId)
  }

  describe('git vc guard', () => {
    it('should throw GitVcInitializedError on execute when .git exists', async () => {
      contextTreeService.hasGitRepo.resolves(true)
      createHandler()

      try {
        await callExecuteHandler()
        expect.fail('should have thrown')
      } catch (error) {
        expect(error).to.be.instanceOf(GitVcInitializedError)
        expect((error as Error).message).to.include('ByteRover version control')
      }
    })

    it('should allow local init when .git exists (used by new git-semantics flow)', async () => {
      contextTreeService.hasGitRepo.resolves(true)
      createHandler()

      const result = await callLocalInitHandler()
      expect(result).to.have.property('success', true)
    })

    it('should not throw on execute when .git does not exist', async () => {
      contextTreeService.hasGitRepo.resolves(false)
      tokenStore.load.resolves()
      createHandler()

      try {
        await callExecuteHandler()
        expect.fail('should have thrown (auth error expected)')
      } catch (error) {
        expect(error).to.not.be.instanceOf(GitVcInitializedError)
      }

      expect(contextTreeService.hasGitRepo.calledOnce).to.be.true
    })

    it('should not throw on local init when .git does not exist', async () => {
      contextTreeService.hasGitRepo.resolves(false)
      createHandler()

      const result = await callLocalInitHandler()
      expect(result).to.have.property('success', true)
    })
  })

  describe('brv_init analytics emits', () => {
    it('emits brv_init outcome=success on local init success with had_existing_brv_dir=false', async () => {
      contextTreeService.hasGitRepo.resolves(false)
      projectConfigStore.exists.resolves(false)
      const analyticsClient = makeFakeAnalyticsClient()
      createHandler({analyticsClient})

      await callLocalInitHandler()

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.BRV_INIT)
      expect(calls.length, 'brv_init fires exactly once on local init success').to.equal(1)
      const props = calls[0].args[1] as {had_existing_brv_dir: boolean; outcome: string; project_path_hash: string}
      expect(props.outcome).to.equal('success')
      expect(props.had_existing_brv_dir).to.equal(false)
      expect(props.project_path_hash).to.match(sha256HexRegex)
    })

    it('emits brv_init outcome=success with had_existing_brv_dir=true when already initialized', async () => {
      contextTreeService.hasGitRepo.resolves(false)
      projectConfigStore.exists.resolves(true)
      const analyticsClient = makeFakeAnalyticsClient()
      createHandler({analyticsClient})

      const result = await callLocalInitHandler()
      expect(result).to.have.property('alreadyInitialized', true)

      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.BRV_INIT)
      expect(calls.length).to.equal(1)
      const props = calls[0].args[1] as {had_existing_brv_dir: boolean; outcome: string}
      expect(props.outcome).to.equal('success')
      expect(props.had_existing_brv_dir).to.equal(true)
    })

    it('does NOT emit brv_init on auth-missing execute (no handler-level catch — error propagates uncaught)', async () => {
      contextTreeService.hasGitRepo.resolves(false)
      projectConfigStore.exists.resolves(false)
      tokenStore.load.resolves() // returns undefined → NotAuthenticatedError
      const analyticsClient = makeFakeAnalyticsClient()
      createHandler({analyticsClient})

      let threw = false
      try {
        await callExecuteHandler()
      } catch {
        threw = true
      }

      expect(threw, 'execute should throw the original error').to.equal(true)
      const calls = analyticsClient.trackSpy
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.BRV_INIT)
      expect(calls.length, 'no emit on failure paths without an existing catch').to.equal(0)
    })

    it('is a no-op when no analyticsClient is injected (backward-compat)', async () => {
      contextTreeService.hasGitRepo.resolves(false)
      projectConfigStore.exists.resolves(false)
      createHandler() // no analyticsClient

      const result = await callLocalInitHandler()
      expect(result).to.have.property('success', true)
    })
  })
})
