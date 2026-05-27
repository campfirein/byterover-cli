/**
 * TransportHandlers Unit Tests
 *
 * Tests the message routing logic between clients and Agent in the Transport Process.
 *
 * Key scenarios:
 * - Agent registration and connection state
 * - Task creation and routing
 * - Task lifecycle events (started, completed, error, cancelled)
 * - LLM event routing to correct clients
 * - Agent disconnect handling
 * - Cleanup behavior
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {createSandbox, match, type SinonFakeTimers, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAgentPool} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {
  AgentStatusEventNames,
  LlmEventNames,
  TransportAgentEventNames,
  TransportClientEventNames,
  TransportTaskEventNames,
} from '../../../../src/server/core/domain/transport/schemas.js'
import {TransportHandlers} from '../../../../src/server/infra/process/transport-handlers.js'

describe('TransportHandlers', () => {
  let sandbox: SinonSandbox
  let mockTransport: ITransportServer
  let mockAgentPool: IAgentPool & {submitTask: SinonStub}
  let handlers: TransportHandlers

  // Track registered handlers for testing
  let requestHandlers: Map<string, RequestHandler>
  let connectionHandler: ((clientId: string) => void) | undefined
  let disconnectionHandler: ((clientId: string) => void) | undefined

  beforeEach(() => {
    sandbox = createSandbox()
    requestHandlers = new Map()

    // Create mock transport
    mockTransport = {
      addToRoom: sandbox.stub(),
      broadcast: sandbox.stub(),
      broadcastTo: sandbox.stub(),
      getPort: sandbox.stub().returns(3000),
      isRunning: sandbox.stub().returns(true),
      onConnection: sandbox.stub().callsFake((handler) => {
        connectionHandler = handler
      }),
      onDisconnection: sandbox.stub().callsFake((handler) => {
        disconnectionHandler = handler
      }),
      onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
        requestHandlers.set(event, handler)
      }),
      removeFromRoom: sandbox.stub(),
      sendTo: sandbox.stub(),
      start: sandbox.stub().resolves(),
      stop: sandbox.stub().resolves(),
    }

    mockAgentPool = {
      cancelQueuedTask: sandbox.stub().returns(false),
      getEntries: sandbox.stub().returns([]),
      getSize: sandbox.stub().returns(0),
      handleAgentDisconnected: sandbox.stub(),
      hasAgent: sandbox.stub().returns(false),
      markIdle: sandbox.stub(),
      notifyTaskCompleted: sandbox.stub(),
      shutdown: sandbox.stub().resolves(),
      submitTask: sandbox.stub().resolves({success: true}),
    }

    handlers = new TransportHandlers({agentPool: mockAgentPool, transport: mockTransport})
    handlers.setup()
  })

  afterEach(() => {
    sandbox.restore()
    requestHandlers.clear()
    connectionHandler = undefined
    disconnectionHandler = undefined
  })

  /**
   * Helper: Register agent AND set up status (required for tasks to work).
   * After Fix 5.1, tasks require cachedAgentStatus to be set.
   */
  function registerAgentWithStatus(agentClientId: string): void {
    const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
    registerHandler!({}, agentClientId)

    // Simulate agent status broadcast (required for pre-task check)
    const statusHandler = requestHandlers.get(AgentStatusEventNames.STATUS_CHANGED)
    statusHandler!(
      {
        activeTasks: 0,
        hasAuth: true,
        hasConfig: true,
        isInitialized: true,
        queuedTasks: 0,
      },
      agentClientId,
    )
  }

  function createHandlersWithClientManager() {
    const mockClientManager = {
      associateProject: sandbox.stub(),
      getActiveProjects: sandbox.stub().returns([]),
      getAllClients: sandbox.stub().returns([]),
      getClient: sandbox.stub(),
      getClientsByProject: sandbox.stub().returns([]),
      onClientConnected: sandbox.stub(),
      onClientDisconnected: sandbox.stub(),
      onProjectEmpty: sandbox.stub(),
      register: sandbox.stub(),
      setAgentName: sandbox.stub(),
      unregister: sandbox.stub(),
      updateProjectPath: sandbox.stub(),
    }

    const mockProjectRouter = {
      addToProjectRoom: sandbox.stub(),
      broadcastToProject: sandbox.stub(),
      getProjectMembers: sandbox.stub().returns([]),
      removeFromProjectRoom: sandbox.stub(),
    }

    const mockProjectRegistry = {
      get: sandbox.stub().returns({
        projectPath: '/app',
        registeredAt: 1000,
        sanitizedPath: 'app',
        storagePath: '/data/app',
      }),
      getAll: sandbox.stub().returns(new Map()),
      register: sandbox.stub().returns({
        projectPath: '/app',
        registeredAt: 1000,
        sanitizedPath: 'app',
        storagePath: '/data/app',
      }),
      unregister: sandbox.stub().returns(true),
    }

    // Clear handlers from default setup and create new ones
    requestHandlers.clear()
    const cmHandlers = new TransportHandlers({
      agentPool: mockAgentPool,
      clientManager: mockClientManager,
      projectRegistry: mockProjectRegistry,
      projectRouter: mockProjectRouter,
      transport: mockTransport,
    })
    cmHandlers.setup()

    return {mockClientManager, mockProjectRegistry, mockProjectRouter}
  }

  /**
   * Helper: Create handlers with project routing (projectRouter + projectRegistry).
   * Used by tests that verify task/LLM events are broadcast to project rooms.
   */
  function createHandlersWithProjectRouting() {
    const mockProjectRouter = {
      addToProjectRoom: sandbox.stub(),
      broadcastToProject: sandbox.stub(),
      getProjectMembers: sandbox.stub().returns([]),
      removeFromProjectRoom: sandbox.stub(),
    }

    const mockProjectRegistry = {
      get: sandbox.stub().returns({
        projectPath: '/app',
        registeredAt: 1000,
        sanitizedPath: 'app',
        storagePath: '/data/app',
      }),
      getAll: sandbox.stub().returns(new Map()),
      register: sandbox.stub().returns({
        projectPath: '/app',
        registeredAt: 1000,
        sanitizedPath: 'app',
        storagePath: '/data/app',
      }),
      unregister: sandbox.stub().returns(true),
    }

    requestHandlers.clear()
    const prHandlers = new TransportHandlers({
      agentPool: mockAgentPool,
      projectRegistry: mockProjectRegistry,
      projectRouter: mockProjectRouter,
      transport: mockTransport,
    })
    prHandlers.setup()

    return {mockProjectRegistry, mockProjectRouter, prHandlers}
  }

  describe('Agent Registration', () => {
    it('should register agent on agent:register event', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      expect(registerHandler).to.exist

      const result = registerHandler!({projectPath: '/app'}, 'agent-client-001')

      expect(result).to.deep.equal({success: true})
      expect(mockProjectRouter.broadcastToProject.calledWith('app', TransportAgentEventNames.CONNECTED, {})).to.be.true
    })

    it('should allow agent to re-register (replace old agent)', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)

      // First registration
      registerHandler!({projectPath: '/app'}, 'agent-client-001')

      // Second registration should succeed
      const result = registerHandler!({projectPath: '/app'}, 'agent-client-002')
      expect(result).to.deep.equal({success: true})

      // Broadcast should be called twice (once per registration)
      expect(mockProjectRouter.broadcastToProject.calledWith('app', TransportAgentEventNames.CONNECTED, {})).to.be.true
      expect(
        mockProjectRouter.broadcastToProject
          .getCalls()
          .filter((c: {args: unknown[]}) => c.args[1] === TransportAgentEventNames.CONNECTED).length,
      ).to.equal(2)
    })
  })

  describe('Task Creation', () => {
    it('should accept task with client-generated taskId and send ack', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      expect(createHandler).to.exist

      // Register agent with status (required for pre-task check)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const result = await createHandler!({content: 'Test task', taskId, type: 'curate'}, 'client-001')

      // Should return the same taskId that was sent
      expect(result).to.deep.equal({taskId})

      // Verify ack was sent to client with the same taskId
      expect((mockTransport.sendTo as SinonStub).calledWith('client-001', TransportTaskEventNames.ACK, {taskId})).to.be
        .true
    })

    it('should return idempotent response for duplicate taskId', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()

      // First creation succeeds
      const result1 = await createHandler!({content: 'Task 1', taskId, type: 'curate'}, 'client-001')
      expect(result1).to.deep.equal({taskId})

      // Second creation with same taskId returns idempotent response
      const result2 = await createHandler!({content: 'Task 2', taskId, type: 'curate'}, 'client-002')
      expect(result2).to.deep.equal({taskId})
    })

    it('should broadcast task:created to project room', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!({content: 'Broadcast test', projectPath: '/app', taskId, type: 'query'}, 'client-001')

      expect(
        mockProjectRouter.broadcastToProject.calledWith(
          'app',
          TransportTaskEventNames.CREATED,
          sandbox.match({content: 'Broadcast test', taskId, type: 'query'}),
        ),
      ).to.be.true
    })

    it('should submit task to AgentPool with client-provided taskId', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      await createHandler!({content: 'Execute test', taskId, type: 'curate'}, 'client-001')

      expect(mockAgentPool.submitTask.calledOnce).to.be.true
      expect(
        mockAgentPool.submitTask.calledWith(
          sandbox.match({
            clientId: 'client-001',
            content: 'Execute test',
            taskId,
            type: 'curate',
          }),
        ),
      ).to.be.true
    })

    it('should include files in AgentPool submitTask when provided', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      await createHandler!(
        {content: 'Files test', files: ['/file1.ts', '/file2.ts'], taskId, type: 'curate'},
        'client-001',
      )

      expect(mockAgentPool.submitTask.calledWith(sandbox.match({files: ['/file1.ts', '/file2.ts'], taskId}))).to.be.true
    })
  })

  describe('Agent Not Available', () => {
    it('should send immediate error when no AgentPool available', async () => {
      // Create handlers WITHOUT agentPool to test the no-pool scenario
      requestHandlers.clear()
      const noPoolProjectRouter = {
        addToProjectRoom: sandbox.stub(),
        broadcastToProject: sandbox.stub(),
        getProjectMembers: sandbox.stub().returns([]),
        removeFromProjectRoom: sandbox.stub(),
      }
      const noPoolProjectRegistry = {
        get: sandbox
          .stub()
          .returns({projectPath: '/app', registeredAt: 1000, sanitizedPath: 'app', storagePath: '/data/app'}),
        getAll: sandbox.stub().returns(new Map()),
        register: sandbox
          .stub()
          .returns({projectPath: '/app', registeredAt: 1000, sanitizedPath: 'app', storagePath: '/data/app'}),
        unregister: sandbox.stub().returns(true),
      }
      const noPoolHandlers = new TransportHandlers({
        projectRegistry: noPoolProjectRegistry,
        projectRouter: noPoolProjectRouter,
        transport: mockTransport,
      })
      noPoolHandlers.setup()

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)

      const taskId = randomUUID()
      const result = (await createHandler!(
        {content: 'No pool test', projectPath: '/app', taskId, type: 'curate'},
        'client-001',
      )) as {
        taskId: string
      }

      expect(result.taskId).to.equal(taskId)

      // Error should be sent to client immediately (no delay)
      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-001',
          TransportTaskEventNames.ERROR,
          sandbox.match({taskId}),
        ),
      ).to.be.true

      // Error should also be broadcast to project room
      expect(
        noPoolProjectRouter.broadcastToProject.calledWith(
          'app',
          TransportTaskEventNames.ERROR,
          sandbox.match({taskId}),
        ),
      ).to.be.true
    })
  })

  describe('Task Completion', () => {
    it('should route task:completed to task owner', () => {
      // Create a task first
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Complete test', taskId, type: 'curate'}, 'client-001')

      // Simulate task completed from agent
      const completedHandler = requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'Task done!', taskId}, 'agent-001')

      expect(
        (mockTransport.sendTo as SinonStub).calledWith('client-001', TransportTaskEventNames.COMPLETED, {
          result: 'Task done!',
          taskId,
        }),
      ).to.be.true
    })

    it('should broadcast task:completed to project room', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!({content: 'Broadcast complete', projectPath: '/app', taskId, type: 'query'}, 'client-001')

      const completedHandler = requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'Done', taskId}, 'agent-001')

      expect(
        mockProjectRouter.broadcastToProject.calledWith('app', TransportTaskEventNames.COMPLETED, {
          result: 'Done',
          taskId,
        }),
      ).to.be.true
    })

    it('should clean up task from internal tracking after completion', async () => {
      // Use fake timers to control grace period
      const clock: SinonFakeTimers = sandbox.useFakeTimers()

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Cleanup test', taskId, type: 'curate'}, 'client-001')

      // Complete the task
      const completedHandler = requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'Done', taskId}, 'agent-001')

      // Advance past the 5-second grace period
      await clock.tickAsync(5100)

      // Reset call history to only capture new calls
      ;(mockTransport.sendTo as SinonStub).resetHistory()

      // Try to send an LLM event for the completed task - should be dropped after grace period
      const responseHandler = requestHandlers.get(LlmEventNames.RESPONSE)
      responseHandler!(
        {
          content: 'Late response',
          sessionId: 'session-001',
          taskId,
        },
        'agent-001',
      )

      // The LLM event should NOT be forwarded (task was cleaned up after grace period)
      const sendToCalls = (mockTransport.sendTo as SinonStub).getCalls()
      const lateResponseCall = sendToCalls.find(
        (call) =>
          call.args[1] === LlmEventNames.RESPONSE &&
          call.args[2]?.taskId === taskId &&
          call.args[2]?.content === 'Late response',
      )
      expect(lateResponseCall).to.be.undefined

      clock.restore()
    })
  })

  describe('Task Error', () => {
    it('should route task:error to task owner', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Error test', taskId, type: 'curate'}, 'client-001')

      const errorHandler = requestHandlers.get(TransportTaskEventNames.ERROR)
      errorHandler!(
        {
          error: {code: 'TEST_ERROR', message: 'Test error', name: 'TestError'},
          taskId,
        },
        'agent-001',
      )

      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-001',
          TransportTaskEventNames.ERROR,
          sandbox.match({taskId}),
        ),
      ).to.be.true
    })

    it('should broadcast task:error to project room', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!({content: 'Broadcast error', projectPath: '/app', taskId, type: 'query'}, 'client-001')

      const errorHandler = requestHandlers.get(TransportTaskEventNames.ERROR)
      errorHandler!(
        {
          error: {code: 'BROADCAST_ERROR', message: 'Test', name: 'Error'},
          taskId,
        },
        'agent-001',
      )

      expect(
        mockProjectRouter.broadcastToProject.calledWith('app', TransportTaskEventNames.ERROR, sandbox.match({taskId})),
      ).to.be.true
    })

    it('should clean up task after error', async () => {
      // Use fake timers to control grace period
      const clock: SinonFakeTimers = sandbox.useFakeTimers()

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Error cleanup', taskId, type: 'curate'}, 'client-001')

      const errorHandler = requestHandlers.get(TransportTaskEventNames.ERROR)
      errorHandler!({error: {message: 'Test', name: 'Error'}, taskId}, 'agent-001')

      // Advance past the 5-second grace period
      await clock.tickAsync(5100)

      // Reset call history to only capture new calls
      ;(mockTransport.sendTo as SinonStub).resetHistory()

      // Subsequent events should be dropped after grace period
      const responseHandler = requestHandlers.get(LlmEventNames.RESPONSE)
      responseHandler!({content: 'After error', sessionId: 's1', taskId}, 'agent-001')

      // Should not forward after error cleanup (grace period expired)
      const postErrorCalls = (mockTransport.sendTo as SinonStub)
        .getCalls()
        .filter((call) => call.args[2]?.content === 'After error')
      expect(postErrorCalls).to.have.length(0)

      clock.restore()
    })
  })

  describe('Task Cancellation', () => {
    it('should forward cancel to agent when connected', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Cancel test', taskId, type: 'curate'}, 'client-001')

      const cancelHandler = requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId}, 'client-001')

      expect(result).to.deep.equal({success: true})
      expect(
        (mockTransport.sendTo as SinonStub).calledWith('agent-001', TransportTaskEventNames.CANCEL, {
          taskId,
        }),
      ).to.be.true
    })

    it('should cancel task locally when no agent registered for project', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)

      // Create task WITHOUT registering agent first
      // With agentPool, task is submitted and tracked (pool handles agent forking)
      const taskId = randomUUID()
      createHandler!({content: 'No agent task', taskId, type: 'curate'}, 'client-001')

      // Cancel should succeed — task is tracked, cancelled locally (no agent to forward to)
      const cancelHandler = requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId}, 'client-001')

      expect(result).to.deep.equal({success: true})

      // Verify task:cancelled was sent to client
      expect((mockTransport.sendTo as SinonStub).calledWith('client-001', TransportTaskEventNames.CANCELLED, {taskId}))
        .to.be.true
    })

    it('should return error for non-existent task', async () => {
      const cancelHandler = requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId: 'non-existent-task'}, 'client-001')

      expect(result).to.deep.equal({error: 'Task not found', success: false})
    })

    it('should handle task:cancelled from agent', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!({content: 'Agent cancel', projectPath: '/app', taskId, type: 'curate'}, 'client-001')

      const cancelledHandler = requestHandlers.get(TransportTaskEventNames.CANCELLED)
      cancelledHandler!({taskId}, 'agent-001')

      expect(
        (mockTransport.sendTo as SinonStub).calledWith('client-001', TransportTaskEventNames.CANCELLED, {
          taskId,
        }),
      ).to.be.true

      expect(
        mockProjectRouter.broadcastToProject.calledWith('app', TransportTaskEventNames.CANCELLED, {
          taskId,
        }),
      ).to.be.true
    })
  })

  describe('Task Started', () => {
    it('should route task:started to task owner', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Started test', taskId, type: 'curate'}, 'client-001')

      const startedHandler = requestHandlers.get(TransportTaskEventNames.STARTED)
      startedHandler!({taskId}, 'agent-001')

      expect(
        (mockTransport.sendTo as SinonStub).calledWith('client-001', TransportTaskEventNames.STARTED, {
          taskId,
        }),
      ).to.be.true
    })

    it('should broadcast task:started with task info to project room', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!(
        {content: 'Broadcast started', files: ['/test.ts'], projectPath: '/app', taskId, type: 'curate'},
        'client-001',
      )

      const startedHandler = requestHandlers.get(TransportTaskEventNames.STARTED)
      startedHandler!({taskId}, 'agent-001')

      expect(
        mockProjectRouter.broadcastToProject.calledWith(
          'app',
          TransportTaskEventNames.STARTED,
          sandbox.match({
            content: 'Broadcast started',
            files: ['/test.ts'],
            taskId,
            type: 'curate',
          }),
        ),
      ).to.be.true
    })

    it('should handle task:started for unknown task gracefully', () => {
      const startedHandler = requestHandlers.get(TransportTaskEventNames.STARTED)

      // Should not throw
      expect(() => startedHandler!({taskId: 'unknown-task'}, 'agent-001')).to.not.throw()

      // Should NOT broadcast (no task context = no project room to broadcast to)
      expect((mockTransport.broadcastTo as SinonStub).called).to.be.false
    })
  })

  describe('Agent Disconnect', () => {
    it('should broadcast agent:disconnected on agent disconnect', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-001')

      disconnectionHandler!('agent-001')

      expect(mockProjectRouter.broadcastToProject.calledWith('app', TransportAgentEventNames.DISCONNECTED, {})).to.be
        .true
    })

    it('should fail all pending tasks on agent disconnect', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      // Create multiple tasks
      const taskId1 = randomUUID()
      const taskId2 = randomUUID()
      createHandler!({content: 'Task 1', taskId: taskId1, type: 'curate'}, 'client-001')
      createHandler!({content: 'Task 2', taskId: taskId2, type: 'query'}, 'client-002')

      // Disconnect agent
      disconnectionHandler!('agent-001')

      // Both tasks should receive errors
      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-001',
          TransportTaskEventNames.ERROR,
          sandbox.match({taskId: taskId1}),
        ),
      ).to.be.true

      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-002',
          TransportTaskEventNames.ERROR,
          sandbox.match({taskId: taskId2}),
        ),
      ).to.be.true
    })

    it('should broadcast errors to project room on agent disconnect', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()

      // Register agent WITH projectPath so disconnect correctly finds project tasks
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-001')

      const statusHandler = requestHandlers.get(AgentStatusEventNames.STATUS_CHANGED)
      statusHandler!({activeTasks: 0, hasAuth: true, hasConfig: true, isInitialized: true, queuedTasks: 0}, 'agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!({content: 'Broadcast error', projectPath: '/app', taskId, type: 'curate'}, 'client-001')

      disconnectionHandler!('agent-001')

      expect(
        mockProjectRouter.broadcastToProject.calledWith('app', TransportTaskEventNames.ERROR, sandbox.match({taskId})),
      ).to.be.true
    })

    it('should clear tasks map after agent disconnect', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Clear test', taskId, type: 'curate'}, 'client-001')

      disconnectionHandler!('agent-001')

      // Re-register agent with status
      registerAgentWithStatus('agent-002')
      ;(mockTransport.sendTo as SinonStub).resetHistory()

      // Try to cancel the old task - should fail (not found)
      const cancelHandler = requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId: 'old-task-id'}, 'client-001')

      expect(result).to.deep.equal({error: 'Task not found', success: false})
    })

    it('should not affect non-agent client disconnections', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Non-agent test', taskId, type: 'curate'}, 'client-001')

      // Disconnect a regular client
      disconnectionHandler!('client-001')

      // Agent should still be connected, task should still exist
      // Cancel should still work
      const cancelHandler = requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId}, 'client-002')

      expect(result).to.deep.equal({success: true})
    })
  })

  describe('LLM Event Routing', () => {
    it('should route llmservice:response to task owner', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Response test', taskId, type: 'curate'}, 'client-001')

      const responseHandler = requestHandlers.get(LlmEventNames.RESPONSE)
      responseHandler!(
        {
          content: 'Hello from LLM',
          sessionId: 'session-001',
          taskId,
        },
        'agent-001',
      )

      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-001',
          LlmEventNames.RESPONSE,
          sandbox.match({content: 'Hello from LLM', taskId}),
        ),
      ).to.be.true
    })

    it('should broadcast LLM events to project room', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!({content: 'Broadcast LLM', projectPath: '/app', taskId, type: 'curate'}, 'client-001')

      const responseHandler = requestHandlers.get(LlmEventNames.RESPONSE)
      responseHandler!({content: 'Broadcast content', sessionId: 's1', taskId}, 'agent-001')

      expect(mockProjectRouter.broadcastToProject.calledWith('app', LlmEventNames.RESPONSE, sandbox.match({taskId}))).to
        .be.true
    })

    it('should route llmservice:toolCall correctly', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Tool test', taskId, type: 'curate'}, 'client-001')

      const toolCallHandler = requestHandlers.get(LlmEventNames.TOOL_CALL)
      toolCallHandler!(
        {
          args: {path: '/test.ts'},
          sessionId: 's1',
          taskId,
          toolName: 'read_file',
        },
        'agent-001',
      )

      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-001',
          LlmEventNames.TOOL_CALL,
          sandbox.match({toolName: 'read_file'}),
        ),
      ).to.be.true
    })

    it('should preserve toolName field (not name) in llmservice:toolCall routing', () => {
      // Regression test: Ensure toolName is preserved and 'name' field is NOT added
      const {mockProjectRouter} = createHandlersWithProjectRouting()
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      createHandler!({content: 'test', projectPath: '/app', taskId, type: 'query'}, 'client-001')

      // Simulate toolCall with ONLY toolName (no name field)
      const toolCallHandler = requestHandlers.get(LlmEventNames.TOOL_CALL)
      toolCallHandler!(
        {
          args: {pattern: 'test'},
          callId: 'call-123',
          sessionId: 'session-1',
          taskId,
          toolName: 'grep_content',
        },
        'agent-001',
      )

      // Verify: sendTo should have toolName, NOT name
      const sendToCalls = (mockTransport.sendTo as SinonStub).getCalls()
      const sendToCall = sendToCalls.find((c) => c.args[1] === LlmEventNames.TOOL_CALL)
      expect(sendToCall).to.exist
      expect(sendToCall!.args[2].toolName).to.equal('grep_content')
      expect(sendToCall!.args[2]).to.not.have.property('name')

      // Verify: broadcastToProject should also have toolName, NOT name
      const broadcastCalls = mockProjectRouter.broadcastToProject.getCalls()
      const broadcastCall = broadcastCalls.find((c: {args: unknown[]}) => c.args[1] === LlmEventNames.TOOL_CALL)
      expect(broadcastCall).to.exist
      expect(broadcastCall!.args[2].toolName).to.equal('grep_content')
      expect(broadcastCall!.args[2]).to.not.have.property('name')
    })

    it('should route llmservice:toolResult correctly', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Tool result test', taskId, type: 'curate'}, 'client-001')

      const toolResultHandler = requestHandlers.get(LlmEventNames.TOOL_RESULT)
      toolResultHandler!(
        {
          result: 'file contents',
          sessionId: 's1',
          success: true,
          taskId,
          toolName: 'read_file',
        },
        'agent-001',
      )

      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-001',
          LlmEventNames.TOOL_RESULT,
          sandbox.match({success: true, toolName: 'read_file'}),
        ),
      ).to.be.true
    })

    it('should route llmservice:chunk correctly', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Chunk test', taskId, type: 'curate'}, 'client-001')

      const chunkHandler = requestHandlers.get(LlmEventNames.CHUNK)
      chunkHandler!(
        {
          content: 'Streaming chunk',
          sessionId: 's1',
          taskId,
          type: 'text',
        },
        'agent-001',
      )

      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-001',
          LlmEventNames.CHUNK,
          sandbox.match({content: 'Streaming chunk', type: 'text'}),
        ),
      ).to.be.true
    })

    it('should route llmservice:thinking correctly', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Thinking test', taskId, type: 'curate'}, 'client-001')

      const thinkingHandler = requestHandlers.get(LlmEventNames.THINKING)
      thinkingHandler!({sessionId: 's1', taskId}, 'agent-001')

      expect(
        (mockTransport.sendTo as SinonStub).calledWith('client-001', LlmEventNames.THINKING, sandbox.match({taskId})),
      ).to.be.true
    })
  })

  describe('Orphan Event Handling', () => {
    it('should drop LLM events for unknown taskId', () => {
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({}, 'agent-001')

      const responseHandler = requestHandlers.get(LlmEventNames.RESPONSE)
      responseHandler!({content: 'Orphan content', sessionId: 's1', taskId: 'unknown-task'}, 'agent-001')

      // Should not forward to any client
      const forwardCalls = (mockTransport.sendTo as SinonStub)
        .getCalls()
        .filter((call) => call.args[1] === LlmEventNames.RESPONSE)
      expect(forwardCalls).to.have.length(0)
    })

    it('should drop events for already completed tasks', async () => {
      // Use fake timers to control grace period
      const clock: SinonFakeTimers = sandbox.useFakeTimers()

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Completed task', taskId, type: 'curate'}, 'client-001')

      // Complete the task
      const completedHandler = requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'Done', taskId}, 'agent-001')

      // Advance past the 5-second grace period
      await clock.tickAsync(5100)
      ;(mockTransport.sendTo as SinonStub).resetHistory()
      ;(mockTransport.broadcastTo as SinonStub).resetHistory()

      // Send late event after grace period
      const responseHandler = requestHandlers.get(LlmEventNames.RESPONSE)
      responseHandler!({content: 'Late event', sessionId: 's1', taskId}, 'agent-001')

      // No LLM events should be forwarded (grace period expired)
      expect((mockTransport.sendTo as SinonStub).called).to.be.false
      expect((mockTransport.broadcastTo as SinonStub).called).to.be.false

      clock.restore()
    })
  })

  describe('Agent Control Handlers', () => {
    it('should handle agent:restart request', () => {
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({}, 'agent-001')

      const restartHandler = requestHandlers.get(TransportAgentEventNames.RESTART)
      const result = restartHandler!({reason: 'config change'}, 'client-001')

      expect(result).to.deep.equal({success: true})
      expect(
        (mockTransport.sendTo as SinonStub).calledWith('agent-001', TransportAgentEventNames.RESTART, {
          reason: 'config change',
        }),
      ).to.be.true
    })

    it('should return error for restart when agent not connected', () => {
      const restartHandler = requestHandlers.get(TransportAgentEventNames.RESTART)
      const result = restartHandler!({reason: 'test'}, 'client-001')

      expect(result).to.deep.equal({error: 'Agent not connected', success: false})
    })

    it('should broadcast agent:restarting on restart request', () => {
      const {mockClientManager, mockProjectRouter} = createHandlersWithClientManager()

      // Register agent with projectPath
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-001')

      // Client requesting restart must have projectPath so broadcastToProjectRoom works
      mockClientManager.getClient.withArgs('client-001').returns({projectPath: '/app', type: 'tui'})

      const restartHandler = requestHandlers.get(TransportAgentEventNames.RESTART)
      restartHandler!({reason: 'broadcast test'}, 'client-001')

      expect(
        mockProjectRouter.broadcastToProject.calledWith('app', TransportAgentEventNames.RESTARTING, {
          reason: 'broadcast test',
        }),
      ).to.be.true
    })

    it('should handle agent:restarted success', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()

      // Register agent with projectPath so findProjectForAgent works
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-001')

      const restartedHandler = requestHandlers.get(TransportAgentEventNames.RESTARTED)
      restartedHandler!({success: true}, 'agent-001')

      expect(
        mockProjectRouter.broadcastToProject.calledWith('app', TransportAgentEventNames.RESTARTED, {success: true}),
      ).to.be.true
    })

    it('should handle agent:restarted failure', () => {
      const {mockProjectRouter} = createHandlersWithProjectRouting()

      // Register agent with projectPath so findProjectForAgent works
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-001')

      const restartedHandler = requestHandlers.get(TransportAgentEventNames.RESTARTED)
      restartedHandler!({error: 'Failed to restart', success: false}, 'agent-001')

      expect(
        mockProjectRouter.broadcastToProject.calledWith('app', TransportAgentEventNames.RESTARTED, {
          error: 'Failed to restart',
          success: false,
        }),
      ).to.be.true
    })
  })

  describe('Cleanup', () => {
    it('should clear tasks and agent on cleanup()', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      registerAgentWithStatus('agent-001')

      const taskId = randomUUID()
      createHandler!({content: 'Cleanup test', taskId, type: 'curate'}, 'client-001')

      handlers.cleanup()

      // After cleanup, cancel should fail (no tasks)
      const cancelHandler = requestHandlers.get(TransportTaskEventNames.CANCEL)
      const result = await cancelHandler!({taskId: 'any-task'}, 'client-001')
      expect(result).to.deep.equal({error: 'Task not found', success: false})

      // Restart should fail (no agent)
      const restartHandler = requestHandlers.get(TransportAgentEventNames.RESTART)
      const restartResult = restartHandler!({}, 'client-001')
      expect(restartResult).to.deep.equal({error: 'Agent not connected', success: false})
    })
  })

  describe('Connection Handlers', () => {
    it('should track client connections', () => {
      expect(connectionHandler).to.exist
      expect(() => connectionHandler!('new-client-001')).to.not.throw()
    })

    it('should track client disconnections', () => {
      expect(disconnectionHandler).to.exist
      expect(() => disconnectionHandler!('client-001')).to.not.throw()
    })
  })

  describe('ProjectRouter Integration', () => {
    it('should accept optional ProjectRouter parameter', () => {
      const mockProjectRouter = {
        addToProjectRoom: sandbox.stub(),
        broadcastToProject: sandbox.stub(),
        getProjectMembers: sandbox.stub().returns([]),
        removeFromProjectRoom: sandbox.stub(),
      }

      const handlersWithRouter = new TransportHandlers({projectRouter: mockProjectRouter, transport: mockTransport})
      expect(() => handlersWithRouter.setup()).to.not.throw()
    })

    it('should work without ProjectRouter (backward compatible)', () => {
      const handlersWithoutRouter = new TransportHandlers({transport: mockTransport})
      expect(() => handlersWithoutRouter.setup()).to.not.throw()
    })
  })

  describe('ClientManager Integration', () => {
    it('should accept optional ClientManager parameter', () => {
      const mockClientManager = {
        associateProject: sandbox.stub(),
        getActiveProjects: sandbox.stub().returns([]),
        getAllClients: sandbox.stub().returns([]),
        getClient: sandbox.stub(),
        getClientsByProject: sandbox.stub().returns([]),
        onClientConnected: sandbox.stub(),
        onClientDisconnected: sandbox.stub(),
        onProjectEmpty: sandbox.stub(),
        register: sandbox.stub(),
        setAgentName: sandbox.stub(),
        unregister: sandbox.stub(),
        updateProjectPath: sandbox.stub(),
      }

      const handlersWithCM = new TransportHandlers({
        clientManager: mockClientManager,
        transport: mockTransport,
      })
      expect(() => handlersWithCM.setup()).to.not.throw()
    })

    it('should work without ClientManager (backward compatible)', () => {
      const handlersWithoutCM = new TransportHandlers({transport: mockTransport})
      expect(() => handlersWithoutCM.setup()).to.not.throw()
    })

    it('should register agent with ClientManager on agent:register', () => {
      const mockClientManager = {
        associateProject: sandbox.stub(),
        getActiveProjects: sandbox.stub().returns([]),
        getAllClients: sandbox.stub().returns([]),
        getClient: sandbox.stub(),
        getClientsByProject: sandbox.stub().returns([]),
        onClientConnected: sandbox.stub(),
        onClientDisconnected: sandbox.stub(),
        onProjectEmpty: sandbox.stub(),
        register: sandbox.stub(),
        setAgentName: sandbox.stub(),
        unregister: sandbox.stub(),
        updateProjectPath: sandbox.stub(),
      }

      const cmHandlers = new TransportHandlers({
        clientManager: mockClientManager,
        transport: mockTransport,
      })
      cmHandlers.setup()

      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-001')

      expect(mockClientManager.register.calledOnce).to.be.true
      expect(mockClientManager.register.calledWith('agent-001', 'agent', '/app')).to.be.true
    })

    it('should unregister client from ClientManager on disconnect', () => {
      const mockClientManager = {
        associateProject: sandbox.stub(),
        getActiveProjects: sandbox.stub().returns([]),
        getAllClients: sandbox.stub().returns([]),
        getClient: sandbox.stub(),
        getClientsByProject: sandbox.stub().returns([]),
        onClientConnected: sandbox.stub(),
        onClientDisconnected: sandbox.stub(),
        onProjectEmpty: sandbox.stub(),
        register: sandbox.stub(),
        setAgentName: sandbox.stub(),
        unregister: sandbox.stub(),
        updateProjectPath: sandbox.stub(),
      }

      const cmHandlers = new TransportHandlers({
        clientManager: mockClientManager,
        transport: mockTransport,
      })
      cmHandlers.setup()

      // Simulate connection and then disconnection of a non-agent client
      disconnectionHandler!('client-123')

      expect(mockClientManager.unregister.calledOnce).to.be.true
      expect(mockClientManager.unregister.calledWith('client-123')).to.be.true
    })
  })

  describe('Per-Project Agent Disconnect', () => {
    it('should fail only the disconnected agent project tasks, not all tasks', () => {
      // Register two agents for two different projects
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/project-a'}, 'agent-a')
      registerHandler!({projectPath: '/project-b'}, 'agent-b')

      // Set agent status as initialized
      const statusHandler = requestHandlers.get(AgentStatusEventNames.STATUS_CHANGED)
      statusHandler!({activeTasks: 0, hasAuth: true, hasConfig: true, isInitialized: true, queuedTasks: 0}, 'agent-a')

      // Create tasks for both projects
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskIdA = randomUUID()
      const taskIdB = randomUUID()
      createHandler!({content: 'Task A', projectPath: '/project-a', taskId: taskIdA, type: 'curate'}, 'client-1')
      createHandler!({content: 'Task B', projectPath: '/project-b', taskId: taskIdB, type: 'curate'}, 'client-2')

      // Disconnect agent-a
      disconnectionHandler!('agent-a')

      // Task A should have received error (its agent disconnected)
      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-1',
          TransportTaskEventNames.ERROR,
          match.has('taskId', taskIdA),
        ),
      ).to.be.true

      // Task B should NOT have received error (its agent is still alive)
      expect(
        (mockTransport.sendTo as SinonStub).calledWith(
          'client-2',
          TransportTaskEventNames.ERROR,
          match.has('taskId', taskIdB),
        ),
      ).to.be.false
    })

    it('should keep tasks for other projects alive when one agent disconnects', () => {
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/project-a'}, 'agent-a')
      registerHandler!({projectPath: '/project-b'}, 'agent-b')

      const statusHandler = requestHandlers.get(AgentStatusEventNames.STATUS_CHANGED)
      statusHandler!({activeTasks: 0, hasAuth: true, hasConfig: true, isInitialized: true, queuedTasks: 0}, 'agent-a')

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskIdB = randomUUID()
      createHandler!({content: 'Task B', projectPath: '/project-b', taskId: taskIdB, type: 'query'}, 'client-2')

      // Disconnect agent-a — should not affect project-b's task
      disconnectionHandler!('agent-a')

      // Complete project-b's task via agent-b (should still work)
      const completedHandler = requestHandlers.get(TransportTaskEventNames.COMPLETED)
      completedHandler!({result: 'Done B', taskId: taskIdB}, 'agent-b')

      expect(
        (mockTransport.sendTo as SinonStub).calledWith('client-2', TransportTaskEventNames.COMPLETED, {
          result: 'Done B',
          taskId: taskIdB,
        }),
      ).to.be.true
    })
  })

  describe('ProjectPath in Task Routing', () => {
    it('should include projectPath in submitTask when provided', async () => {
      registerAgentWithStatus('agent-001')

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()
      await createHandler!({content: 'Test', projectPath: '/my-project', taskId, type: 'curate'}, 'client-1')

      // Verify submitTask includes projectPath
      expect(mockAgentPool.submitTask.calledWith(match.has('projectPath', '/my-project'))).to.be.true
    })

    it('should not include projectPath in submitTask when not provided', async () => {
      registerAgentWithStatus('agent-001')

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()
      await createHandler!({content: 'Test', taskId, type: 'curate'}, 'client-1')

      // Verify submitTask was called and payload does NOT have projectPath
      expect(mockAgentPool.submitTask.calledOnce).to.be.true
      const submitArg = mockAgentPool.submitTask.firstCall.args[0]
      expect(submitArg).to.not.have.property('projectPath')
    })

    it('should submit task with projectPath to AgentPool for routing', async () => {
      // Register two agents for two projects
      const registerHandler = requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/project-a'}, 'agent-a')
      registerHandler!({projectPath: '/project-b'}, 'agent-b')

      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()
      await createHandler!({content: 'Test', projectPath: '/project-b', taskId, type: 'curate'}, 'client-1')

      // Task is submitted to AgentPool with projectPath — pool handles routing
      expect(mockAgentPool.submitTask.calledWith(match.has('projectPath', '/project-b'))).to.be.true
      expect(mockAgentPool.submitTask.calledWith(match.has('taskId', taskId))).to.be.true
    })
  })

  describe('Client Lifecycle Handlers', () => {
    describe('client:register', () => {
      it('should register external client with projectPath in ClientManager', () => {
        const {mockClientManager, mockProjectRouter} = createHandlersWithClientManager()

        const registerHandler = requestHandlers.get(TransportClientEventNames.REGISTER)
        const result = registerHandler!({clientType: 'tui', projectPath: '/app'}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect(mockClientManager.register.calledOnce).to.be.true
        expect(mockClientManager.register.calledWith('client-1', 'tui', '/app')).to.be.true
        expect(mockProjectRouter.addToProjectRoom.calledOnce).to.be.true
        expect(mockProjectRouter.addToProjectRoom.calledWith('client-1', 'app')).to.be.true
      })

      it('should register cli client with projectPath', () => {
        const {mockClientManager} = createHandlersWithClientManager()

        const registerHandler = requestHandlers.get(TransportClientEventNames.REGISTER)
        const result = registerHandler!({clientType: 'cli', projectPath: '/app'}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect(mockClientManager.register.calledWith('client-1', 'cli', '/app')).to.be.true
      })

      it('should register global-scope MCP without projectPath', () => {
        const {mockClientManager, mockProjectRouter} = createHandlersWithClientManager()

        const registerHandler = requestHandlers.get(TransportClientEventNames.REGISTER)
        const result = registerHandler!({clientType: 'mcp'}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect(mockClientManager.register.calledWith('client-1', 'mcp')).to.be.true
        // Should NOT add to project room (no projectPath)
        expect(mockProjectRouter.addToProjectRoom.called).to.be.false
      })

      it('should return error when ClientManager not available', () => {
        // Default handlers have no ClientManager
        const registerHandler = requestHandlers.get(TransportClientEventNames.REGISTER)
        const result = registerHandler!({clientType: 'tui', projectPath: '/app'}, 'client-1')

        expect(result).to.deep.equal({error: 'ClientManager not available', success: false})
      })
    })

    describe('client:associateProject', () => {
      it('should associate global-scope MCP client with project', () => {
        const {mockClientManager, mockProjectRouter} = createHandlersWithClientManager()

        // Simulate an unassociated MCP client
        mockClientManager.getClient.returns({
          connectedAt: 1000,
          hasProject: false,
          id: 'client-1',
          isExternalClient: true,
          projectPath: undefined,
          type: 'mcp',
        })

        const associateHandler = requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)
        const result = associateHandler!({projectPath: '/app'}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect(mockClientManager.associateProject.calledOnce).to.be.true
        expect(mockClientManager.associateProject.calledWith('client-1', '/app')).to.be.true
        expect(mockProjectRouter.addToProjectRoom.calledWith('client-1', 'app')).to.be.true
      })

      it('should be idempotent when same project path', () => {
        const {mockClientManager, mockProjectRouter} = createHandlersWithClientManager()

        mockClientManager.getClient.returns({
          connectedAt: 1000,
          hasProject: true,
          id: 'client-1',
          isExternalClient: true,
          projectPath: '/existing',
          type: 'mcp',
        })

        const associateHandler = requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)
        const result = associateHandler!({projectPath: '/existing'}, 'client-1')

        expect(result).to.deep.equal({success: true})
        // Same path — no reassociation needed
        expect(mockClientManager.updateProjectPath.called).to.be.false
        expect(mockProjectRouter.addToProjectRoom.called).to.be.false
      })

      it('should reassociate when project path changes', () => {
        const {mockClientManager, mockProjectRouter} = createHandlersWithClientManager()

        mockClientManager.getClient.returns({
          connectedAt: 1000,
          hasProject: true,
          id: 'client-1',
          isExternalClient: true,
          projectPath: '/existing',
          type: 'mcp',
        })
        mockClientManager.updateProjectPath.returns('/existing')

        const associateHandler = requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)
        const result = associateHandler!({projectPath: '/new-project'}, 'client-1')

        expect(result).to.deep.equal({success: true})
        expect(mockClientManager.updateProjectPath.calledWith('client-1', '/new-project')).to.be.true
        expect(mockProjectRouter.addToProjectRoom.called).to.be.true
      })

      it('should return error for unknown client', () => {
        createHandlersWithClientManager()

        // getClient stub returns undefined by default (unknown client)
        const associateHandler = requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)
        const result = associateHandler!({projectPath: '/app'}, 'unknown-client')

        expect(result).to.deep.equal({error: 'Client not registered', success: false})
      })

      it('should return error when ClientManager not available', () => {
        const associateHandler = requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)
        const result = associateHandler!({projectPath: '/app'}, 'client-1')

        expect(result).to.deep.equal({error: 'ClientManager not available', success: false})
      })
    })
  })

  describe('Stress Tests', () => {
    it('should handle 50 concurrent tasks correctly', () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      const completedHandler = requestHandlers.get(TransportTaskEventNames.COMPLETED)
      registerAgentWithStatus('agent-001')

      const tasks: Array<{clientId: string; taskId: string}> = []

      // Create 50 tasks from different clients with unique taskIds
      for (let i = 0; i < 50; i++) {
        const clientId = `client-${i % 10}`
        const taskId = randomUUID()
        createHandler!({content: `Task ${i}`, taskId, type: i % 2 === 0 ? 'curate' : 'query'}, clientId)
        tasks.push({clientId, taskId})
      }

      // Complete all tasks
      for (const task of tasks) {
        completedHandler!({result: 'Done', taskId: task.taskId}, 'agent-001')
      }

      // All tasks should have received completion
      for (const task of tasks) {
        expect(
          (mockTransport.sendTo as SinonStub).calledWith(task.clientId, TransportTaskEventNames.COMPLETED, {
            result: 'Done',
            taskId: task.taskId,
          }),
        ).to.be.true
      }
    })

    it('should handle rapid create/cancel cycles', async () => {
      const createHandler = requestHandlers.get(TransportTaskEventNames.CREATE)
      const cancelHandler = requestHandlers.get(TransportTaskEventNames.CANCEL)
      registerAgentWithStatus('agent-001')

      for (let i = 0; i < 20; i++) {
        const taskId = randomUUID()
        createHandler!({content: `Rapid ${i}`, taskId, type: 'curate'}, 'client-001')
        // eslint-disable-next-line no-await-in-loop
        const cancelResult = await cancelHandler!({taskId}, 'client-001')
        expect(cancelResult).to.deep.equal({success: true})
      }
    })
  })
})
