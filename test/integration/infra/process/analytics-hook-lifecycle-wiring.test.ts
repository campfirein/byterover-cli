/**
 * M15.6 end-to-end wiring test — drives a real TaskRouter with AnalyticsHook
 * registered as a lifecycle hook (mirroring the brv-server.ts:430 wire) and
 * asserts that the generic task_created / task_completed / task_failed
 * events flow through correctly. Plus failure_kind classification.
 *
 * Mirrors the async-stress harness but focuses on lifecycle wiring rather
 * than per-op order. Stubs the transport + agent pool; the rest is real
 * AnalyticsHook + TaskRouter glue.
 */

 
import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {TaskInfo} from '../../../../src/server/core/domain/transport/task-info.js'
import type {IAgentPool, SubmitTaskResult} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IAnalyticsClient} from '../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {IProjectRegistry} from '../../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {TransportTaskEventNames} from '../../../../src/server/core/domain/transport/schemas.js'
import {AnalyticsHook} from '../../../../src/server/infra/process/analytics-hook.js'
import {TaskRouter} from '../../../../src/server/infra/process/task-router.js'
import {AnalyticsEventNames} from '../../../../src/shared/analytics/event-names.js'

function makeStubTransport(sandbox: SinonSandbox): {
  requestHandlers: Map<string, RequestHandler>
  transport: ITransportServer
} {
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

function makeStubAgentPool(sandbox: SinonSandbox): IAgentPool {
  return {
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

function makeStubProjectRegistry(sandbox: SinonSandbox): IProjectRegistry {
  const projectInfo = {
    projectPath: '/proj',
    registeredAt: Date.now(),
    sanitizedPath: '_proj',
    storagePath: '/data/proj',
  }
  return {
    get: sandbox.stub().returns(projectInfo),
    getAll: sandbox.stub().returns(new Map()),
    register: sandbox.stub().returns(projectInfo),
    unregister: sandbox.stub().returns(true),
  }
}

function makeStubProjectRouter(sandbox: SinonSandbox): IProjectRouter {
  return {
    addToProjectRoom: sandbox.stub(),
    broadcastToProject: sandbox.stub(),
    getProjectMembers: sandbox.stub().returns([]),
    removeFromProjectRoom: sandbox.stub(),
  }
}

function makeAnalyticsClient(sandbox: SinonSandbox): {client: IAnalyticsClient; trackStub: SinonStub} {
  const trackStub = sandbox.stub()
  const client: IAnalyticsClient = {
    abort: sandbox.stub(),
    flush: sandbox.stub().resolves(),
    getRuntimeState: sandbox.stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: sandbox.stub().resolves(),
    track: trackStub,
  }
  return {client, trackStub}
}

const buildTaskInfo = (taskId: string, type: string): TaskInfo =>
  ({
    clientId: 'client-1',
    completedAt: Date.now(),
    content: 'demo',
    createdAt: Date.now() - 1000,
    projectPath: '/proj',
    status: 'completed',
    taskId,
    type,
  }) as unknown as TaskInfo

describe('AnalyticsHook lifecycle wiring (M15.6 — through TaskRouter)', () => {
  let sandbox: SinonSandbox
  let trackStub: SinonStub
  let analyticsHook: AnalyticsHook
  let createHandler: RequestHandler

  beforeEach(() => {
    sandbox = createSandbox()
    const {requestHandlers, transport} = makeStubTransport(sandbox)
    const bundle = makeAnalyticsClient(sandbox)
    trackStub = bundle.trackStub

    analyticsHook = new AnalyticsHook()
    analyticsHook.setAnalyticsClient(bundle.client)

    // The wire from brv-server.ts:430: AnalyticsHook is the 4th peer hook.
    // The other three are intentionally omitted here so the test focuses on
    // AnalyticsHook's emit surface in isolation.
    const router = new TaskRouter({
      agentPool: makeStubAgentPool(sandbox),
      getAgentForProject: () => 'agent-1',
      lifecycleHooks: [analyticsHook],
      projectRegistry: makeStubProjectRegistry(sandbox),
      projectRouter: makeStubProjectRouter(sandbox),
      resolveClientProjectPath: () => '/proj',
      transport,
    })
    router.setup()

    const create = requestHandlers.get(TransportTaskEventNames.CREATE)
    if (!create) throw new Error('expected task:create handler to be registered')
    createHandler = create
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('task_created fires immediately on task:create with the correct task_type', async () => {
    await createHandler(
      {content: 'curate me', projectPath: '/proj', taskId: 'task-create-fire', type: 'curate'},
      'client-1',
    )

    const created = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_CREATED)
    expect(created, 'task_created should fire on create').to.not.equal(undefined)
    const props = created?.args[1] as Record<string, unknown>
    expect(props.task_id).to.equal('task-create-fire')
    expect(props.task_type).to.equal('curate')
    expect(props.has_files).to.equal(false)
    expect(props.has_folder).to.equal(false)
  })

  it('task_completed fires after the agent reports completion (curate task)', async () => {
    const taskId = 'task-curate-success'
    await createHandler({content: 'curate', projectPath: '/proj', taskId, type: 'curate'}, 'client-1')
    await analyticsHook.onTaskCompleted(taskId, '', buildTaskInfo(taskId, 'curate'))

    const completed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_COMPLETED)
    expect(completed).to.not.equal(undefined)
    const props = completed?.args[1] as Record<string, unknown>
    expect(props.task_id).to.equal(taskId)
    expect(props.task_type).to.equal('curate')
    expect(props.duration_ms).to.be.a('number')
  })

  it('task_failed carries failure_kind="cancelled" on user cancellation', async () => {
    const taskId = 'task-cancel'
    await createHandler({content: 'curate', projectPath: '/proj', taskId, type: 'curate'}, 'client-1')
    await analyticsHook.onTaskCancelled(taskId, buildTaskInfo(taskId, 'curate'))

    const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
    expect(failed).to.not.equal(undefined)
    const props = failed?.args[1] as Record<string, unknown>
    expect(props.task_id).to.equal(taskId)
    expect(props.task_type).to.equal('curate')
    expect(props.failure_kind).to.equal('cancelled')
  })

  it('task_failed classifies a timeout error message into failure_kind="timeout"', async () => {
    const taskId = 'task-timeout'
    await createHandler({content: 'curate', projectPath: '/proj', taskId, type: 'curate'}, 'client-1')
    await analyticsHook.onTaskError(taskId, 'agentic loop deadline exceeded', buildTaskInfo(taskId, 'curate'))

    const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
    expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('timeout')
  })

  it('task_failed classifies an agent error message into failure_kind="agent_error"', async () => {
    const taskId = 'task-agent-err'
    await createHandler({content: 'curate', projectPath: '/proj', taskId, type: 'curate'}, 'client-1')
    await analyticsHook.onTaskError(taskId, 'llm provider rejected the request', buildTaskInfo(taskId, 'curate'))

    const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
    expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('agent_error')
  })

  it('task_failed defaults failure_kind="unknown" when nothing recognises the error string', async () => {
    const taskId = 'task-unknown'
    await createHandler({content: 'curate', projectPath: '/proj', taskId, type: 'curate'}, 'client-1')
    await analyticsHook.onTaskError(taskId, 'kaboom', buildTaskInfo(taskId, 'curate'))

    const failed = trackStub.getCalls().find((c) => c.args[0] === AnalyticsEventNames.TASK_FAILED)
    expect((failed?.args[1] as Record<string, unknown>).failure_kind).to.equal('unknown')
  })

  it('every tool-mode task type fires both task_created and the right terminal', async () => {
    const cases = [
      {expectedTaskType: 'curate-tool-mode', taskId: 'tm-curate', type: 'curate-html-direct'},
      {expectedTaskType: 'query-tool-mode', taskId: 'tm-query', type: 'query-tool-mode'},
      {expectedTaskType: 'dream-scan', taskId: 'tm-dream-scan', type: 'dream-scan'},
      {expectedTaskType: 'dream-finalize', taskId: 'tm-dream-finalize', type: 'dream-finalize'},
    ] as const

    for (const c of cases) {
      // eslint-disable-next-line no-await-in-loop
      await createHandler({content: 'demo', projectPath: '/proj', taskId: c.taskId, type: c.type}, 'client-1')
      // eslint-disable-next-line no-await-in-loop
      await analyticsHook.onTaskCompleted(c.taskId, '', buildTaskInfo(c.taskId, c.type))
    }

    for (const c of cases) {
      const created = trackStub.getCalls().find(
        (call) =>
          call.args[0] === AnalyticsEventNames.TASK_CREATED &&
          (call.args[1] as Record<string, unknown>).task_id === c.taskId,
      )
      const completed = trackStub.getCalls().find(
        (call) =>
          call.args[0] === AnalyticsEventNames.TASK_COMPLETED &&
          (call.args[1] as Record<string, unknown>).task_id === c.taskId,
      )
      expect(created, `${c.taskId}: task_created`).to.not.equal(undefined)
      expect(completed, `${c.taskId}: task_completed`).to.not.equal(undefined)
      expect((created?.args[1] as Record<string, unknown>).task_type).to.equal(c.expectedTaskType)
      expect((completed?.args[1] as Record<string, unknown>).task_type).to.equal(c.expectedTaskType)
    }
  })
})
