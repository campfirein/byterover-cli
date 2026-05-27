/**
 * AnalyticsHook async stress test — drives the real `TaskRouter` over a stub
 * transport with a real `AnalyticsHook` + `CurateLogHandler` to verify the
 * per-task FIFO queue holds under concurrent multi-task TOOL_RESULT load.
 *
 * Covers the audit's Scenario F (intra-task interleaving) and a multi-task
 * variant: emits MUST arrive in arrival order per-task even when underlying
 * disk reads happen with microtask-scale jitter, AND terminal
 * CURATE_RUN_COMPLETED MUST land AFTER every per-op emit for that task.
 *
 * Implementation note: the per-task queue inside AnalyticsHook serializes
 * `readFrontmatterFields` calls per-task, so reads happen one-at-a-time
 * for a single task. Multi-task reads can interleave across tasks.
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {relative as relativePath} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {LlmToolResultEvent} from '../../../../src/server/core/domain/transport/schemas.js'
import type {TaskInfo} from '../../../../src/server/core/domain/transport/task-info.js'
import type {IAgentPool, SubmitTaskResult} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IAnalyticsClient} from '../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {IProjectRegistry} from '../../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {LlmEventNames, TransportTaskEventNames} from '../../../../src/server/core/domain/transport/schemas.js'
import {AnalyticsHook} from '../../../../src/server/infra/process/analytics-hook.js'
import {CurateLogHandler} from '../../../../src/server/infra/process/curate-log-handler.js'
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

const buildToolResult = (taskId: string, op: Record<string, unknown>): LlmToolResultEvent =>
  ({
    callId: `call-${randomUUID()}`,
    result: JSON.stringify({applied: [op]}),
    sessionId: 'session-1',
    taskId,
    timestamp: Date.now(),
    toolName: 'curate',
  }) as unknown as LlmToolResultEvent

const buildCurateTaskInfo = (taskId: string): TaskInfo =>
  ({
    clientId: 'client-1',
    completedAt: Date.now(),
    content: 'curate',
    createdAt: Date.now() - 1000,
    projectPath: '/proj',
    status: 'completed',
    taskId,
    type: 'curate',
  }) as unknown as TaskInfo

const dummyFrontmatter = (tag: string): string => `---\ntags: ["${tag}"]\n---\nbody\n`

const microtaskTick = async (count: number): Promise<void> => {
  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve()
  }
}

describe('AnalyticsHook async stress (integration through TaskRouter)', () => {
  let sandbox: SinonSandbox
  let trackStub: SinonStub
  let analyticsHook: AnalyticsHook
  let curateLogHandler: CurateLogHandler
  let createHandler: RequestHandler
  let toolResultHandler: RequestHandler
  /** Records the order in which readFile is called (for serialization assertions). */
  let readFileCallOrder: string[]

  beforeEach(() => {
    sandbox = createSandbox()
    const {requestHandlers, transport} = makeStubTransport(sandbox)
    const agentPool = makeStubAgentPool(sandbox)
    const projectRegistry = makeStubProjectRegistry(sandbox)
    const projectRouter = makeStubProjectRouter(sandbox)

    readFileCallOrder = []
    // Stubbed readFile: returns a Promise that resolves AFTER a few microtasks
    // so the awaited read actually yields control to the event loop. The
    // microtask jitter is what makes this a "stress" test — it simulates the
    // real async behaviour of `node:fs/promises.readFile` without flaky
    // wall-clock timers.
    const stubReadFile: (filePath: string, encoding: 'utf8') => Promise<string> = async (filePath) => {
      readFileCallOrder.push(filePath)
      // Jitter: yield 3 microtasks before returning. Combined with the per-task
      // queue this means reads for the same task are strictly serialized; reads
      // across tasks may interleave at microtask boundaries.
      await microtaskTick(3)
      // Derive a stable tag from the filename for the emitted frontmatter.
      const tag = filePath.replaceAll(/[^a-zA-Z0-9]+/g, '-')
      return dummyFrontmatter(tag)
    }

    const bundle = makeAnalyticsClient(sandbox)
    trackStub = bundle.trackStub
    analyticsHook = new AnalyticsHook({readFile: stubReadFile})
    analyticsHook.setAnalyticsClient(bundle.client)
    // No-op store: stress test does not assert on disk log persistence.
    curateLogHandler = new CurateLogHandler(() => ({
      batchUpdateOperationReviewStatus: sandbox.stub().resolves(true),
      getById: sandbox.stub().resolves(null),
      getNextId: sandbox.stub().resolves('log-1'),
      list: sandbox.stub().resolves([]),
      save: sandbox.stub().resolves(),
    }))

    const router = new TaskRouter({
      agentPool,
      getAgentForProject: () => 'agent-1',
      lifecycleHooks: [curateLogHandler, analyticsHook],
      projectRegistry,
      projectRouter,
      resolveClientProjectPath: () => '/proj',
      transport,
    })
    router.setup()

    const create = requestHandlers.get(TransportTaskEventNames.CREATE)
    const toolResult = requestHandlers.get(LlmEventNames.TOOL_RESULT)
    if (!create || !toolResult) throw new Error('expected handlers not registered')
    createHandler = create
    toolResultHandler = toolResult
  })

  afterEach(() => {
    sandbox.restore()
  })

  async function createCurateTask(taskId: string): Promise<void> {
    await createHandler({content: 'curate', projectPath: '/proj', taskId, type: 'curate'}, 'client-1')
  }

  function fireToolResult(taskId: string, opSpec: {filePath: string; path: string}): Promise<void> {
    const payload = buildToolResult(taskId, {
      filePath: opSpec.filePath,
      needsReview: false,
      path: opSpec.path,
      status: 'success',
      type: 'ADD',
    })
    return toolResultHandler(payload as unknown, 'client-1') as Promise<void>
  }

  function getCurateOpEmits(taskId: string): Array<Record<string, unknown>> {
    return trackStub
      .getCalls()
      .filter(
        (c) =>
          c.args[0] === AnalyticsEventNames.CURATE_OPERATION_APPLIED &&
          (c.args[1] as {task_id: string}).task_id === taskId,
      )
      .map((c) => c.args[1] as Record<string, unknown>)
  }

  function getEmitSequenceForTask(taskId: string): string[] {
    return trackStub
      .getCalls()
      .filter((c) => {
        const props = c.args[1] as {task_id: string}
        return props.task_id === taskId
      })
      .map((c) => c.args[0] as string)
  }

  it('serializes reads per task: 20 concurrent TOOL_RESULTs for one task call readFile in arrival order', async () => {
    const taskId = 'task-A'
    await createCurateTask(taskId)

    const opSpecs = Array.from({length: 20}, (_, i) => ({
      filePath: `/A/op-${String(i).padStart(2, '0')}.md`,
      path: `notes/A/op-${i}`,
    }))

    // Fire all 20 concurrently — the routeLlmEvent handler awaits the hook
    // chain, but each fire returns its own Promise and we let them race.
    const promises = opSpecs.map((spec) => fireToolResult(taskId, spec))
    await Promise.all(promises)

    // readFile call order must match arrival order (proves per-task queue).
    expect(readFileCallOrder, 'readFile call order = arrival order').to.deep.equal(opSpecs.map((s) => s.filePath))

    // Emit order must match arrival order. M14 review: relative_path is
    // relativized against the curate task's projectPath ('/proj').
    const emits = getCurateOpEmits(taskId)
    expect(emits).to.have.lengthOf(20)
    for (const [i, emit] of emits.entries()) {
      expect(emit.relative_path, `emit #${i} arrival order`).to.equal(relativePath('/proj', opSpecs[i].filePath))
    }
  })

  it('preserves per-task arrival order across two tasks under interleaved fire order (30 ops total)', async () => {
    await createCurateTask('task-X')
    await createCurateTask('task-Y')

    const xSpecs = Array.from({length: 15}, (_, i) => ({
      filePath: `/X/op-${String(i).padStart(2, '0')}.md`,
      path: `notes/X/op-${i}`,
    }))
    const ySpecs = Array.from({length: 15}, (_, i) => ({
      filePath: `/Y/op-${String(i).padStart(2, '0')}.md`,
      path: `notes/Y/op-${i}`,
    }))

    // Interleave fire order: X0, Y0, X1, Y1, … so cross-task scheduling
    // jitter is maximised.
    const promises: Array<Promise<void>> = []
    for (let i = 0; i < 15; i++) {
      promises.push(fireToolResult('task-X', xSpecs[i]), fireToolResult('task-Y', ySpecs[i]))
    }

    await Promise.all(promises)

    // Per-task emit order must match per-task arrival order regardless of
    // cross-task interleaving.
    const xEmits = getCurateOpEmits('task-X')
    const yEmits = getCurateOpEmits('task-Y')
    expect(xEmits).to.have.lengthOf(15)
    expect(yEmits).to.have.lengthOf(15)
    for (let i = 0; i < 15; i++) {
      expect(xEmits[i].relative_path, `X emit #${i}`).to.equal(relativePath('/proj', xSpecs[i].filePath))
      expect(yEmits[i].relative_path, `Y emit #${i}`).to.equal(relativePath('/proj', ySpecs[i].filePath))
    }
  })

  it('CURATE_RUN_COMPLETED lands after every per-op emit for the same task (50-op terminal stress)', async () => {
    const taskId = 'task-Z'
    await createCurateTask(taskId)

    const specs = Array.from({length: 50}, (_, i) => ({
      filePath: `/Z/op-${String(i).padStart(2, '0')}.md`,
      path: `notes/Z/op-${i}`,
    }))

    // Fire all ops, but DO NOT await before firing the terminal hook —
    // exercises the dispatchTerminal/onTaskCompleted "drain pendingByTask"
    // path. We `await Promise.all` AFTER both event types are queued so the
    // task router can interleave them.
    const opPromises = specs.map((spec) => fireToolResult(taskId, spec))
    const terminalPromise = analyticsHook.onTaskCompleted(taskId, '', buildCurateTaskInfo(taskId))

    await Promise.all([...opPromises, terminalPromise])

    const sequence = getEmitSequenceForTask(taskId)

    // M14.3: TASK_CREATED → 50 per-op → CURATE_RUN_COMPLETED → TASK_COMPLETED.
    expect(
      sequence.filter((s) => s === AnalyticsEventNames.CURATE_OPERATION_APPLIED),
      'exactly 50 per-op emits',
    ).to.have.lengthOf(50)
    expect(
      sequence.filter((s) => s === AnalyticsEventNames.CURATE_RUN_COMPLETED),
      'exactly 1 M12 terminal emit',
    ).to.have.lengthOf(1)
    expect(sequence.at(-1), 'M14.3 task_completed is last in sequence').to.equal(AnalyticsEventNames.TASK_COMPLETED)
    expect(
      sequence.at(-2),
      'M12 curate_run_completed lands immediately before the M14.3 terminal',
    ).to.equal(AnalyticsEventNames.CURATE_RUN_COMPLETED)

    // And per-op emit order matches arrival order.
    const opEmits = getCurateOpEmits(taskId)
    for (let i = 0; i < 50; i++) {
      expect(opEmits[i].relative_path, `op #${i} arrival order`).to.equal(relativePath('/proj', specs[i].filePath))
    }
  })

  it('three-task stress: 30 ops total (10 per task), per-task ordering and terminal sequencing all preserved', async () => {
    const taskIds = ['task-P', 'task-Q', 'task-R'] as const
    for (const id of taskIds) {
      // eslint-disable-next-line no-await-in-loop
      await createCurateTask(id)
    }

    const specsByTask: Record<string, Array<{filePath: string; path: string}>> = {
      'task-P': Array.from({length: 10}, (_, i) => ({
        filePath: `/P/op-${String(i).padStart(2, '0')}.md`,
        path: `notes/P/op-${i}`,
      })),
      'task-Q': Array.from({length: 10}, (_, i) => ({
        filePath: `/Q/op-${String(i).padStart(2, '0')}.md`,
        path: `notes/Q/op-${i}`,
      })),
      'task-R': Array.from({length: 10}, (_, i) => ({
        filePath: `/R/op-${String(i).padStart(2, '0')}.md`,
        path: `notes/R/op-${i}`,
      })),
    }

    // Round-robin fire across all three tasks.
    const opPromises: Array<Promise<void>> = []
    for (let i = 0; i < 10; i++) {
      for (const id of taskIds) {
        opPromises.push(fireToolResult(id, specsByTask[id][i]))
      }
    }

    // Fire terminal for each task in parallel with op processing.
    const terminalPromises = taskIds.map((id) => analyticsHook.onTaskCompleted(id, '', buildCurateTaskInfo(id)))

    await Promise.all([...opPromises, ...terminalPromises])

    // Every task: TASK_CREATED → 10 per-op → CURATE_RUN_COMPLETED → TASK_COMPLETED.
    for (const id of taskIds) {
      const sequence = getEmitSequenceForTask(id)
      expect(sequence, `${id} sequence length`).to.have.lengthOf(13)
      expect(sequence[0], `${id}: first is task_created`).to.equal(AnalyticsEventNames.TASK_CREATED)
      expect(
        sequence.slice(1, 11).every((s) => s === AnalyticsEventNames.CURATE_OPERATION_APPLIED),
        `${id}: 10 per-op emits between task_created and the terminals`,
      ).to.equal(true)
      expect(sequence[11], `${id}: M12 run-completed precedes the M14.3 terminal`).to.equal(
        AnalyticsEventNames.CURATE_RUN_COMPLETED,
      )
      expect(sequence[12], `${id}: M14.3 task_completed is last`).to.equal(AnalyticsEventNames.TASK_COMPLETED)
      const opEmits = getCurateOpEmits(id)
      for (let i = 0; i < 10; i++) {
        expect(opEmits[i].relative_path, `${id} op #${i} arrival order`).to.equal(
          relativePath('/proj', specsByTask[id][i].filePath),
        )
      }
    }
  })
})
