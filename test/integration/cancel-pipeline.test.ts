import {TransportClient} from '@campfirein/brv-transport-client'
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'

import type {TaskExecute} from '../../src/server/core/domain/transport/schemas.js'
import type {TaskInfo} from '../../src/server/core/domain/transport/task-info.js'
import type {IAgentPool, SubmitTaskResult} from '../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {ITaskLifecycleHook} from '../../src/server/core/interfaces/process/i-task-lifecycle-hook.js'
import type {IProjectRegistry} from '../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../src/server/core/interfaces/routing/i-project-router.js'

import {ProjectInfo} from '../../src/server/core/domain/project/project-info.js'
import {ProjectTaskQueue} from '../../src/server/infra/daemon/project-task-queue.js'
import {TaskRouter} from '../../src/server/infra/process/task-router.js'
import {SocketIOTransportServer} from '../../src/server/infra/transport/socket-io-transport-server.js'

const PORT = 9802
const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * Wait for a predicate to become true, polling at 5ms intervals.
 * Throws after `timeoutMs` to keep tests bounded.
 */
async function waitFor<T>(check: () => T | undefined, label: string, timeoutMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const got = check()
    if (got !== undefined) return got
    // eslint-disable-next-line no-await-in-loop
    await delay(5)
  }

  throw new Error(`waitFor(${label}) timed out after ${timeoutMs}ms`)
}

function makeProjectInfo(projectPath: string): ProjectInfo {
  return new ProjectInfo({
    projectPath,
    registeredAt: Date.now(),
    sanitizedPath: projectPath.replaceAll('/', '_'),
    storagePath: `/data${projectPath}`,
  })
}

function makeProjectRegistry(): IProjectRegistry {
  return {
    get: (path: string) => makeProjectInfo(path),
    getAll: () => new Map(),
    register: (path: string) => makeProjectInfo(path),
    unregister: () => true,
  }
}

function makeProjectRouter(): IProjectRouter {
  return {
    addToProjectRoom() {},
    broadcastToProject() {},
    getProjectMembers: () => [],
    removeFromProjectRoom() {},
  }
}

type StubPool = IAgentPool & {
  resetActive(): void
}

/**
 * Stub IAgentPool backed by a real ProjectTaskQueue so the test exercises
 * the actual queue logic. Forwards dispatched tasks to the connected mockAgent
 * via the real transport server.
 */
function makeQueueBackedAgentPool(
  server: SocketIOTransportServer,
  getMockAgentClientId: () => string | undefined,
  options?: {maxConcurrentTasksPerProject?: number},
): StubPool {
  const queue = new ProjectTaskQueue()
  const active = new Map<string, number>()
  const maxConcurrent = options?.maxConcurrentTasksPerProject ?? 1

  const dispatch = (task: TaskExecute): boolean => {
    const id = getMockAgentClientId()
    if (id === undefined) return false
    server.sendTo(id, 'task:execute', task)
    return true
  }

  return {
    cancelQueuedTask(taskId: string): boolean {
      return queue.cancel(taskId)
    },
    getEntries() {
      return []
    },
    getSize() {
      return active.size
    },
    handleAgentDisconnected() {},
    hasAgent() {
      return true
    },
    markIdle() {},
    notifyTaskCompleted(projectPath: string) {
      const cur = active.get(projectPath) ?? 0
      active.set(projectPath, Math.max(0, cur - 1))
      while ((active.get(projectPath) ?? 0) < maxConcurrent) {
        const next = queue.dequeue(projectPath)
        if (!next) break
        active.set(projectPath, (active.get(projectPath) ?? 0) + 1)
        if (!dispatch(next)) break
      }
    },
    resetActive() {
      active.clear()
      queue.clear()
    },
    async shutdown() {},
    async submitTask(task: TaskExecute): Promise<SubmitTaskResult> {
      const projectKey = task.projectPath ?? '__default__'
      const cur = active.get(projectKey) ?? 0
      if (cur >= maxConcurrent) {
        queue.enqueue(projectKey, task)
        return {success: true}
      }

      if (!dispatch(task)) {
        return {message: 'No agent connected', reason: 'create_failed', success: false}
      }

      active.set(projectKey, cur + 1)
      return {success: true}
    },
  }
}

