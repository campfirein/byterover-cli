import {TransportClient} from '@campfirein/brv-transport-client'
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'

import type {IAgentPool} from '../../src/server/core/interfaces/agent/i-agent-pool.js'

import {TransportHandlers} from '../../src/server/infra/process/transport-handlers.js'
import {SocketIOTransportServer} from '../../src/server/infra/transport/socket-io-transport-server.js'

// Helper for delays
const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Integration Tests for TaskId Flow through Transport + Agent
 *
 * Tests the complete taskId lifecycle:
 * 1. Client UseCase generates taskId and sends task:create with taskId
 * 2. Transport validates taskId, sends task:execute to Agent
 * 3. Agent sends llmservice:* events with taskId
 * 4. Transport routes events to correct client based on taskId
 *
 * This simulates the real 3-process architecture without actually forking processes.
 */
describe('TaskId Integration Flow', () => {
  let server: SocketIOTransportServer
  let handlers: TransportHandlers
  let mockAgent: TransportClient
  let client: TransportClient
  const port = 9800

  before(() => {
    process.env.BRV_SESSION_LOG = '/dev/null'
  })

  after(() => {
    delete process.env.BRV_SESSION_LOG
  })

  beforeEach(async () => {
    // Start Transport server
    server = new SocketIOTransportServer()
    await server.start(port)

    // Capture mock agent's clientId from the first connection
    let agentClientId: string | undefined
    server.onConnection((clientId) => {
      if (!agentClientId) agentClientId = clientId
    })

    // Stub agentPool that forwards tasks to the mock agent via the real transport server
    const stubAgentPool: IAgentPool = {
      cancelQueuedTask() {
        return false
      },
      getEntries() {
        return []
      },
      getSize() {
        return 0
      },
      handleAgentDisconnected() {},
      hasAgent() {
        return false
      },
      markIdle() {},
      notifyTaskCompleted() {},
      async shutdown() {},
      async submitTask(task) {
        if (!agentClientId)
          return {message: 'No agent connected', reason: 'create_failed' as const, success: false as const}
        server.sendTo(agentClientId, 'task:execute', task)
        return {success: true as const}
      },
    }

    // Initialize handlers (this is what Transport process does)
    handlers = new TransportHandlers({agentPool: stubAgentPool, transport: server})
    handlers.setup() // IMPORTANT: Register all handlers

    // Connect mock Agent (first connection — captured by onConnection above)
    mockAgent = new TransportClient()
    await mockAgent.connect(`http://127.0.0.1:${port}`)

    // Register as Agent
    await mockAgent.requestWithAck('agent:register', {})

    // Broadcast agent status (required for pre-task check after Fix 5.1)
    await mockAgent.requestWithAck('agent:status:changed', {
      activeTasks: 0,
      hasAuth: true,
      hasConfig: true,
      isInitialized: true,
      queuedTasks: 0,
    })

    // Connect client (simulating TUI or CLI)
    client = new TransportClient()
    await client.connect(`http://127.0.0.1:${port}`)

    // Join broadcast room for TUI-style monitoring
    await client.joinRoom('broadcast-room')
  })

  afterEach(async () => {
    // Cleanup - handle cases where setup might have failed
    if (client?.getState() === 'connected') {
      await client.disconnect()
    }

    if (mockAgent?.getState() === 'connected') {
      await mockAgent.disconnect()
    }

    if (server?.isRunning()) {
      handlers?.cleanup()
      await server.stop()
    }
  })

  describe('TaskId generation and propagation', () => {
    it('should accept client-generated taskId and include it in task:execute to Agent', async () => {
      // Track what Agent receives
      let receivedTaskExecute: undefined | {content: string; taskId: string; type: string}

      mockAgent.on('task:execute', (data: unknown) => {
        receivedTaskExecute = data as {content: string; taskId: string; type: string}
      })

      // Client generates taskId and creates task
      const taskId = randomUUID()
      const response = await client.requestWithAck<{taskId: string}>('task:create', {
        content: 'Test content',
        taskId,
        type: 'curate',
      })

      // Wait for Agent to receive
      await delay(5)

      // Verify Transport accepted client's taskId
      expect(response.taskId).to.equal(taskId)

      // Verify Agent received same taskId
      expect(receivedTaskExecute).to.not.be.undefined
      expect(receivedTaskExecute!.taskId).to.equal(taskId)
      expect(receivedTaskExecute!.type).to.equal('curate')
      expect(receivedTaskExecute!.content).to.equal('Test content')
    })

    it('should route Agent events back to client using taskId', async () => {
      // Create a NEW client NOT in broadcast-room to test direct routing only
      const directClient = new TransportClient()
      await directClient.connect(`http://127.0.0.1:${port}`)
      // NOTE: NOT joining broadcast-room - testing direct routing only

      // Collect events received by client (deduplicated by event type for this test)
      const clientEvents: Array<{event: string; taskId?: string}> = []

      directClient.on('llmservice:thinking', (data: unknown) => {
        const d = data as {taskId?: string}
        clientEvents.push({event: 'thinking', taskId: d.taskId})
      })
      directClient.on('llmservice:chunk', (data: unknown) => {
        const d = data as {taskId?: string}
        clientEvents.push({event: 'chunk', taskId: d.taskId})
      })
      directClient.on('llmservice:response', (data: unknown) => {
        const d = data as {taskId?: string}
        clientEvents.push({event: 'response', taskId: d.taskId})
      })
      directClient.on('task:completed', (data: unknown) => {
        const d = data as {taskId?: string}
        clientEvents.push({event: 'completed', taskId: d.taskId})
      })

      // Create task with client-generated taskId
      const taskId = randomUUID()
      await directClient.requestWithAck<{taskId: string}>('task:create', {
        content: 'Test',
        taskId,
        type: 'query',
      })

      // Wait for task:execute to reach Agent
      await delay(5)

      // Simulate Agent sending events (as it would in real flow)
      await mockAgent.requestWithAck('llmservice:thinking', {sessionId: 'sess-1', taskId})
      await mockAgent.requestWithAck('llmservice:chunk', {
        content: 'Processing...',
        isComplete: false,
        sessionId: 'sess-1',
        taskId,
        type: 'text',
      })
      await mockAgent.requestWithAck('llmservice:response', {
        content: 'Done!',
        sessionId: 'sess-1',
        taskId,
      })
      await mockAgent.requestWithAck('task:completed', {result: 'Success', taskId})

      // Wait for events to propagate
      await delay(5)

      // Verify client received all events with correct taskId (direct routing only)
      expect(clientEvents).to.have.length(4)
      expect(clientEvents.every((e) => e.taskId === taskId)).to.be.true
      expect(clientEvents.map((e) => e.event)).to.deep.equal(['thinking', 'chunk', 'response', 'completed'])

      await directClient.disconnect()
    })

    it('should isolate events between concurrent tasks', async () => {
      // Create second client
      const client2 = new TransportClient()
      await client2.connect(`http://127.0.0.1:${port}`)
      await client2.joinRoom('broadcast-room')

      // Track events per client
      const client1Events: Array<{content: string; taskId: string}> = []
      const client2Events: Array<{content: string; taskId: string}> = []

      client.on('llmservice:chunk', (data: unknown) => {
        const d = data as {content: string; taskId: string}
        client1Events.push({content: d.content, taskId: d.taskId})
      })
      client2.on('llmservice:chunk', (data: unknown) => {
        const d = data as {content: string; taskId: string}
        client2Events.push({content: d.content, taskId: d.taskId})
      })

      // Create two tasks from different clients with client-generated taskIds
      const taskId1 = randomUUID()
      const taskId2 = randomUUID()
      await client.requestWithAck<{taskId: string}>('task:create', {
        content: 'Task 1',
        taskId: taskId1,
        type: 'curate',
      })
      await client2.requestWithAck<{taskId: string}>('task:create', {
        content: 'Task 2',
        taskId: taskId2,
        type: 'curate',
      })

      await delay(5)

      // Simulate Agent sending interleaved events for both tasks
      await mockAgent.requestWithAck('llmservice:chunk', {
        content: 'Task1-msg1',
        sessionId: 's1',
        taskId: taskId1,
        type: 'text',
      })
      await mockAgent.requestWithAck('llmservice:chunk', {
        content: 'Task2-msg1',
        sessionId: 's2',
        taskId: taskId2,
        type: 'text',
      })
      await mockAgent.requestWithAck('llmservice:chunk', {
        content: 'Task1-msg2',
        sessionId: 's1',
        taskId: taskId1,
        type: 'text',
      })
      await mockAgent.requestWithAck('llmservice:chunk', {
        content: 'Task2-msg2',
        sessionId: 's2',
        taskId: taskId2,
        type: 'text',
      })

      await delay(5)

      // Both clients receive ALL events (via broadcast-room)
      // But events have correct taskId for filtering
      const allEvents = [...client1Events, ...client2Events]

      // Filter by taskId (as TUI would do)
      const task1EventsFiltered = allEvents.filter((e) => e.taskId === taskId1)
      const task2EventsFiltered = allEvents.filter((e) => e.taskId === taskId2)

      expect(task1EventsFiltered.map((e) => e.content)).to.include.members(['Task1-msg1', 'Task1-msg2'])
      expect(task2EventsFiltered.map((e) => e.content)).to.include.members(['Task2-msg1', 'Task2-msg2'])

      // No crosstalk - task1 events should not have Task2 content and vice versa
      expect(task1EventsFiltered.every((e) => e.content.startsWith('Task1'))).to.be.true
      expect(task2EventsFiltered.every((e) => e.content.startsWith('Task2'))).to.be.true

      await client2.disconnect()
    })

    it('should handle task cancellation with taskId', async () => {
      // Create a client NOT in broadcast-room for cleaner testing
      const cancelClient = new TransportClient()
      await cancelClient.connect(`http://127.0.0.1:${port}`)

      let cancelledTaskId: string | undefined

      cancelClient.on('task:cancelled', (data: unknown) => {
        cancelledTaskId = (data as {taskId: string}).taskId
      })

      // Mock Agent responds to task:cancel by emitting task:cancelled
      const handleCancelRequest = (data: unknown): void => {
        const d = data as {taskId: string}
        // Simulate Agent confirming cancellation (fire and forget)
        mockAgent.requestWithAck('task:cancelled', {taskId: d.taskId}).catch(() => {})
      }

      mockAgent.on('task:cancel', handleCancelRequest)

      // Create and immediately cancel a task with client-generated taskId
      const taskId = randomUUID()
      await cancelClient.requestWithAck<{taskId: string}>('task:create', {
        content: 'Cancel me',
        taskId,
        type: 'curate',
      })

      await delay(5)

      // Cancel the task
      await cancelClient.requestWithAck('task:cancel', {taskId})

      await delay(5)

      // Verify cancellation event was received with correct taskId
      expect(cancelledTaskId).to.equal(taskId)

      await cancelClient.disconnect()
    })

    it('should handle task error with taskId', async () => {
      let errorEvent: undefined | {error: {message: string}; taskId: string}

      client.on('task:error', (data: unknown) => {
        const d = data as {error: {message: string}; taskId: string}
        errorEvent = {error: d.error, taskId: d.taskId}
      })

      // Create task with client-generated taskId
      const taskId = randomUUID()
      await client.requestWithAck<{taskId: string}>('task:create', {
        content: 'Error task',
        taskId,
        type: 'query',
      })

      await delay(5)

      // Simulate Agent sending error
      await mockAgent.requestWithAck('task:error', {
        error: {message: 'Something went wrong', name: 'TestError'},
        taskId,
      })

      await delay(5)

      expect(errorEvent).to.not.be.undefined
      expect(errorEvent!.taskId).to.equal(taskId)
      expect(errorEvent!.error.message).to.equal('Something went wrong')
    })
  })

  describe('Concurrent tasks: 3 curate + 2 query', () => {
    it('should handle concurrent curate and query tasks with correct taskId isolation', async () => {
      // Create a client NOT in broadcast-room for cleaner testing
      const stressClient = new TransportClient()
      await stressClient.connect(`http://127.0.0.1:${port}`)

      const curateTasks: Array<{taskId: string; type: 'curate'}> = []
      const queryTasks: Array<{taskId: string; type: 'query'}> = []
      const eventsByTask = new Map<string, string[]>()

      // Collect all events
      stressClient.on('llmservice:chunk', (data: unknown) => {
        const d = data as {content: string; taskId: string}
        if (!eventsByTask.has(d.taskId)) {
          eventsByTask.set(d.taskId, [])
        }

        eventsByTask.get(d.taskId)!.push(d.content)
      })

      // Create 3 curate tasks with client-generated taskIds
      for (let i = 0; i < 3; i++) {
        const taskId = randomUUID()
        // eslint-disable-next-line no-await-in-loop
        await stressClient.requestWithAck<{taskId: string}>('task:create', {
          content: `Curate ${i}`,
          taskId,
          type: 'curate',
        })
        curateTasks.push({taskId, type: 'curate'})
      }

      // Create 2 query tasks with client-generated taskIds
      for (let i = 0; i < 2; i++) {
        const taskId = randomUUID()
        // eslint-disable-next-line no-await-in-loop
        await stressClient.requestWithAck<{taskId: string}>('task:create', {
          content: `Query ${i}`,
          taskId,
          type: 'query',
        })
        queryTasks.push({taskId, type: 'query'})
      }

      await delay(5)

      const allTasks = [...curateTasks, ...queryTasks]

      // Simulate Agent sending 2 events for each task
      for (let round = 0; round < 2; round++) {
        for (const task of allTasks) {
          // eslint-disable-next-line no-await-in-loop
          await mockAgent.requestWithAck('llmservice:chunk', {
            content: `${task.type}-${task.taskId.slice(0, 8)}-r${round}`,
            sessionId: `s-${task.taskId.slice(0, 8)}`,
            taskId: task.taskId,
            type: 'text',
          })
        }
      }

      await delay(5)

      // Verify each task received exactly 2 events
      for (const task of allTasks) {
        const events = eventsByTask.get(task.taskId) || []
        expect(events, `${task.type} task ${task.taskId.slice(0, 8)} should have 2 events`).to.have.length(2)

        // All events should belong to this task and have correct type prefix
        for (const event of events) {
          expect(event).to.include(task.taskId.slice(0, 8))
          expect(event).to.include(task.type)
        }
      }

      await stressClient.disconnect()
    })
  })
})
