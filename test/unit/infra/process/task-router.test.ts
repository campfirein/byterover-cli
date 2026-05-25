/**
 * TaskRouter Unit Tests
 *
 * Tests task lifecycle and LLM event routing.
 *
 * Key scenarios:
 * - Task create → store + ACK + broadcast + submit pool
 * - Duplicate task create → idempotent
 * - Task without agentPool → error
 * - Invalid task type → error
 * - Task lifecycle (started, completed, error, cancelled)
 * - Task cancellation (with/without agent)
 * - LLM event routing (active, grace period, expired, unknown taskId)
 * - failTask → error to client + remove
 * - Pool rejection → error sent to client
 * - getTasksForProject lookup
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAgentPool, SubmitTaskResult} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IProjectRegistry} from '../../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {
  LlmEventNames,
  TransportTaskEventNames,
} from '../../../../src/server/core/domain/transport/schemas.js'
import {TaskRouter} from '../../../../src/server/infra/process/task-router.js'

// ============================================================================
// Helpers
// ============================================================================

function makeProjectInfo(projectPath: string) {
  return {
    projectPath,
    registeredAt: Date.now(),
    sanitizedPath: projectPath.replaceAll('/', '_'),
    storagePath: `/data${projectPath}`,
  }
}

function makeStubTransportServer(sandbox: SinonSandbox) {
  const requestHandlers = new Map<string, RequestHandler>()

  const transport: ITransportServer = {
    addToRoom: sandbox.stub(),
    broadcast: sandbox.stub(),
    broadcastTo: sandbox.stub(),
    getPort: sandbox.stub().returns(3000),
    isRunning: sandbox.stub().returns(true),
    onConnection: sandbox.stub(),
    onDisconnection: sandbox.stub(),
    onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
      requestHandlers.set(event, handler)
    }),
    removeFromRoom: sandbox.stub(),
    sendTo: sandbox.stub(),
    start: sandbox.stub().resolves(),
    stop: sandbox.stub().resolves(),
  }

  return {requestHandlers, transport}
}

function makeStubAgentPool(sandbox: SinonSandbox): IAgentPool & {
  cancelQueuedTask: SinonStub
  notifyTaskCompleted: SinonStub
  submitTask: SinonStub
} {
  return {
    cancelQueuedTask: sandbox.stub().returns(false),
    getEntries: sandbox.stub().returns([]),
    getSize: sandbox.stub().returns(0),
    handleAgentDisconnected: sandbox.stub(),
    hasAgent: sandbox.stub().returns(false),
    markIdle: sandbox.stub(),
    notifyTaskCompleted: sandbox.stub(),
    shutdown: sandbox.stub().resolves(),
    submitTask: sandbox.stub().resolves({success: true} as SubmitTaskResult),
  }
}

function makeStubProjectRegistry(sandbox: SinonSandbox): IProjectRegistry & {get: SinonStub} {
  return {
    get: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    getAll: sandbox.stub().returns(new Map()),
    register: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    unregister: sandbox.stub().returns(true),
  }
}

function makeStubProjectRouter(sandbox: SinonSandbox): IProjectRouter & {broadcastToProject: SinonStub} {
  return {
    addToProjectRoom: sandbox.stub(),
    broadcastToProject: sandbox.stub(),
    getProjectMembers: sandbox.stub().returns([]),
    removeFromProjectRoom: sandbox.stub(),
  }
}

function makeTaskCreateRequest(overrides: Record<string, unknown> = {}) {
  return {
    content: 'test content',
    projectPath: '/app',
    taskId: randomUUID(),
    type: 'curate' as const,
    ...overrides,
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('TaskRouter', () => {
  let sandbox: SinonSandbox
  let transportHelper: ReturnType<typeof makeStubTransportServer>
  let agentPool: ReturnType<typeof makeStubAgentPool>
  let projectRegistry: ReturnType<typeof makeStubProjectRegistry>
  let projectRouter: ReturnType<typeof makeStubProjectRouter>
  let getAgentForProject: SinonStub
  let router: TaskRouter

  beforeEach(() => {
    sandbox = createSandbox()

    transportHelper = makeStubTransportServer(sandbox)
    agentPool = makeStubAgentPool(sandbox)
    projectRegistry = makeStubProjectRegistry(sandbox)
    projectRouter = makeStubProjectRouter(sandbox)
    getAgentForProject = sandbox.stub().returns('agent-1')

    router = new TaskRouter({
      agentPool,
      getAgentForProject,
      projectRegistry,
      projectRouter,
      transport: transportHelper.transport,
    })

    router.setup()
  })

  afterEach(() => {
    sandbox.restore()
  })

  // ==========================================================================
  // Task Create
  // ==========================================================================

  describe('task:create', () => {
    it('should accept task and return taskId', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      expect(handler).to.exist

      const request = makeTaskCreateRequest()
      const result = await handler!(request, 'client-1')

      expect(result).to.deep.equal({taskId: request.taskId})
    })

    it('should send ACK to client after hooks resolve', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      await handler!(request, 'client-1')

      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        TransportTaskEventNames.ACK,
        {taskId: request.taskId},
      )).to.be.true
    })

    it('should broadcast task:created to project room', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      handler!(request, 'client-1')

      const broadcastCall = projectRouter.broadcastToProject.getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.CREATED,
      )
      expect(broadcastCall).to.exist
      expect(broadcastCall!.args[0]).to.equal(makeProjectInfo('/app').sanitizedPath)
      expect(broadcastCall!.args[2]).to.have.property('taskId', request.taskId)
      expect(broadcastCall!.args[2]).to.have.property('content', 'test content')
    })

    it('should submit task to agent pool', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      handler!(request, 'client-1')

      // Wait for async pool submission
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(agentPool.submitTask.calledOnce).to.be.true
      const submittedTask = agentPool.submitTask.firstCall.args[0]
      expect(submittedTask).to.have.property('taskId', request.taskId)
      expect(submittedTask).to.have.property('clientId', 'client-1')
      expect(submittedTask).to.have.property('content', 'test content')
      expect(submittedTask).to.have.property('type', 'curate')
    })

    describe('reviewDisabled stamping', () => {
      it('stamps reviewDisabled=true on TaskExecute when resolver returns true', async () => {
        const routerWithResolver = new TaskRouter({
          agentPool,
          getAgentForProject,
          isReviewDisabled: sandbox.stub().resolves(true),
          projectRegistry,
          projectRouter,
          transport: transportHelper.transport,
        })
        routerWithResolver.setup()

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
        const request = makeTaskCreateRequest()
        await handler!(request, 'client-1')

        await new Promise((resolve) => { setTimeout(resolve, 10) })

        const submittedTask = agentPool.submitTask.firstCall.args[0]
        expect(submittedTask).to.have.property('reviewDisabled', true)
      })

      it('stamps reviewDisabled=false on TaskExecute when resolver returns false', async () => {
        const routerWithResolver = new TaskRouter({
          agentPool,
          getAgentForProject,
          isReviewDisabled: sandbox.stub().resolves(false),
          projectRegistry,
          projectRouter,
          transport: transportHelper.transport,
        })
        routerWithResolver.setup()

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
        const request = makeTaskCreateRequest()
        await handler!(request, 'client-1')

        await new Promise((resolve) => { setTimeout(resolve, 10) })

        const submittedTask = agentPool.submitTask.firstCall.args[0]
        expect(submittedTask).to.have.property('reviewDisabled', false)
      })

      it('omits reviewDisabled from TaskExecute when no resolver is configured', async () => {
        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
        const request = makeTaskCreateRequest()
        await handler!(request, 'client-1')

        await new Promise((resolve) => { setTimeout(resolve, 10) })

        const submittedTask = agentPool.submitTask.firstCall.args[0]
        expect(submittedTask).to.not.have.property('reviewDisabled')
      })

      it('stamps explicit reviewDisabled=false when resolver throws (fail-open with single concrete value)', async () => {
        // Returning undefined here would re-introduce the daemon/agent divergence the
        // snapshot is meant to prevent: daemon stamps no field → CurateLogHandler treats
        // as enabled (`?? false`), but the agent process opens no ALS scope and may
        // observe a different value from .brv/config.json. Stamping a concrete `false`
        // keeps both sides aligned (review enabled, fail-open).
        const routerWithResolver = new TaskRouter({
          agentPool,
          getAgentForProject,
          isReviewDisabled: sandbox.stub().rejects(new Error('config read failed')),
          projectRegistry,
          projectRouter,
          transport: transportHelper.transport,
        })
        routerWithResolver.setup()

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
        const request = makeTaskCreateRequest()
        await handler!(request, 'client-1')

        await new Promise((resolve) => { setTimeout(resolve, 10) })

        const submittedTask = agentPool.submitTask.firstCall.args[0]
        expect(submittedTask).to.have.property('reviewDisabled', false)
      })
    })

    it('should return same taskId for duplicate create (idempotent)', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      const result1 = await handler!(request, 'client-1')
      const result2 = await handler!(request, 'client-1')

      expect(result1).to.deep.equal(result2)
      // Only submitted once
      expect(agentPool.submitTask.calledOnce).to.be.true
    })

    it('should send error when no agentPool available', () => {
      // Create router without agentPool
      const helper = makeStubTransportServer(sandbox)
      const routerNoPool = new TaskRouter({
        getAgentForProject: sandbox.stub(),
        projectRegistry,
        projectRouter,
        transport: helper.transport,
      })
      routerNoPool.setup()

      const handler = helper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      handler!(request, 'client-1')

      // Should send error to client
      const errorCall = (helper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.ERROR,
      )
      expect(errorCall).to.exist
      expect(errorCall!.args[2]).to.have.property('taskId', request.taskId)
      expect(errorCall!.args[2].error).to.have.property('name', 'AgentNotAvailableError')
    })

    it('should send error for invalid task type', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'invalid_type'})

      handler!(request, 'client-1')

      // Should send error to client
      const errorCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.ERROR,
      )
      expect(errorCall).to.exist
      expect(errorCall!.args[2]).to.have.property('taskId', request.taskId)
    })

    it('should handle pool rejection by sending error to client', async () => {
      agentPool.submitTask.resolves({
        message: 'Pool is full',
        reason: 'pool_full',
        success: false,
      } as SubmitTaskResult)

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      handler!(request, 'client-1')

      // Wait for async pool submission
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      // Should send error to client after pool rejection
      const errorCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.ERROR,
      )
      expect(errorCall).to.exist
      expect(errorCall!.args[2]).to.have.property('taskId', request.taskId)
    })

    it('should include files and clientCwd in submitted task', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({
        clientCwd: '/home/user/project',
        files: ['src/auth.ts', 'src/middleware.ts'],
      })

      handler!(request, 'client-1')

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      const submittedTask = agentPool.submitTask.firstCall.args[0]
      expect(submittedTask).to.have.property('clientCwd', '/home/user/project')
      expect(submittedTask.files).to.deep.equal(['src/auth.ts', 'src/middleware.ts'])
    })

    it('should derive worktreeRoot from resolver when omitted', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'brv-task-router-project-'))
      const worktreeRoot = join(projectRoot, 'packages', 'api')
      mkdirSync(join(projectRoot, '.brv'), {recursive: true})
      writeFileSync(join(projectRoot, '.brv', 'config.json'), '{}')
      mkdirSync(worktreeRoot, {recursive: true})
      writeFileSync(join(worktreeRoot, '.brv'), JSON.stringify({projectRoot}))
      const canonicalProjectRoot = realpathSync(projectRoot)
      const canonicalWorkspaceRoot = realpathSync(worktreeRoot)

      try {
        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
        const request = makeTaskCreateRequest({
          clientCwd: worktreeRoot,
          projectPath: canonicalProjectRoot,
          worktreeRoot: undefined,
        })

        handler!(request, 'client-1')

        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })

        const submittedTask = agentPool.submitTask.firstCall.args[0]
        expect(submittedTask.worktreeRoot).to.equal(canonicalWorkspaceRoot)
      } finally {
        rmSync(projectRoot, {force: true, recursive: true})
      }
    })

    it('should fall back worktreeRoot to projectPath when resolver returns null', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({
        clientCwd: '/outside/project',
        projectPath: '/app',
        worktreeRoot: undefined,
      })

      handler!(request, 'client-1')

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      const submittedTask = agentPool.submitTask.firstCall.args[0]
      expect(submittedTask.worktreeRoot).to.equal('/app')
    })

    it('should reject worktreeRoot outside projectPath', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()

      const result = await handler!(
        {
          clientCwd: '/app/packages/api',
          content: 'invalid workspace',
          projectPath: '/app',
          taskId,
          type: 'query',
          worktreeRoot: '/other-project',
        },
        'client-1',
      )

      expect(result).to.deep.equal({taskId})
      expect(agentPool.submitTask.called).to.be.false
      const errorCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.ERROR,
      )
      expect(errorCall).to.exist
      expect(errorCall!.args[2].error.message).to.include('worktreeRoot')
    })

    it('should surface resolver errors instead of swallowing them', async () => {
      const projectRoot = mkdtempSync(join(tmpdir(), 'brv-task-router-broken-link-'))
      const worktreeRoot = join(projectRoot, 'packages', 'api')
      mkdirSync(worktreeRoot, {recursive: true})
      writeFileSync(join(worktreeRoot, '.brv'), JSON.stringify({projectRoot: '/missing/project'}))

      try {
        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
        const taskId = randomUUID()

        const result = await handler!(
          {
            clientCwd: worktreeRoot,
            content: 'broken link',
            taskId,
            type: 'query',
          },
          'client-1',
        )

        expect(result).to.deep.equal({taskId})
        expect(agentPool.submitTask.called).to.be.false
        const errorCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
          (c) => c.args[1] === TransportTaskEventNames.ERROR,
        )
        expect(errorCall).to.exist
        expect(errorCall!.args[2].error.message).to.include('Worktree pointer broken')
      } finally {
        rmSync(projectRoot, {force: true, recursive: true})
      }
    })
  })

  // ==========================================================================
  // preDispatchCheck (ENG-2126 fix #4)
  // ==========================================================================

  describe('preDispatchCheck', () => {
    it('dispatches to agent pool when check resolves eligible', async () => {
      const preDispatchCheck = sandbox.stub().resolves({eligible: true})

      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        preDispatchCheck,
        projectRegistry,
        projectRouter,
        transport: transportHelper.transport,
      })
      router.setup()

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'dream'})
      await handler!(request, 'client-1')

      expect(preDispatchCheck.calledOnce, 'preDispatchCheck should be invoked').to.be.true
      expect((agentPool.submitTask as SinonStub).calledOnce, 'eligible task should reach the agent pool').to.be.true
    })

    it('short-circuits to task:completed with skip reason when check resolves ineligible', async () => {
      const preDispatchCheck = sandbox.stub().resolves({eligible: false, skipResult: 'Dream skipped: Queue not empty (2 tasks pending)'})

      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        preDispatchCheck,
        projectRegistry,
        projectRouter,
        transport: transportHelper.transport,
      })
      router.setup()

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'dream'})
      await handler!(request, 'client-1')

      // Agent pool never receives the task
      expect((agentPool.submitTask as SinonStub).called, 'ineligible task must not reach the agent pool').to.be.false

      // Client receives task:completed with the skip reason
      const completedCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[0] === 'client-1' && c.args[1] === TransportTaskEventNames.COMPLETED,
      )
      expect(completedCall, 'expected task:completed to be sent').to.exist
      expect(completedCall!.args[2].result).to.equal('Dream skipped: Queue not empty (2 tasks pending)')
      expect(completedCall!.args[2].taskId).to.equal(request.taskId)
    })

    it('falls through to dispatch when check throws (fail-open)', async () => {
      const preDispatchCheck = sandbox.stub().rejects(new Error('state read failed'))

      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        preDispatchCheck,
        projectRegistry,
        projectRouter,
        transport: transportHelper.transport,
      })
      router.setup()

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'dream'})
      await handler!(request, 'client-1')

      // Errors in pre-check must not block dispatch — agent's own gate check is the fallback
      expect((agentPool.submitTask as SinonStub).calledOnce, 'fail-open: task should still reach the agent').to.be.true
    })

    it('is skipped when no preDispatchCheck is configured', async () => {
      // default router in beforeEach has no preDispatchCheck
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'dream'})
      await handler!(request, 'client-1')

      expect((agentPool.submitTask as SinonStub).calledOnce).to.be.true
    })

    it('does NOT decrement agentPool.activeTasks counter when pre-check skips (the task was never submitted)', async () => {
      // Regression for Codex P1: handleTaskCompleted unconditionally calls
      // agentPool.notifyTaskCompleted, which decrements activeTasks. For a
      // pre-dispatch skip the task never reached the pool, so notifying would
      // undercount real load and let drainQueue dispatch an extra queued task.
      const preDispatchCheck = sandbox.stub().resolves({eligible: false, skipResult: 'Dream skipped: Queue not empty (3 tasks pending)'})

      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        preDispatchCheck,
        projectRegistry,
        projectRouter,
        transport: transportHelper.transport,
      })
      router.setup()

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'dream'})
      await handler!(request, 'client-1')

      expect(agentPool.notifyTaskCompleted.called, 'pre-check skip must not notify the agent pool').to.be.false
    })

    it('does NOT fire onTaskCompleted lifecycle hooks when pre-check skips', async () => {
      // Regression for RyanNg #5: hooks that act on completed tasks (metrics,
      // counters) should not see pre-check skips as completions.
      const hookOnCompleted = sandbox.stub().resolves()
      const preDispatchCheck = sandbox.stub().resolves({eligible: false, skipResult: 'Dream skipped: Queue not empty (1 task pending)'})
      const hookHelper = makeStubTransportServer(sandbox)

      const routerWithHooks = new TaskRouter({
        agentPool,
        getAgentForProject,
        lifecycleHooks: [{onTaskCompleted: hookOnCompleted}],
        preDispatchCheck,
        projectRegistry,
        projectRouter,
        transport: hookHelper.transport,
      })
      routerWithHooks.setup()

      const handler = hookHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'dream'})
      await handler!(request, 'client-1')

      // Allow async hook chain to flush
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(hookOnCompleted.called, 'onTaskCompleted must not fire for pre-check skips').to.be.false
    })

    it('still broadcasts task:completed to the project room on pre-check skip (so REPL/TUI see it)', async () => {
      const preDispatchCheck = sandbox.stub().resolves({eligible: false, skipResult: 'Dream skipped: Queue not empty (1 task pending)'})

      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        preDispatchCheck,
        projectRegistry,
        projectRouter,
        transport: transportHelper.transport,
      })
      router.setup()

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest({type: 'dream'})
      await handler!(request, 'client-1')

      const broadcastCall = projectRouter.broadcastToProject.getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.COMPLETED,
      )
      expect(broadcastCall, 'project room should still see task:completed for skips').to.exist
      expect(broadcastCall!.args[2].result).to.equal('Dream skipped: Queue not empty (1 task pending)')
    })
  })

  // ==========================================================================
  // Task Lifecycle
  // ==========================================================================

  describe('task lifecycle', () => {
    let taskId: string

    beforeEach(async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      taskId = request.taskId
      await createHandler!(request, 'client-1')
      // Reset sendTo history to only track lifecycle events
      ;(transportHelper.transport.sendTo as SinonStub).resetHistory()
      projectRouter.broadcastToProject.resetHistory()
    })

    it('should route task:started to client and broadcast', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.STARTED)

      handler!({taskId}, 'agent-1')

      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        TransportTaskEventNames.STARTED,
        {taskId},
      )).to.be.true

      // Should broadcast to project room with task metadata
      const broadcastCall = projectRouter.broadcastToProject.getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.STARTED,
      )
      expect(broadcastCall).to.exist
      expect(broadcastCall!.args[2]).to.have.property('taskId', taskId)
      expect(broadcastCall!.args[2]).to.have.property('content', 'test content')
    })

    it('should route task:completed to client and broadcast', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)

      handler!({result: 'done', taskId}, 'agent-1')

      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        TransportTaskEventNames.COMPLETED,
        {result: 'done', taskId},
      )).to.be.true
    })

    it('should notify agentPool on task:completed', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)

      handler!({result: 'done', taskId}, 'agent-1')

      expect(agentPool.notifyTaskCompleted.calledWith('/app')).to.be.true
    })

    it('should route task:error to client and broadcast', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.ERROR)

      const error = {code: 'ERR_UNKNOWN', message: 'something broke', name: 'TaskError'}
      handler!({error, taskId}, 'agent-1')

      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        TransportTaskEventNames.ERROR,
        {error, taskId},
      )).to.be.true
    })

    it('should notify agentPool on task:error', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.ERROR)

      handler!({error: {message: 'fail', name: 'Error'}, taskId}, 'agent-1')

      expect(agentPool.notifyTaskCompleted.calledWith('/app')).to.be.true
    })

    it('should notify agentPool on task:completed for daemon-submitted tasks', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)

      handler!({projectPath: '/daemon-app', result: 'done', taskId: 'daemon-task'}, 'agent-1')

      expect(agentPool.notifyTaskCompleted.calledWith('/daemon-app')).to.be.true
    })

    it('should notify agentPool on task:error for daemon-submitted tasks', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.ERROR)

      handler!({error: {message: 'fail', name: 'Error'}, projectPath: '/daemon-app', taskId: 'daemon-task'}, 'agent-1')

      expect(agentPool.notifyTaskCompleted.calledWith('/daemon-app')).to.be.true
    })

    it('should route task:cancelled to client and broadcast', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCELLED)

      handler!({taskId}, 'agent-1')

      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        TransportTaskEventNames.CANCELLED,
        {taskId},
      )).to.be.true
    })

    it('should notify agentPool on task:cancelled so the project queue drains (T1.3 queue-advance)', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCELLED)

      handler!({taskId}, 'agent-1')

      expect(agentPool.notifyTaskCompleted.calledWith('/app')).to.be.true
    })

    it('should remove task from active tasks after completion', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)

      handler!({result: 'done', taskId}, 'agent-1')

      expect(router.getTasksForProject('/app')).to.have.lengthOf(0)
    })

    it('should remove task from active tasks after error', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.ERROR)

      handler!({error: {message: 'fail', name: 'Error'}, taskId}, 'agent-1')

      expect(router.getTasksForProject('/app')).to.have.lengthOf(0)
    })
  })

  // ==========================================================================
  // Task Cancellation
  // ==========================================================================

  describe('task cancellation', () => {
    let taskId: string

    beforeEach(async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      taskId = request.taskId
      await createHandler!(request, 'client-1')
      ;(transportHelper.transport.sendTo as SinonStub).resetHistory()
    })

    it('should forward cancel to agent when agent connected', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)

      const result = await handler!({taskId}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'agent-1',
        TransportTaskEventNames.CANCEL,
        {taskId},
      )).to.be.true
    })

    it('should cancel task locally when no agent connected', async () => {
      getAgentForProject.resetBehavior()

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)

      const result = await handler!({taskId}, 'client-1')

      expect(result).to.deep.equal({success: true})

      // Should send cancelled to client directly
      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        TransportTaskEventNames.CANCELLED,
        {taskId},
      )).to.be.true

      // Task should be removed
      expect(router.getTasksForProject('/app')).to.have.lengthOf(0)
    })

    it('should return error for unknown taskId', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)

      const result = await handler!({taskId: 'nonexistent'}, 'client-1')

      expect(result).to.deep.equal({error: 'Task not found', success: false})
    })

    it('returns success on a retry after the task was already cancelled (idempotent, in-memory fast path)', async () => {
      // First cancel succeeds and moves the task into completedTasks via
      // handleTaskCancelled. A retry (e.g. due to a dropped response in
      // withDaemonRetry) sees the task gone from this.tasks but still
      // present in completedTasks with status: 'cancelled' — the daemon
      // returns success so the retry isn't reported as a misleading failure.
      const cancelledHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCELLED)
      cancelledHandler!({taskId}, 'agent-1')

      const cancelHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId}, 'client-1')

      expect(result).to.deep.equal({success: true})
    })

    it('returns success on a retry after completedTasks has aged out — durable via persistent history store', async () => {
      // Simulate the after-grace-period case: the task entry has been
      // removed from in-memory completedTasks by the cleanup setTimeout,
      // but the persistent task history store still has it with status:
      // 'cancelled' (written by TaskHistoryHook.onTaskCancelled).
      //
      // The daemon must consult the store and still return success so
      // longer-delayed retries don't get a misleading "Task not found".
      const getStoreStub = sandbox.stub().returns({
        getById: sandbox.stub().resolves({status: 'cancelled', taskId}),
      })
      const resolveClientStub = sandbox.stub().returns('/app')

      const routerWithStore = new TaskRouter({
        agentPool,
        getAgentForProject,
        getTaskHistoryStore: getStoreStub,
        projectRegistry,
        projectRouter,
        resolveClientProjectPath: resolveClientStub,
        transport: transportHelper.transport,
      })
      routerWithStore.setup()

      const cancelHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId: 'aged-out-task'}, 'client-1')

      expect(result).to.deep.equal({success: true})
      expect(getStoreStub.calledOnceWithExactly('/app')).to.equal(true)
    })

    it('still returns Task not found when the history store has a non-cancelled status (e.g. completed)', async () => {
      // Negative case: only `status: cancelled` history entries map to
      // idempotent success. A completed-then-deleted task should still
      // surface as "Task not found" so the user sees a real signal.
      const getStoreStub = sandbox.stub().returns({
        getById: sandbox.stub().resolves({status: 'completed', taskId}),
      })

      new TaskRouter({
        agentPool,
        getAgentForProject,
        getTaskHistoryStore: getStoreStub,
        projectRegistry,
        projectRouter,
        resolveClientProjectPath: sandbox.stub().returns('/app'),
        transport: transportHelper.transport,
      }).setup()

      const cancelHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId: 'completed-task'}, 'client-1')

      expect(result).to.deep.equal({error: 'Task not found', success: false})
    })

    describe('queued task cancellation (T1.3)', () => {
      it('cancels a queued task directly via agentPool, broadcasts cancelled, never forwards to agent', async () => {
        agentPool.cancelQueuedTask.returns(true)
        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)

        const result = await handler!({taskId}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect(agentPool.cancelQueuedTask.calledOnceWithExactly(taskId)).to.equal(true)

        // Agent must NOT receive the forwarded cancel
        const forwardedToAgent = (transportHelper.transport.sendTo as SinonStub).getCalls().some(
          (c) => c.args[0] === 'agent-1' && c.args[1] === TransportTaskEventNames.CANCEL,
        )
        expect(forwardedToAgent).to.equal(false)

        // Client receives task:cancelled directly from the daemon
        expect((transportHelper.transport.sendTo as SinonStub).calledWith(
          'client-1',
          TransportTaskEventNames.CANCELLED,
          {taskId},
        )).to.be.true

        // Task removed from in-memory map
        expect(router.getTasksForProject('/app')).to.have.lengthOf(0)
      })

      it('does NOT call agentPool.notifyTaskCompleted for queued cancel (the task never occupied a pool slot)', async () => {
        agentPool.cancelQueuedTask.returns(true)
        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)

        await handler!({taskId}, 'client-1')

        expect(agentPool.notifyTaskCompleted.called).to.equal(false)
      })

      it('falls through to forward-to-agent when cancelQueuedTask returns false (task is mid-execution)', async () => {
        agentPool.cancelQueuedTask.returns(false)
        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)

        const result = await handler!({taskId}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect((transportHelper.transport.sendTo as SinonStub).calledWith(
          'agent-1',
          TransportTaskEventNames.CANCEL,
          {taskId},
        )).to.be.true
      })

      it('returns success on a sequential retry after queued cancel — in-memory fast path', async () => {
        // Regression guard: cancelTaskLocally must seed completedTasks with a
        // 'cancelled' entry so the fast-path idempotency check at handleTaskCancel
        // catches a sequential retry. Without that seeding, the retry would race
        // the fire-and-forget notifyHooksCancelled to the durable history store
        // and could return a misleading "Task not found".
        agentPool.cancelQueuedTask.returns(true)
        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CANCEL)

        const first = await handler!({taskId}, 'client-1')
        const second = await handler!({taskId}, 'client-1')

        expect(first).to.deep.equal({success: true})
        expect(second).to.deep.equal({success: true})
      })
    })
  })

  // ==========================================================================
  // LLM Event Routing
  // ==========================================================================

  describe('LLM event routing', () => {
    let taskId: string

    beforeEach(async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      taskId = request.taskId
      await createHandler!(request, 'client-1')
      ;(transportHelper.transport.sendTo as SinonStub).resetHistory()
      projectRouter.broadcastToProject.resetHistory()
    })

    it('should route llmservice:chunk to client and project room', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.CHUNK)
      expect(handler).to.exist

      handler!({content: 'hello', sessionId: 'sess-1', taskId, type: 'text'}, 'agent-1')

      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        LlmEventNames.CHUNK,
      )).to.be.true

      const broadcastCall = projectRouter.broadcastToProject.getCalls().find(
        (c) => c.args[1] === LlmEventNames.CHUNK,
      )
      expect(broadcastCall).to.exist
    })

    it('should route llmservice:response to client', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.RESPONSE)

      handler!({content: 'answer', sessionId: 'sess-1', taskId}, 'agent-1')

      const sendCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === LlmEventNames.RESPONSE,
      )
      expect(sendCall).to.exist
      expect(sendCall!.args[0]).to.equal('client-1')
    })

    it('should route llmservice:toolCall to client', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.TOOL_CALL)

      handler!({args: {path: '/file'}, sessionId: 'sess-1', taskId, toolName: 'read-file'}, 'agent-1')

      const sendCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === LlmEventNames.TOOL_CALL,
      )
      expect(sendCall).to.exist
    })

    it('should route llmservice:toolResult to client', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.TOOL_RESULT)

      handler!({result: 'file contents', sessionId: 'sess-1', success: true, taskId, toolName: 'read-file'}, 'agent-1')

      const sendCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === LlmEventNames.TOOL_RESULT,
      )
      expect(sendCall).to.exist
    })

    it('should route LLM events during grace period (after task completed)', () => {
      // Complete the task first
      const completedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'done', taskId}, 'agent-1')

      ;(transportHelper.transport.sendTo as SinonStub).resetHistory()

      // LLM event arrives late — should still route via grace period
      const handler = transportHelper.requestHandlers.get(LlmEventNames.CHUNK)
      handler!({content: 'late chunk', sessionId: 'sess-1', taskId, type: 'text'}, 'agent-1')

      // Should still route to client (grace period active)
      const sendCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === LlmEventNames.CHUNK,
      )
      expect(sendCall).to.exist
      expect(sendCall!.args[0]).to.equal('client-1')
    })

    it('should silently drop LLM events for unknown taskId', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.CHUNK)

      handler!({content: 'orphan', sessionId: 'sess-1', taskId: 'unknown-task', type: 'text'}, 'agent-1')

      // Should NOT send to any client
      expect((transportHelper.transport.sendTo as SinonStub).called).to.be.false
    })

    it('should ignore LLM events without taskId', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.CHUNK)

      handler!({content: 'no task id', sessionId: 'sess-1', type: 'text'}, 'agent-1')

      expect((transportHelper.transport.sendTo as SinonStub).called).to.be.false
    })

    it('should route llmservice:thinking to client', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.THINKING)

      handler!({sessionId: 'sess-1', taskId}, 'agent-1')

      const sendCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === LlmEventNames.THINKING,
      )
      expect(sendCall).to.exist
    })

    it('should route llmservice:error to client', () => {
      const handler = transportHelper.requestHandlers.get(LlmEventNames.ERROR)

      handler!({error: 'model error', sessionId: 'sess-1', taskId}, 'agent-1')

      const sendCall = (transportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === LlmEventNames.ERROR,
      )
      expect(sendCall).to.exist
    })
  })

  // ==========================================================================
  // failTask
  // ==========================================================================

  describe('failTask', () => {
    let taskId: string

    beforeEach(async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      taskId = request.taskId
      await createHandler!(request, 'client-1')
      ;(transportHelper.transport.sendTo as SinonStub).resetHistory()
      projectRouter.broadcastToProject.resetHistory()
    })

    it('should send error to client and remove task', () => {
      const error = {code: 'ERR_AGENT_DISCONNECTED', message: 'Agent disconnected', name: 'AgentDisconnectedError'}

      router.failTask(taskId, error)

      expect((transportHelper.transport.sendTo as SinonStub).calledWith(
        'client-1',
        TransportTaskEventNames.ERROR,
        {error, taskId},
      )).to.be.true

      expect(router.getTasksForProject('/app')).to.have.lengthOf(0)
    })

    it('should broadcast error to project room', () => {
      const error = {message: 'Agent disconnected', name: 'AgentDisconnectedError'}

      router.failTask(taskId, error)

      const broadcastCall = projectRouter.broadcastToProject.getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.ERROR,
      )
      expect(broadcastCall).to.exist
    })

    it('should be no-op for unknown taskId', () => {
      router.failTask('nonexistent', {message: 'test', name: 'Error'})

      expect((transportHelper.transport.sendTo as SinonStub).called).to.be.false
    })
  })

  // ==========================================================================
  // Lifecycle hooks
  // ==========================================================================

  describe('lifecycle hooks', () => {
    let hookOnCreate: SinonStub
    let hookOnCompleted: SinonStub
    let hookOnError: SinonStub
    let hookOnCancelled: SinonStub
    let hookOnToolResult: SinonStub
    let hookCleanup: SinonStub
    let routerWithHooks: TaskRouter
    let hookTransportHelper: ReturnType<typeof makeStubTransportServer>

    beforeEach(() => {
      hookOnCreate = sandbox.stub().resolves({logId: 'cur-123'})
      hookOnCompleted = sandbox.stub().resolves()
      hookOnError = sandbox.stub().resolves()
      hookOnCancelled = sandbox.stub().resolves()
      hookOnToolResult = sandbox.stub()
      hookCleanup = sandbox.stub()
      hookTransportHelper = makeStubTransportServer(sandbox)
      routerWithHooks = new TaskRouter({
        agentPool,
        getAgentForProject,
        lifecycleHooks: [
          {
            cleanup: hookCleanup,
            onTaskCancelled: hookOnCancelled,
            onTaskCompleted: hookOnCompleted,
            onTaskCreate: hookOnCreate,
            onTaskError: hookOnError,
            onToolResult: hookOnToolResult,
          },
        ],
        projectRegistry,
        projectRouter,
        transport: hookTransportHelper.transport,
      })
      routerWithHooks.setup()
    })

    it('should include logId in task:ack when hook returns one', async () => {
      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      await handler!(request, 'client-1')

      expect(
        (hookTransportHelper.transport.sendTo as SinonStub).calledWith(
          'client-1',
          TransportTaskEventNames.ACK,
          {logId: 'cur-123', taskId: request.taskId},
        ),
      ).to.be.true
    })

    it('should include logId in task:completed when hook set it', async () => {
      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      await handler!(request, 'client-1')

      const completedHandler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'done', taskId: request.taskId}, 'agent-1')

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      const completedCall = (hookTransportHelper.transport.sendTo as SinonStub).getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.COMPLETED,
      )
      expect(completedCall).to.exist
      expect(completedCall!.args[2]).to.have.property('logId', 'cur-123')
    })

    it('should call onTaskError and cleanup when failTask is called', async () => {
      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      await handler!(request, 'client-1')

      routerWithHooks.failTask(request.taskId, {message: 'fail', name: 'Error'})

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(hookOnError.calledOnce).to.be.true
      expect(hookCleanup.calledWith(request.taskId)).to.be.true
    })

    it('should call onTaskCancelled and cleanup on task:cancelled from agent', async () => {
      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      await handler!(request, 'client-1')

      const cancelledHandler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CANCELLED)
      cancelledHandler!({taskId: request.taskId}, 'agent-1')

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(hookOnCancelled.calledOnce).to.be.true
      expect(hookOnError.called).to.be.false
      expect(hookCleanup.calledWith(request.taskId)).to.be.true
    })

    it('should call onTaskError and cleanup on task:error from agent', async () => {
      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      await handler!(request, 'client-1')

      const errorHandler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.ERROR)
      errorHandler!({error: {message: 'fail', name: 'Error'}, taskId: request.taskId}, 'agent-1')

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(hookOnError.calledOnce).to.be.true
      expect(hookCleanup.calledWith(request.taskId)).to.be.true
    })

    it('should NOT call onTaskCreate when no agentPool available', async () => {
      const helper = makeStubTransportServer(sandbox)
      const routerNoPool = new TaskRouter({
        getAgentForProject: sandbox.stub(),
        lifecycleHooks: [{cleanup: hookCleanup, onTaskCreate: hookOnCreate}],
        projectRegistry,
        projectRouter,
        transport: helper.transport,
      })
      routerNoPool.setup()

      const handler = helper.requestHandlers.get(TransportTaskEventNames.CREATE)
      await handler!(makeTaskCreateRequest(), 'client-1')

      expect(hookOnCreate.called).to.be.false
    })

    it('should NOT call onTaskCreate when invalid task type', async () => {
      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      await handler!(makeTaskCreateRequest({type: 'invalid_type'}), 'client-1')

      expect(hookOnCreate.called).to.be.false
    })

    it('should call onTaskError when pool rejects task', async () => {
      agentPool.submitTask.resolves({
        message: 'Pool is full',
        reason: 'pool_full',
        success: false,
      } as SubmitTaskResult)

      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      await handler!(request, 'client-1')

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(hookOnError.calledOnce).to.be.true
      expect(hookCleanup.calledWith(request.taskId)).to.be.true
    })

    it('should NOT call onToolResult for grace-period completed tasks', async () => {
      const handler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      await handler!(request, 'client-1')

      // Complete the task (moves to grace period)
      const completedHandler = hookTransportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'done', taskId: request.taskId}, 'agent-1')

      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      hookOnToolResult.resetHistory()

      // Tool result arrives during grace period (task is in completedTasks, NOT tasks)
      const toolResultHandler = hookTransportHelper.requestHandlers.get(LlmEventNames.TOOL_RESULT)
      toolResultHandler!(
        {result: 'file', sessionId: 'sess-1', success: true, taskId: request.taskId, toolName: 'curate'},
        'agent-1',
      )

      expect(hookOnToolResult.called).to.be.false
    })
  })

  // ==========================================================================
  // getTasksForProject
  // ==========================================================================

  describe('getTasksForProject', () => {
    beforeEach(() => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)

      // Task for /app
      createHandler!(makeTaskCreateRequest({projectPath: '/app', taskId: randomUUID()}), 'client-1')
      // Task for /other
      createHandler!(makeTaskCreateRequest({projectPath: '/other', taskId: randomUUID()}), 'client-2')
      // Task without projectPath
      createHandler!(makeTaskCreateRequest({projectPath: undefined, taskId: randomUUID()}), 'client-3')
    })

    it('should return tasks for specific project (includes unassigned)', () => {
      const tasks = router.getTasksForProject('/app')
      // Should include /app task + unassigned task (projectPath === undefined)
      expect(tasks).to.have.lengthOf(2)
      const projectPaths = tasks.map((t) => t.projectPath)
      expect(projectPaths).to.include('/app')
      expect(projectPaths).to.include(undefined)
    })

    it('should NOT include tasks from other projects', () => {
      const tasks = router.getTasksForProject('/app')
      const otherProjectTasks = tasks.filter((t) => t.projectPath === '/other')
      expect(otherProjectTasks).to.have.lengthOf(0)
    })

    it('should return only unassigned tasks when no projectPath given', () => {
      const tasks = router.getTasksForProject()
      for (const task of tasks) {
        expect(task.projectPath).to.be.undefined
      }
    })
  })

  // ==========================================================================
  // task:list (snapshot for web UI)
  // ==========================================================================

  describe('task:list', () => {
    it('should register a handler for task:list', () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      expect(handler).to.exist
    })

    it('should return active tasks for the requested project (and unassigned)', async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const appTaskId = randomUUID()
      const otherTaskId = randomUUID()
      const unassignedTaskId = randomUUID()
      createHandler!(makeTaskCreateRequest({projectPath: '/app', taskId: appTaskId}), 'client-1')
      createHandler!(makeTaskCreateRequest({projectPath: '/other', taskId: otherTaskId}), 'client-2')
      createHandler!(makeTaskCreateRequest({projectPath: undefined, taskId: unassignedTaskId}), 'client-3')

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{projectPath?: string; status: string; taskId: string; type: string}>
      }

      const ids = result.tasks.map((t) => t.taskId)
      expect(ids).to.include(appTaskId)
      expect(ids).to.include(unassignedTaskId)
      expect(ids).to.not.include(otherTaskId)
      const appTask = result.tasks.find((t) => t.taskId === appTaskId)
      expect(appTask).to.have.property('status', 'created')
      expect(appTask).to.have.property('type', 'curate')
    })

    it('should reflect started status after task:started', async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const startedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.STARTED)
      const taskId = randomUUID()
      createHandler!(makeTaskCreateRequest({projectPath: '/app', taskId}), 'client-1')
      startedHandler!({taskId}, 'agent-1')

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{startedAt?: number; status: string; taskId: string}>
      }
      const item = result.tasks.find((t) => t.taskId === taskId)
      expect(item).to.exist
      expect(item!.status).to.equal('started')
      expect(item!.startedAt).to.be.a('number')
    })

    it('should include recently completed tasks (within grace period)', async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const completedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
      const taskId = randomUUID()
      createHandler!(makeTaskCreateRequest({projectPath: '/app', taskId}), 'client-1')
      completedHandler!({result: 'done', taskId}, 'agent-1')

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{completedAt?: number; result?: string; status: string; taskId: string}>
      }
      const item = result.tasks.find((t) => t.taskId === taskId)
      expect(item).to.exist
      expect(item!.status).to.equal('completed')
      expect(item!.result).to.equal('done')
      expect(item!.completedAt).to.be.a('number')
    })

    it("should default to caller's registered project when projectPath omitted", async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()
      createHandler!(makeTaskCreateRequest({projectPath: '/app', taskId}), 'client-1')

      // Wire up resolveClientProjectPath via a fresh router so we can return /app for client-1
      const helper = makeStubTransportServer(sandbox)
      const localRouter = new TaskRouter({
        agentPool,
        getAgentForProject,
        projectRegistry,
        projectRouter,
        resolveClientProjectPath: (id) => (id === 'client-1' ? '/app' : undefined),
        transport: helper.transport,
      })
      localRouter.setup()
      const localCreate = helper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const localTaskId = randomUUID()
      localCreate!(makeTaskCreateRequest({projectPath: '/app', taskId: localTaskId}), 'client-1')

      const listHandler = helper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({}, 'client-1')) as {tasks: Array<{taskId: string}>}
      const ids = result.tasks.map((t) => t.taskId)
      expect(ids).to.include(localTaskId)
      expect(ids).to.not.include(taskId)
    })

    it('should return an empty list when projectFilter cannot be resolved', async () => {
      // Fresh router with NO resolveClientProjectPath wired up — so when the
      // request omits projectPath, projectFilter ends up undefined and the
      // handler must NOT leak every task across projects.
      const helper = makeStubTransportServer(sandbox)
      const localRouter = new TaskRouter({
        agentPool,
        getAgentForProject,
        projectRegistry,
        projectRouter,
        transport: helper.transport,
      })
      localRouter.setup()

      const localCreate = helper.requestHandlers.get(TransportTaskEventNames.CREATE)
      localCreate!(makeTaskCreateRequest({projectPath: '/app', taskId: randomUUID()}), 'client-1')
      localCreate!(makeTaskCreateRequest({projectPath: '/other', taskId: randomUUID()}), 'client-2')

      const listHandler = helper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = await listHandler!({}, 'unknown-client')
      // M2.16: empty response carries the full numbered-pagination shape (page=1, pageCount=1, etc.)
      expect(result).to.deep.equal({
        availableModels: [],
        availableProviders: [],
        counts: {all: 0, cancelled: 0, completed: 0, failed: 0, running: 0},
        page: 1,
        pageCount: 1,
        pageSize: 50,
        tasks: [],
        total: 0,
      })
    })
  })

  // ==========================================================================
  // clearTasks / getDebugState
  // ==========================================================================

  describe('utility methods', () => {
    it('should clear all tasks', () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!(makeTaskCreateRequest(), 'client-1')

      router.clearTasks()

      expect(router.getTasksForProject('/app')).to.have.lengthOf(0)
    })

    it('should return debug state with active and completed tasks', () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      createHandler!(request, 'client-1')

      const state = router.getDebugState()
      expect(state.activeTasks).to.have.lengthOf(1)
      expect(state.activeTasks[0]).to.have.property('taskId', request.taskId)
      expect(state.completedTasks).to.have.lengthOf(0)
    })

    it('should move completed tasks to debug state', () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()
      createHandler!(request, 'client-1')

      // Complete the task
      const completedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'done', taskId: request.taskId}, 'agent-1')

      const state = router.getDebugState()
      expect(state.activeTasks).to.have.lengthOf(0)
      expect(state.completedTasks).to.have.lengthOf(1)
      expect(state.completedTasks[0]).to.have.property('taskId', request.taskId)
    })
  })

  // ==========================================================================
  // provider/model stamping (M1.02 — ENG-2487)
  // ==========================================================================

  describe('provider/model stamping', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    function buildRouterWithResolver(resolveActiveProvider: SinonStub): void {
      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        projectRegistry,
        projectRouter,
        resolveActiveProvider,
        transport: transportHelper.transport,
      })
      router.setup()
    }

    // eslint-disable-next-line unicorn/consistent-function-scoping
    function getCreatedBroadcastPayload(): Record<string, unknown> | undefined {
      const broadcastCall = projectRouter.broadcastToProject.getCalls().find(
        (c) => c.args[1] === TransportTaskEventNames.CREATED,
      )
      return broadcastCall?.args[2] as Record<string, unknown> | undefined
    }

    it('stamps provider + model on task:created (external provider)', async () => {
      buildRouterWithResolver(sandbox.stub().resolves({model: 'gpt-5-pro', provider: 'openai'}))
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      await handler!(request, 'client-1')

      const payload = getCreatedBroadcastPayload()
      expect(payload).to.exist
      expect(payload).to.have.property('provider', 'openai')
      expect(payload).to.have.property('model', 'gpt-5-pro')
    })

    it('stamps provider only on task:created (byterover internal — model undefined)', async () => {
      buildRouterWithResolver(sandbox.stub().resolves({provider: 'byterover'}))
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      await handler!(request, 'client-1')

      const payload = getCreatedBroadcastPayload()
      expect(payload).to.exist
      expect(payload).to.have.property('provider', 'byterover')
      expect(payload).to.not.have.property('model')
    })

    it('returns the same fields on task:list', async () => {
      buildRouterWithResolver(sandbox.stub().resolves({model: 'gpt-5-pro', provider: 'openai'}))
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()
      await createHandler!(makeTaskCreateRequest({projectPath: '/app', taskId}), 'client-1')

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{model?: string; provider?: string; taskId: string}>
      }

      const item = result.tasks.find((t) => t.taskId === taskId)
      expect(item).to.exist
      expect(item).to.have.property('provider', 'openai')
      expect(item).to.have.property('model', 'gpt-5-pro')
    })

    it('omits both fields when no resolver is configured', async () => {
      // Uses the global `router` from outer beforeEach (no resolveActiveProvider option)
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      await handler!(request, 'client-1')

      const payload = getCreatedBroadcastPayload()
      expect(payload).to.exist
      expect(payload).to.not.have.property('provider')
      expect(payload).to.not.have.property('model')
    })

    it('omits both fields when resolver returns {}', async () => {
      buildRouterWithResolver(sandbox.stub().resolves({}))
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      await handler!(request, 'client-1')

      const payload = getCreatedBroadcastPayload()
      expect(payload).to.exist
      expect(payload).to.not.have.property('provider')
      expect(payload).to.not.have.property('model')
    })

    it('still creates the task when resolveActiveProvider rejects (fail-open)', async () => {
      buildRouterWithResolver(sandbox.stub().rejects(new Error('boom')))
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const request = makeTaskCreateRequest()

      const result = await handler!(request, 'client-1')

      // Wait for fire-and-forget submitTask
      await new Promise((resolve) => {
        setTimeout(resolve, 10)
      })

      expect(result).to.deep.equal({taskId: request.taskId})
      expect(agentPool.submitTask.calledOnce).to.be.true

      const payload = getCreatedBroadcastPayload()
      expect(payload).to.exist
      expect(payload).to.not.have.property('provider')
      expect(payload).to.not.have.property('model')
    })
  })
})