type TaskBehavior = 'auto-complete' | 'wait-for-cancel'

/**
 * Bind a mockAgent to its lifecycle:
 *  - on task:execute, immediately emit task:started, then wait for either
 *    a cancel signal (default behavior) or an auto-complete timer
 *    (override per taskId via behaviors map).
 *  - on task:cancel, abort the in-flight controller for that task. The
 *    task body resolves on abort and emits task:cancelled (simulating the
 *    T1.1 cancel listener inside a real agent).
 */
function bindMockAgent(mockAgent: TransportClient, behaviors: Map<string, TaskBehavior>) {
  const inFlight = new Map<string, AbortController>()
  const completed = new Set<string>()

  mockAgent.on('task:execute', async (data: unknown) => {
    const task = data as TaskExecute
    await mockAgent.requestWithAck('task:started', {taskId: task.taskId})

    const behavior = behaviors.get(task.taskId) ?? 'wait-for-cancel'

    if (behavior === 'auto-complete') {
      await delay(15)
      await mockAgent.requestWithAck('task:completed', {
        projectPath: task.projectPath,
        result: 'auto-complete result',
        taskId: task.taskId,
      })
      completed.add(task.taskId)
      return
    }

    const controller = new AbortController()
    inFlight.set(task.taskId, controller)

    await new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), {once: true})
    })
    inFlight.delete(task.taskId)

    await mockAgent.requestWithAck('task:cancelled', {taskId: task.taskId})
    completed.add(task.taskId)
  })

  mockAgent.on('task:cancel', (data: unknown) => {
    const {taskId} = data as {taskId: string}
    inFlight.get(taskId)?.abort()
  })

  return {
    completed,
    isInFlight(taskId: string): boolean {
      return inFlight.has(taskId)
    },
  }
}

type HookCall =
  | {errorMessage: string; kind: 'error'; taskId: string}
  | {kind: 'cancelled'; taskId: string}
  | {kind: 'completed'; result: string; taskId: string}

function makeRecordingHook(): {calls: HookCall[]; hook: ITaskLifecycleHook} {
  const calls: HookCall[] = []
  const hook: ITaskLifecycleHook = {
    async onTaskCancelled(taskId: string, _task: TaskInfo) {
      calls.push({kind: 'cancelled', taskId})
    },
    async onTaskCompleted(taskId: string, result: string, _task: TaskInfo) {
      calls.push({kind: 'completed', result, taskId})
    },
    async onTaskError(taskId: string, errorMessage: string, _task: TaskInfo) {
      calls.push({errorMessage, kind: 'error', taskId})
    },
  }
  return {calls, hook}
}

