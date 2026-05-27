/**
 * TaskRouter — llmservice accumulator tests.
 *
 * Covers M2.06: the in-memory mutation of `TaskInfo` from `llmservice:*`
 * events plus the throttled `onTaskUpdate` flush. Uses sinon fake timers
 * for deterministic throttle-window verification.
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {createSandbox, type SinonFakeTimers, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAgentPool, SubmitTaskResult} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {ITaskLifecycleHook} from '../../../../src/server/core/interfaces/process/i-task-lifecycle-hook.js'
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

function makeStubAgentPool(sandbox: SinonSandbox): IAgentPool {
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

function makeStubProjectRegistry(sandbox: SinonSandbox): IProjectRegistry {
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

type StubHook = ITaskLifecycleHook & {
  onTaskCancelled: SinonStub
  onTaskCompleted: SinonStub
  onTaskCreate: SinonStub
  onTaskError: SinonStub
  onTaskUpdate: SinonStub
}

function makeStubLifecycleHook(sandbox: SinonSandbox): StubHook {
  return {
    cleanup: sandbox.stub(),
    onTaskCancelled: sandbox.stub().resolves(),
    onTaskCompleted: sandbox.stub().resolves(),
    onTaskCreate: sandbox.stub().resolves(),
    onTaskError: sandbox.stub().resolves(),
    onTaskUpdate: sandbox.stub().resolves(),
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

describe('TaskRouter — llmservice accumulator', () => {
  let sandbox: SinonSandbox
  let clock: SinonFakeTimers
  let transportHelper: ReturnType<typeof makeStubTransportServer>
  let agentPool: ReturnType<typeof makeStubAgentPool>
  let projectRegistry: ReturnType<typeof makeStubProjectRegistry>
  let projectRouter: ReturnType<typeof makeStubProjectRouter>
  let getAgentForProject: SinonStub
  let hook: StubHook
  let router: TaskRouter

  beforeEach(() => {
    sandbox = createSandbox()
    clock = sandbox.useFakeTimers({now: 1_745_432_000_000})
    transportHelper = makeStubTransportServer(sandbox)
    agentPool = makeStubAgentPool(sandbox)
    projectRegistry = makeStubProjectRegistry(sandbox)
    projectRouter = makeStubProjectRouter(sandbox)
    getAgentForProject = sandbox.stub().returns('agent-1')
    hook = makeStubLifecycleHook(sandbox)

    router = new TaskRouter({
      agentPool,
      getAgentForProject,
      lifecycleHooks: [hook],
      projectRegistry,
      projectRouter,
      transport: transportHelper.transport,
    })
    router.setup()
  })

  afterEach(() => {
    sandbox.restore()
  })

  async function createTask(taskId: string, projectPath = '/app'): Promise<void> {
    const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
    await handler!(makeTaskCreateRequest({projectPath, taskId}), 'client-1')
  }

  function dispatchLlm(eventName: string, payload: Record<string, unknown>): void {
    const handler = transportHelper.requestHandlers.get(eventName)
    handler!(payload, 'agent-1')
  }

  function getLiveTask(taskId: string) {
    return router.getTasksForProject('/app').find((t) => t.taskId === taskId)
  }

  it('llmservice:thinking pushes a new isThinking marker to reasoningContents', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.have.lengthOf(1)
    expect(task?.reasoningContents?.[0]).to.include({content: '', isThinking: true})
    expect(task?.reasoningContents?.[0].timestamp).to.be.a('number')
  })

  it('repeated llmservice:thinking events deduplicate (parity with TUI store)', async () => {
    // Without dedup, persisted entries grew multiple consecutive empty
    // {isThinking: true, content: ''} markers that the live UI never showed.
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId})
    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId})
    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.have.lengthOf(1)
    expect(task?.reasoningContents?.[0]).to.include({content: '', isThinking: true})
  })

  it('llmservice:thinking after a non-thinking chunk pushes a new marker (boundary case)', async () => {
    // After body has flowed and the last item is `isThinking: false`, a fresh
    // THINKING signals the model is starting a new reasoning block. Don't dedup.
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId})
    dispatchLlm(LlmEventNames.CHUNK, {content: 'body', sessionId: 's1', taskId, type: 'reasoning'})
    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.have.lengthOf(2)
    expect(task?.reasoningContents?.[0]).to.include({content: 'body', isThinking: false})
    expect(task?.reasoningContents?.[1]).to.include({content: '', isThinking: true})
  })

  it('llmservice:chunk type=reasoning appends content to the last reasoning item', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    // First push a non-thinking entry with body
    dispatchLlm(LlmEventNames.CHUNK, {content: 'foo', sessionId: 's1', taskId, type: 'reasoning'})
    dispatchLlm(LlmEventNames.CHUNK, {content: 'bar', sessionId: 's1', taskId, type: 'reasoning'})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.have.lengthOf(1)
    expect(task?.reasoningContents?.[0].content).to.equal('foobar')
  })

  it('llmservice:chunk type=reasoning flips empty isThinking marker to isThinking=false on first body chunk', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId})
    dispatchLlm(LlmEventNames.CHUNK, {content: 'body', sessionId: 's1', taskId, type: 'reasoning'})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.have.lengthOf(1)
    expect(task?.reasoningContents?.[0]).to.include({content: 'body', isThinking: false})
  })

  it('llmservice:chunk type=reasoning with empty reasoningContents pushes a fresh entry', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.CHUNK, {content: 'first', sessionId: 's1', taskId, type: 'reasoning'})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.have.lengthOf(1)
    expect(task?.reasoningContents?.[0]).to.include({content: 'first', isThinking: false})
  })

  it('llmservice:chunk type=text does NOT mutate TaskInfo', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.CHUNK, {content: 'streaming text', sessionId: 's1', taskId, type: 'text'})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.equal(undefined)
    expect(task?.responseContent).to.equal(undefined)
  })

  it('llmservice:response sets responseContent + sessionId on TaskInfo', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.RESPONSE, {content: 'final answer', sessionId: 'sess-1', taskId})

    const task = getLiveTask(taskId)
    expect(task?.responseContent).to.equal('final answer')
    expect(task?.sessionId).to.equal('sess-1')
  })

  it('llmservice:response overwrites prior responseContent (multi-step agents keep latest)', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.RESPONSE, {content: 'first', sessionId: 's1', taskId})
    dispatchLlm(LlmEventNames.RESPONSE, {content: 'second', sessionId: 's2', taskId})

    const task = getLiveTask(taskId)
    expect(task?.responseContent).to.equal('second')
    expect(task?.sessionId).to.equal('s2')
  })

  it('llmservice:toolCall appends a running entry to toolCalls', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.TOOL_CALL, {
      args: {path: '/file'},
      callId: 'c1',
      sessionId: 's1',
      taskId,
      toolName: 'read',
    })

    const task = getLiveTask(taskId)
    expect(task?.toolCalls).to.have.lengthOf(1)
    expect(task?.toolCalls?.[0]).to.include({
      callId: 'c1',
      sessionId: 's1',
      status: 'running',
      toolName: 'read',
    })
  })

  it('llmservice:toolResult updates the matching toolCall by callId', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.TOOL_CALL, {
      args: {},
      callId: 'c1',
      sessionId: 's1',
      taskId,
      toolName: 'read',
    })
    dispatchLlm(LlmEventNames.TOOL_RESULT, {
      callId: 'c1',
      result: {ok: true},
      sessionId: 's1',
      success: true,
      taskId,
      toolName: 'read',
    })

    const task = getLiveTask(taskId)
    expect(task?.toolCalls).to.have.lengthOf(1)
    expect(task?.toolCalls?.[0]).to.include({callId: 'c1', status: 'completed'})
    expect(task?.toolCalls?.[0].result).to.deep.equal({ok: true})
  })

  it('llmservice:error / :unsupportedInput do NOT mutate TaskInfo', async () => {
    const taskId = randomUUID()
    await createTask(taskId)

    dispatchLlm(LlmEventNames.ERROR, {error: 'boom', sessionId: 's1', taskId})
    dispatchLlm(LlmEventNames.UNSUPPORTED_INPUT, {reason: 'why', sessionId: 's1', taskId})

    const task = getLiveTask(taskId)
    expect(task?.reasoningContents).to.equal(undefined)
    expect(task?.toolCalls).to.equal(undefined)
    expect(task?.responseContent).to.equal(undefined)
  })

  it('events for unknown taskId are ignored', () => {
    // No task created — dispatch should not throw and not call hook
    dispatchLlm(LlmEventNames.THINKING, {sessionId: 's1', taskId: 'never-created'})
    dispatchLlm(LlmEventNames.RESPONSE, {content: 'x', sessionId: 's1', taskId: 'never-created'})
    dispatchLlm(LlmEventNames.TOOL_CALL, {args: {}, callId: 'c1', sessionId: 's1', taskId: 'never-created', toolName: 't'})

    clock.tick(110)
    expect(hook.onTaskUpdate.called).to.equal(false)
  })

  it('rapid event bursts bunch into a single throttled save', async () => {
    const taskId = randomUUID()
    await createTask(taskId)
    hook.onTaskUpdate.resetHistory()

    for (let i = 0; i < 20; i++) {
      dispatchLlm(LlmEventNames.CHUNK, {content: `c${i}`, sessionId: 's1', taskId, type: 'reasoning'})
    }

    // Advance past the 100ms throttle window
    await clock.tickAsync(100)

    expect(hook.onTaskUpdate.callCount).to.equal(1)
  })

  it('throttle window is bounded — no event held >100ms before flush', async () => {
    const taskId = randomUUID()
    await createTask(taskId)
    hook.onTaskUpdate.resetHistory()

    dispatchLlm(LlmEventNames.CHUNK, {content: 'a', sessionId: 's1', taskId, type: 'reasoning'})
    await clock.tickAsync(99)
    expect(hook.onTaskUpdate.called).to.equal(false)

    await clock.tickAsync(1) // total = 100ms — flush should fire
    expect(hook.onTaskUpdate.callCount).to.equal(1)
  })

  it('task:started marks dirty so the next throttled flush saves status=started + startedAt', async () => {
    const taskId = randomUUID()
    await createTask(taskId)
    hook.onTaskUpdate.resetHistory()

    const startedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.STARTED)
    startedHandler!({taskId}, 'agent-1')

    await clock.tickAsync(100)
    expect(hook.onTaskUpdate.callCount).to.equal(1)
    const task = hook.onTaskUpdate.firstCall.args[0]
    expect(task.status).to.equal('started')
    expect(task.startedAt).to.be.a('number')
  })

  it('persistence works with zero connected clients (broadcasts are no-op)', async () => {
    // Drive the full lifecycle even when broadcastToProject is a no-op stub
    // and sendTo is not connected to any real socket.
    const taskId = randomUUID()
    await createTask(taskId)
    expect(hook.onTaskCreate.calledOnce).to.equal(true)

    // Advance past hooks + simulate completion
    const completedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
    completedHandler!({result: 'done', taskId}, 'agent-1')

    expect(hook.onTaskCompleted.calledOnce).to.equal(true)
    // Broadcasts went to no real subscribers; hook still fired.
  })
})
