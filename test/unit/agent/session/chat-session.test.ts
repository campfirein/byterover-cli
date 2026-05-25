import {expect} from 'chai'
import {createSandbox, SinonSandbox, SinonStub} from 'sinon'

import type {CipherAgentServices, SessionServices} from '../../../../src/agent/core/interfaces/cipher-services.js'
import type {ILLMService} from '../../../../src/agent/core/interfaces/i-llm-service.js'
import type {InternalMessage} from '../../../../src/agent/core/interfaces/message-types.js'

import {LLMError, SessionCancelledError} from '../../../../src/agent/core/domain/errors/session-error.js'
import {AgentEventBus, SessionEventBus} from '../../../../src/agent/infra/events/event-emitter.js'
import {ContextManager} from '../../../../src/agent/infra/llm/context/context-manager.js'
import {ChatSession} from '../../../../src/agent/infra/session/chat-session.js'
import {
  createMockCipherAgentServices,
  createMockContextManager,
  createMockLLMService,
} from '../../../helpers/mock-factories.js'

describe('ChatSession', () => {
  let sandbox: SinonSandbox
  let mockLLMService: ILLMService
  let mockContextManager: ContextManager<unknown>
  let mockSharedServices: CipherAgentServices
  let mockSessionServices: SessionServices
  let sessionEventBus: SessionEventBus
  let agentEventBus: AgentEventBus
  let session: ChatSession
  let sessionId: string

  beforeEach(() => {
    sandbox = createSandbox()
    sessionId = 'test-session-id'

    // Create real event buses for testing
    sessionEventBus = new SessionEventBus()
    agentEventBus = new AgentEventBus()

    // Use factory functions instead of `as unknown as Type`
    mockContextManager = createMockContextManager(sandbox)

    // Use factory with override for custom behavior
    mockLLMService = createMockLLMService(sandbox, {
      getContextManager: sandbox.stub().returns(mockContextManager),
    })

    // Use factory for full service mocking
    mockSharedServices = createMockCipherAgentServices(agentEventBus, sandbox)

    // Mock session services
    mockSessionServices = {
      llmService: mockLLMService,
      sessionEventBus,
    }

    session = new ChatSession(sessionId, mockSharedServices, mockSessionServices)
  })

  afterEach(() => {
    sandbox.restore()
    session.dispose()
  })

  describe('constructor', () => {
    it('should setup event forwarding for all SESSION_EVENT_NAMES', () => {
      // These are the events that ChatSession actually forwards (defined in chat-session.ts)
      const eventNames = [
        'llmservice:thinking',
        'llmservice:chunk',
        'llmservice:response',
        'llmservice:toolCall',
        'llmservice:toolResult',
        'llmservice:error',
        'llmservice:unsupportedInput',
        'message:queued',
        'message:dequeued',
      ]

      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')

      // Emit each event on session bus
      for (const eventName of eventNames) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sessionEventBus.emit(eventName as any, {test: 'data'})
      }

      // Verify all events were forwarded to agent bus with sessionId
      expect(agentEmitStub.callCount).to.equal(eventNames.length)
      for (const [index, eventName] of eventNames.entries()) {
        const call = agentEmitStub.getCall(index)
        expect(call.args[0]).to.equal(eventName)
        expect(call.args[1]).to.deep.include({sessionId})
      }
    })
  })

  describe('getHistory()', () => {
    it('should return empty array when no messages', () => {
      const history = session.getHistory()

      expect(history).to.be.an('array').that.is.empty
      expect((mockLLMService.getContextManager as SinonStub).calledOnce).to.be.true
      expect((mockContextManager.getMessages as SinonStub).calledOnce).to.be.true
    })

    it('should convert internal messages to session Message format', () => {
      const internalMessages: InternalMessage[] = [
        {
          content: 'Hello',
          role: 'user',
        },
        {
          content: 'Hi there!',
          role: 'assistant',
          toolCalls: [
            {
              function: {
                arguments: '{"key":"value"}',
                name: 'testTool',
              },
              id: 'call-123',
              type: 'function',
            },
          ],
        },
        {
          content: 'result',
          name: 'testTool',
          role: 'tool',
          toolCallId: 'call-123',
        },
      ]

      ;(mockContextManager.getMessages as SinonStub).returns(internalMessages)

      const history = session.getHistory()

      expect(history).to.have.length(3)
      expect(history[0]).to.deep.include({
        content: 'Hello',
        role: 'user',
      })
      expect(history[0]).to.have.property('timestamp')

      expect(history[1]).to.deep.include({
        content: 'Hi there!',
        role: 'assistant',
      })
      expect(history[1].toolCalls).to.deep.equal([
        {
          arguments: {key: 'value'},
          id: 'call-123',
          name: 'testTool',
        },
      ])

      expect(history[2]).to.deep.include({
        content: 'result',
        role: 'tool',
        toolCallId: 'call-123',
        toolName: 'testTool',
      })
    })

    it('should handle non-string content by converting to empty string', () => {
      const internalMessages: InternalMessage[] = [
        {
          content: null,
          role: 'assistant',
        },
      ]

      ;(mockContextManager.getMessages as SinonStub).returns(internalMessages)

      const history = session.getHistory()

      expect(history[0].content).to.equal('')
    })
  })

  describe('getMessageCount()', () => {
    it('should return 0 when no messages', () => {
      const count = session.getMessageCount()

      expect(count).to.equal(0)
      expect((mockLLMService.getContextManager as SinonStub).calledOnce).to.be.true
      expect((mockContextManager.getMessages as SinonStub).calledOnce).to.be.true
    })

    it('should return correct message count', () => {
      const internalMessages: InternalMessage[] = [
        {content: 'msg1', role: 'user'},
        {content: 'msg2', role: 'assistant'},
      ]

      ;(mockContextManager.getMessages as SinonStub).returns(internalMessages)

      const count = session.getMessageCount()

      expect(count).to.equal(2)
    })

    it('should match getHistory().length', () => {
      const internalMessages: InternalMessage[] = [
        {content: 'msg1', role: 'user'},
        {content: 'msg2', role: 'assistant'},
        {content: 'msg3', role: 'user'},
      ]

      ;(mockContextManager.getMessages as SinonStub).returns(internalMessages)

      const count = session.getMessageCount()
      const history = session.getHistory()

      expect(count).to.equal(history.length)
    })
  })

  describe('run()', () => {
    it('should return response from llmService', async () => {
      ;(mockLLMService.completeTask as SinonStub).resolves('test response')

      const result = await session.run('test input')

      expect(result).to.equal('test response')
      expect((mockLLMService.completeTask as SinonStub).calledOnce).to.be.true
      expect((mockLLMService.completeTask as SinonStub).firstCall.args[0]).to.equal('test input')
      // Second arg is options object with signal
      expect((mockLLMService.completeTask as SinonStub).firstCall.args[1].signal).to.be.instanceOf(AbortSignal)
    })

    it('should pass signal to completeTask', async () => {
      const signalSpy = sandbox.spy()
      ;(mockLLMService.completeTask as SinonStub).callsFake((_input, options) => {
        signalSpy(options?.signal)
        return Promise.resolve('response')
      })

      await session.run('input')

      expect(signalSpy.calledOnce).to.be.true
      expect(signalSpy.firstCall.args[0]).to.be.instanceOf(AbortSignal)
    })

    it('should support executionContext with commandType query', async () => {
      await session.run('input', {executionContext: {commandType: 'query'}})

      expect((mockLLMService.completeTask as SinonStub).calledOnce).to.be.true
      expect((mockLLMService.completeTask as SinonStub).firstCall.args[0]).to.equal('input')
      // Second arg is options object
      expect((mockLLMService.completeTask as SinonStub).firstCall.args[1]).to.deep.include({
        executionContext: {commandType: 'query'},
      })
      expect((mockLLMService.completeTask as SinonStub).firstCall.args[1].signal).to.be.instanceOf(AbortSignal)
    })

    it('should throw SessionCancelledError when cancelled', async () => {
      const abortController = new AbortController()
      ;(mockLLMService.completeTask as SinonStub).callsFake(async () => {
        abortController.abort()
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        throw new Error('Cancelled')
      })

      // Start run and cancel immediately
      const runPromise = session.run('input')
      session.cancel()

      try {
        await runPromise
        expect.fail('Should have thrown SessionCancelledError')
      } catch (error) {
        expect(error).to.be.instanceOf(SessionCancelledError)
        expect((error as SessionCancelledError).details?.sessionId).to.equal(sessionId)
      }
    })

    it('should throw LLMError when llmService throws error', async () => {
      const llmError = new Error('LLM service error')
      ;(mockLLMService.completeTask as SinonStub).rejects(llmError)

      try {
        await session.run('input')
        expect.fail('Should have thrown LLMError')
      } catch (error) {
        expect(error).to.be.instanceOf(LLMError)
        expect((error as LLMError).message).to.include('LLM service error')
        expect((error as LLMError).details?.sessionId).to.equal(sessionId)
      }
    })

    it('should clear currentController after completion', async () => {
      await session.run('input')

      // currentController should be undefined after completion
      // We can't directly access private property, but we can verify by running again
      // If controller wasn't cleared, second run would have issues
      await session.run('input2')

      expect((mockLLMService.completeTask as SinonStub).calledTwice).to.be.true
    })

    it('should handle error without accessing undefined controller (ENG-766)', async () => {
      // This tests the fix for ENG-766 where accessing this.currentController.signal
      // in the catch block could throw if controller was already cleared
      const error = new Error('LLM service error')
      ;(mockLLMService.completeTask as SinonStub).rejects(error)

      try {
        await session.run('input')
        expect.fail('Should have thrown LLMError')
      } catch (caughtError) {
        // Should throw LLMError, not TypeError about undefined signal
        expect(caughtError).to.be.instanceOf(LLMError)
        expect((caughtError as Error).message).to.not.include("Cannot read properties of undefined")
      }
    })

    it('should use stored controller reference to avoid race conditions (ENG-766)', async () => {
      // Simulate a case where the controller might be accessed during error handling
      let signalChecked = false
      ;(mockLLMService.completeTask as SinonStub).callsFake(async () => {
        // Simulate an error that triggers catch block
        throw new Error('Simulated error')
      })

      try {
        await session.run('input')
      } catch (error) {
        // The error should be wrapped properly without accessing undefined controller
        expect(error).to.be.instanceOf(LLMError)
        signalChecked = true
      }

      expect(signalChecked).to.be.true
    })
  })

  describe('reset()', () => {
    it('should clear history via contextManager', async () => {
      await session.reset()

      expect((mockLLMService.getContextManager as SinonStub).calledOnce).to.be.true
      expect((mockContextManager.clearHistory as SinonStub).calledOnce).to.be.true
    })

    it('should emit cipher:conversationReset event with sessionId', async () => {
      const emitStub = sandbox.stub(agentEventBus, 'emit')

      await session.reset()

      expect(emitStub.calledOnce).to.be.true
      expect(emitStub.firstCall.args[0]).to.equal('cipher:conversationReset')
      expect(emitStub.firstCall.args[1]).to.deep.equal({
        sessionId,
      })
    })
  })

  describe('streamRun()', () => {
    it('should handle error without accessing undefined controller (ENG-766)', async () => {
      // This tests the fix for ENG-766 in streamRun method
      const error = new Error('LLM service error')
      ;(mockLLMService.completeTask as SinonStub).rejects(error)

      // streamRun should not throw TypeError about undefined signal
      await session.streamRun('input')

      // The error should be captured and finishReason set to 'error'
      // We can verify this by checking the run:complete event
    })

    it('should use stored controller reference to avoid race conditions (ENG-766)', async () => {
      let completeTaskCalled = false
      ;(mockLLMService.completeTask as SinonStub).callsFake(async () => {
        completeTaskCalled = true
        throw new Error('Simulated error')
      })

      // Should not throw "Cannot read properties of undefined (reading 'signal')"
      await session.streamRun('input')

      expect(completeTaskCalled).to.be.true
    })

    it('should emit run:complete with error finishReason on LLM error', async () => {
      const error = new Error('LLM service error')
      ;(mockLLMService.completeTask as SinonStub).rejects(error)

      const runCompleteEvents: unknown[] = []
      sessionEventBus.on('run:complete', (payload) => {
        runCompleteEvents.push(payload)
      })

      await session.streamRun('input')

      expect(runCompleteEvents).to.have.length(1)
      expect(runCompleteEvents[0]).to.have.property('finishReason', 'error')
      expect(runCompleteEvents[0]).to.have.property('error')
    })

    it('should emit run:complete with cancelled finishReason when aborted', async () => {
      const controller = new AbortController()
      ;(mockLLMService.completeTask as SinonStub).callsFake(async () => {
        controller.abort()
        throw new Error('Aborted')
      })

      const runCompleteEvents: unknown[] = []
      sessionEventBus.on('run:complete', (payload) => {
        runCompleteEvents.push(payload)
      })

      const runPromise = session.streamRun('input')
      session.cancel()
      await runPromise

      expect(runCompleteEvents).to.have.length(1)
      expect(runCompleteEvents[0]).to.have.property('finishReason', 'cancelled')
    })
  })

  describe('cancel()', () => {
    it('should abort currentController when it exists', async () => {
      const abortSpy = sandbox.spy()
      ;(mockLLMService.completeTask as SinonStub).callsFake(async (_input, options) => {
        const signal = options?.signal as AbortSignal
        signal.addEventListener('abort', abortSpy)
        await new Promise((resolve) => {
          setTimeout(resolve, 10)
        })
        return 'response'
      })

      const runPromise = session.run('input')
      session.cancel()
      await runPromise.catch(() => {
        // Expected to fail
      })

      // Verify abort was called
      expect(abortSpy.called).to.be.true
    })

    it('should not throw when no currentController exists', () => {
      expect(() => session.cancel()).to.not.throw()
    })

    it('should return true when fallback controller is aborted', async () => {
      ;(mockLLMService.completeTask as SinonStub).callsFake(async (_input, options) => {
        await new Promise<void>((resolve) => {
          const signal = options?.signal as AbortSignal
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
        return 'response'
      })

      const runPromise = session.run('input')
      const result = session.cancel()
      await runPromise.catch(() => {})

      expect(result).to.equal(true)
    })

    it('should return false when no controller exists for the given taskId', () => {
      expect(session.cancel('unknown-task')).to.equal(false)
    })

    it('should return false when no fallback controller and no taskId given', () => {
      expect(session.cancel()).to.equal(false)
    })

    it('should abort only the controller matching the given taskId', async () => {
      const aborts: Record<string, boolean> = {a: false, b: false}
      ;(mockLLMService.completeTask as SinonStub).callsFake(async (_input, options) => {
        const taskId = options?.taskId as string
        const signal = options?.signal as AbortSignal
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            aborts[taskId] = true
            resolve()
          }, {once: true})
        })
        return 'response'
      })

      const runA = session.run('a', {taskId: 'a'})
      const runB = session.run('b', {taskId: 'b'})

      const result = session.cancel('a')
      await runA.catch(() => {})

      // After cancelling A, B's controller must still be present and B must still
      // be pending. Cancelling B explicitly lets the test finish.
      expect(aborts.a).to.equal(true)
      expect(aborts.b).to.equal(false)

      session.cancel('b')
      await runB.catch(() => {})

      expect(result).to.equal(true)
      expect(aborts.b).to.equal(true)
    })

    it('should be idempotent: second cancel for the same taskId returns false', async () => {
      ;(mockLLMService.completeTask as SinonStub).callsFake(async (_input, options) => {
        const signal = options?.signal as AbortSignal
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), {once: true})
        })
        return 'response'
      })

      const runPromise = session.run('input', {taskId: 'task-1'})
      const first = session.cancel('task-1')
      const second = session.cancel('task-1')
      await runPromise.catch(() => {})

      expect(first).to.equal(true)
      expect(second).to.equal(false)
    })
  })

  describe('dispose()', () => {
    it('should cleanup event forwarders', () => {
      const offStub = sandbox.stub(sessionEventBus, 'off')

      session.dispose()

      // Should call off for each event name (14 events in ChatSession's SESSION_EVENT_NAMES)
      expect(offStub.callCount).to.equal(14)
    })

    it('should clear forwarders map', () => {
      // Access private forwarders through dispose behavior
      session.dispose()

      // After dispose, emitting events should not forward (forwarders cleared)
      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessionEventBus.emit('llmservice:chunk' as any, {})

      // Should not forward after dispose
      expect(agentEmitStub.called).to.be.false
    })
  })

  describe('getLLMService()', () => {
    it('should return llmService instance', () => {
      const service = session.getLLMService()

      expect(service).to.equal(mockLLMService)
    })
  })

  describe('taskId propagation (ENG-713)', () => {
    it('should include taskId in forwarded events when provided to run()', async () => {
      const taskId = 'test-task-123'
      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')

      // Setup completeTask to trigger some events
      // LLM service now includes taskId in events it emits
      ;(mockLLMService.completeTask as SinonStub).callsFake(async (_input, options) => {
        // Emit a thinking event during execution with taskId (simulating LLM service behavior)
        sessionEventBus.emit('llmservice:thinking', {taskId: options?.taskId})
        return 'response'
      })

      await session.run('test input', {taskId})

      // Find the thinking event
      const thinkingCall = agentEmitStub.getCalls().find((call) => call.args[0] === 'llmservice:thinking')

      expect(thinkingCall).to.exist
      expect(thinkingCall!.args[1]).to.deep.include({
        sessionId,
        taskId,
      })
    })

    it('should include taskId in forwarded events when provided to streamRun()', async () => {
      const taskId = 'stream-task-456'
      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')

      // Setup completeTask to trigger some events
      // LLM service now includes taskId in events it emits
      ;(mockLLMService.completeTask as SinonStub).callsFake(async (_input, options) => {
        // Emit a toolCall event during execution with taskId (simulating LLM service behavior)
        sessionEventBus.emit('llmservice:toolCall', {
          args: {path: '/test'},
          callId: 'call-1',
          taskId: options?.taskId,
          toolName: 'read_file',
        })
        return 'response'
      })

      await session.streamRun('test input', {taskId})

      // Find the toolCall event
      const toolCallEvent = agentEmitStub.getCalls().find((call) => call.args[0] === 'llmservice:toolCall')

      expect(toolCallEvent).to.exist
      expect(toolCallEvent!.args[1]).to.deep.include({
        sessionId,
        taskId,
        toolName: 'read_file',
      })
    })

    it('should NOT include taskId in forwarded events when not provided', async () => {
      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')

      // Setup completeTask to trigger some events
      ;(mockLLMService.completeTask as SinonStub).callsFake(async () => {
        sessionEventBus.emit('llmservice:thinking')
        return 'response'
      })

      await session.run('test input') // No taskId provided

      // Find the thinking event
      const thinkingCall = agentEmitStub.getCalls().find((call) => call.args[0] === 'llmservice:thinking')

      expect(thinkingCall).to.exist
      expect(thinkingCall!.args[1]).to.have.property('sessionId', sessionId)
      expect(thinkingCall!.args[1]).to.not.have.property('taskId')
    })

    it('should clear taskId after run() completes', async () => {
      const taskId = 'transient-task-789'
      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')

      // First run with taskId
      ;(mockLLMService.completeTask as SinonStub).resolves('response')
      await session.run('first input', {taskId})

      agentEmitStub.resetHistory()

      // Second run without taskId - events should NOT have the previous taskId
      ;(mockLLMService.completeTask as SinonStub).callsFake(async () => {
        sessionEventBus.emit('llmservice:thinking')
        return 'response'
      })
      await session.run('second input') // No taskId

      const thinkingCall = agentEmitStub.getCalls().find((call) => call.args[0] === 'llmservice:thinking')

      expect(thinkingCall).to.exist
      expect(thinkingCall!.args[1]).to.not.have.property('taskId')
    })

    it('should clear taskId after streamRun() completes', async () => {
      const taskId = 'transient-stream-task-789'
      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')

      // First streamRun with taskId
      ;(mockLLMService.completeTask as SinonStub).resolves('response')
      await session.streamRun('first input', {taskId})

      agentEmitStub.resetHistory()

      // Second streamRun without taskId
      ;(mockLLMService.completeTask as SinonStub).callsFake(async () => {
        sessionEventBus.emit('llmservice:response', {content: 'response'})
        return 'response'
      })
      await session.streamRun('second input') // No taskId

      const responseCall = agentEmitStub.getCalls().find((call) => call.args[0] === 'llmservice:response')

      expect(responseCall).to.exist
      expect(responseCall!.args[1]).to.not.have.property('taskId')
    })

    it('should include taskId in all forwarded session events', async () => {
      const taskId = 'all-events-task'
      const agentEmitStub = sandbox.stub(agentEventBus, 'emit')

      // Setup completeTask to trigger multiple events
      // LLM service now includes taskId in events it emits
      ;(mockLLMService.completeTask as SinonStub).callsFake(async (_input, options) => {
        const eventTaskId = options?.taskId
        sessionEventBus.emit('llmservice:thinking', {taskId: eventTaskId})
        sessionEventBus.emit('llmservice:chunk', {content: 'test', taskId: eventTaskId, type: 'text'})
        sessionEventBus.emit('llmservice:toolCall', {
          args: {},
          callId: 'call-1',
          taskId: eventTaskId,
          toolName: 'test_tool',
        })
        sessionEventBus.emit('llmservice:toolResult', {
          callId: 'call-1',
          result: 'success',
          success: true,
          taskId: eventTaskId,
          toolName: 'test_tool',
        })
        sessionEventBus.emit('llmservice:response', {content: 'final response', taskId: eventTaskId})
        return 'response'
      })

      await session.run('test input', {taskId})

      // Check all relevant events include taskId
      const eventsToCheck = [
        'llmservice:thinking',
        'llmservice:chunk',
        'llmservice:toolCall',
        'llmservice:toolResult',
        'llmservice:response',
      ]

      for (const eventName of eventsToCheck) {
        const eventCall = agentEmitStub.getCalls().find((call) => call.args[0] === eventName)
        expect(eventCall, `Event ${eventName} should be forwarded`).to.exist
        expect(eventCall!.args[1], `Event ${eventName} should include taskId`).to.have.property('taskId', taskId)
        expect(eventCall!.args[1], `Event ${eventName} should include sessionId`).to.have.property(
          'sessionId',
          sessionId,
        )
      }
    })
  })
})