describe('Cancel pipeline (T1.4 integration)', () => {
  let server: SocketIOTransportServer
  let router: TaskRouter
  let agentPool: StubPool
  let mockAgent: TransportClient
  let agentClientId: string | undefined
  let client: TransportClient
  let behaviors: Map<string, TaskBehavior>
  let agentBindings: ReturnType<typeof bindMockAgent>
  let hookRecord: ReturnType<typeof makeRecordingHook>
  const projectPath = '/proj/cancel-pipeline-test'

  before(() => {
    process.env.BRV_SESSION_LOG = '/dev/null'
  })

  after(() => {
    delete process.env.BRV_SESSION_LOG
  })

  beforeEach(async () => {
    server = new SocketIOTransportServer()
    await server.start(PORT)

    agentClientId = undefined
    server.onConnection((clientId) => {
      if (!agentClientId) agentClientId = clientId
    })

    agentPool = makeQueueBackedAgentPool(server, () => agentClientId)

    hookRecord = makeRecordingHook()

    router = new TaskRouter({
      agentPool,
      getAgentForProject: () => agentClientId,
      lifecycleHooks: [hookRecord.hook],
      projectRegistry: makeProjectRegistry(),
      projectRouter: makeProjectRouter(),
      transport: server,
    })
    router.setup()

    mockAgent = new TransportClient()
    await mockAgent.connect(`http://127.0.0.1:${PORT}`)
    behaviors = new Map()
    agentBindings = bindMockAgent(mockAgent, behaviors)

    client = new TransportClient()
    await client.connect(`http://127.0.0.1:${PORT}`)
  })

  afterEach(async () => {
    if (client?.getState() === 'connected') await client.disconnect()
    if (mockAgent?.getState() === 'connected') await mockAgent.disconnect()
    if (server?.isRunning()) {
      router?.clearTasks?.()
      await server.stop()
    }
  })

  type TerminalRecord = {kind: 'cancelled' | 'completed' | 'error'; taskId: string}

  function captureTerminalEvents(c: TransportClient): TerminalRecord[] {
    const records: TerminalRecord[] = []
    c.on('task:cancelled', (data: unknown) => {
      records.push({kind: 'cancelled', taskId: (data as {taskId: string}).taskId})
    })
    c.on('task:completed', (data: unknown) => {
      records.push({kind: 'completed', taskId: (data as {taskId: string}).taskId})
    })
    c.on('task:error', (data: unknown) => {
      records.push({kind: 'error', taskId: (data as {taskId: string}).taskId})
    })
    return records
  }

  function captureStartedEvents(c: TransportClient): string[] {
    const ids: string[] = []
    c.on('task:started', (data: unknown) => {
      ids.push((data as {taskId: string}).taskId)
    })
    return ids
  }

  it('scenario 1 — cancel running task; agent stays alive', async () => {
    const terminal = captureTerminalEvents(client)
    const started = captureStartedEvents(client)

    const taskId = randomUUID()
    const agentIdBefore = agentClientId

    await client.requestWithAck('task:create', {content: 'slow', projectPath, taskId, type: 'curate'})
    await waitFor(() => (started.includes(taskId) ? true : undefined), 'task:started')

    const cancelResult = await client.requestWithAck<{success: boolean}>('task:cancel', {taskId})
    expect(cancelResult).to.deep.equal({success: true})

    const cancelled = await waitFor(
      () => terminal.find((t) => t.kind === 'cancelled' && t.taskId === taskId),
      'task:cancelled',
    )
    expect(cancelled).to.deep.equal({kind: 'cancelled', taskId})

    // No other terminal events for this task
    const otherForTask = terminal.filter((t) => t.taskId === taskId && t.kind !== 'cancelled')
    expect(otherForTask).to.have.length(0)

    // Lifecycle hook fired onTaskCancelled (proxy for persisted history status: 'cancelled')
    expect(hookRecord.calls.some((c) => c.kind === 'cancelled' && c.taskId === taskId)).to.equal(true)

    // Agent (mock) is still alive — same socket id, still connected
    expect(mockAgent.getState()).to.equal('connected')
    expect(agentClientId).to.equal(agentIdBefore)
    expect(mockAgent.getState()).to.equal('connected')
  })

  it('scenario 2 — cancel running task; queued task auto-starts', async () => {
    const started = captureStartedEvents(client)
    const terminal = captureTerminalEvents(client)

    const taskA = randomUUID()
    const taskB = randomUUID()
    behaviors.set(taskB, 'auto-complete')

    await client.requestWithAck('task:create', {content: 'a', projectPath, taskId: taskA, type: 'curate'})
    await waitFor(() => (started.includes(taskA) ? true : undefined), 'A started')

    await client.requestWithAck('task:create', {content: 'b', projectPath, taskId: taskB, type: 'curate'})
    // Confirm B is queued, not started yet
    expect(started.includes(taskB)).to.equal(false)

    await client.requestWithAck<{success: boolean}>('task:cancel', {taskId: taskA})
    await waitFor(
      () => terminal.find((t) => t.kind === 'cancelled' && t.taskId === taskA),
      'A cancelled',
    )

    // B should auto-dispatch after the queue drain
    await waitFor(() => (started.includes(taskB) ? true : undefined), 'B started after A cancelled')

    // B should reach completion (auto-complete behavior)
    await waitFor(
      () => terminal.find((t) => t.kind === 'completed' && t.taskId === taskB),
      'B completed',
    )
  })

  it('scenario 3 — cancel queued task before it runs; agent never sees it', async () => {
    const started = captureStartedEvents(client)
    const terminal = captureTerminalEvents(client)
    const cancelsSeenByAgent: string[] = []
    mockAgent.on('task:cancel', (data: unknown) => {
      cancelsSeenByAgent.push((data as {taskId: string}).taskId)
    })

    const taskA = randomUUID()
    const taskB = randomUUID()

    await client.requestWithAck('task:create', {content: 'a', projectPath, taskId: taskA, type: 'curate'})
    await waitFor(() => (started.includes(taskA) ? true : undefined), 'A started')

    await client.requestWithAck('task:create', {content: 'b', projectPath, taskId: taskB, type: 'curate'})
    expect(started.includes(taskB)).to.equal(false)

    await client.requestWithAck<{success: boolean}>('task:cancel', {taskId: taskB})

    // B is cancelled from the daemon directly; emits task:cancelled
    const cancelledForB = await waitFor(
      () => terminal.find((t) => t.kind === 'cancelled' && t.taskId === taskB),
      'B cancelled (queued)',
    )
    expect(cancelledForB).to.deep.equal({kind: 'cancelled', taskId: taskB})

    // Agent never received task:cancel for B (only A may be cancelled later)
    expect(cancelsSeenByAgent).to.not.include(taskB)

    // B never reached task:started
    expect(started.includes(taskB)).to.equal(false)

    // A continues to run unaffected
    expect(agentBindings.isInFlight(taskA)).to.equal(true)
  })

  it('scenario 4 — idempotent double-cancel emits exactly one terminal event', async () => {
    const terminal = captureTerminalEvents(client)
    const started = captureStartedEvents(client)

    const taskId = randomUUID()
    await client.requestWithAck('task:create', {content: 'slow', projectPath, taskId, type: 'curate'})
    await waitFor(() => (started.includes(taskId) ? true : undefined), 'started')

    const [resA, resB] = await Promise.all([
      client.requestWithAck<{success: boolean}>('task:cancel', {taskId}),
      client.requestWithAck<{success: boolean}>('task:cancel', {taskId}),
    ])
    // At least one returns success: true; the other may return success: false
    // (router reports "Task not found" once the task moves to completed).
    // Either order is acceptable.
    expect([resA.success, resB.success].filter(Boolean).length).to.be.greaterThanOrEqual(1)

    await waitFor(
      () => terminal.find((t) => t.kind === 'cancelled' && t.taskId === taskId),
      'cancelled',
    )

    // Drain anything in flight
    await delay(50)
    const terminalsForTask = terminal.filter((t) => t.taskId === taskId)
    expect(terminalsForTask).to.have.length(1)
    expect(terminalsForTask[0].kind).to.equal('cancelled')
  })

  it('scenario 5 — follow-up task succeeds after cancel; agent stayed warm', async () => {
    const started = captureStartedEvents(client)
    const terminal = captureTerminalEvents(client)

    // First task: cancel
    const taskA = randomUUID()
    const agentIdBefore = agentClientId
    await client.requestWithAck('task:create', {content: 'slow', projectPath, taskId: taskA, type: 'curate'})
    await waitFor(() => (started.includes(taskA) ? true : undefined), 'A started')
    await client.requestWithAck<{success: boolean}>('task:cancel', {taskId: taskA})
    await waitFor(
      () => terminal.find((t) => t.kind === 'cancelled' && t.taskId === taskA),
      'A cancelled',
    )

    // Follow-up task: auto-complete
    const taskC = randomUUID()
    behaviors.set(taskC, 'auto-complete')
    await client.requestWithAck('task:create', {content: 'follow-up', projectPath, taskId: taskC, type: 'curate'})

    await waitFor(() => (started.includes(taskC) ? true : undefined), 'C started')
    await waitFor(
      () => terminal.find((t) => t.kind === 'completed' && t.taskId === taskC),
      'C completed',
    )

    // Same agent socket throughout (no fork-recycle)
    expect(agentClientId).to.equal(agentIdBefore)
    expect(mockAgent.getState()).to.equal('connected')
  })
})
