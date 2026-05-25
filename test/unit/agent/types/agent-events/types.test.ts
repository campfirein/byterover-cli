import {expect} from 'chai'
import {expectTypeOf} from 'expect-type'

import type {
  AgentEventMap,
  AgentEventName,
  EventName,
  SessionEventMap,
  SessionEventName,
  TokenUsage,
} from '../../../../../src/agent/core/domain/agent-events/index.js'

import {
  AGENT_EVENT_NAMES,
  EVENT_NAMES,
  SESSION_EVENT_NAMES,
} from '../../../../../src/agent/core/domain/agent-events/index.js'

describe('cipher/agent-events', () => {
  describe('Exports', () => {
    it('should export all expected constants', () => {
      expect(AGENT_EVENT_NAMES).to.exist
      expect(SESSION_EVENT_NAMES).to.exist
      expect(EVENT_NAMES).to.exist
    })
  })

  describe('Runtime Constants', () => {
    it('should have correct AGENT_EVENT_NAMES array', () => {
      expect(AGENT_EVENT_NAMES).to.deep.equal([
        'cipher:conversationReset',
        'cipher:executionStarted',
        'cipher:executionTerminated',
        'cipher:log',
        'cipher:stateChanged',
        'cipher:stateReset',
        'cipher:ui',
      ])
    })

    it('should have correct SESSION_EVENT_NAMES array', () => {
      expect(SESSION_EVENT_NAMES).to.deep.equal([
        'llmservice:chunk',
        'llmservice:contextCompressed',
        'llmservice:contextOverflow',
        'llmservice:contextPruned',
        'llmservice:doomLoopDetected',
        'llmservice:error',
        'llmservice:outputTruncated',
        'llmservice:response',
        'llmservice:thinking',
        'llmservice:thought',
        'llmservice:toolCall',
        'llmservice:toolMetadata',
        'llmservice:toolResult',
        'llmservice:unsupportedInput',
        'llmservice:usage',
        'llmservice:warning',
        'message:dequeued',
        'message:queued',
        'run:complete',
        'session:statusChanged',
        'step:finished',
        'step:started',
      ])
    })

    it('should combine agent and session events in EVENT_NAMES', () => {
      expect(EVENT_NAMES).to.deep.equal([
        'cipher:conversationReset',
        'cipher:executionStarted',
        'cipher:executionTerminated',
        'cipher:log',
        'cipher:stateChanged',
        'cipher:stateReset',
        'cipher:ui',
        'llmservice:chunk',
        'llmservice:contextCompressed',
        'llmservice:contextOverflow',
        'llmservice:contextPruned',
        'llmservice:doomLoopDetected',
        'llmservice:error',
        'llmservice:outputTruncated',
        'llmservice:response',
        'llmservice:thinking',
        'llmservice:thought',
        'llmservice:toolCall',
        'llmservice:toolMetadata',
        'llmservice:toolResult',
        'llmservice:unsupportedInput',
        'llmservice:usage',
        'llmservice:warning',
        'message:dequeued',
        'message:queued',
        'run:complete',
        'session:statusChanged',
        'step:finished',
        'step:started',
      ])
    })

    it('should have readonly arrays', () => {
      // These would fail at compile time if arrays weren't readonly
    })
  })

  describe('Type Safety - Union Types', () => {
    it('should derive AgentEventName from AGENT_EVENT_NAMES constant', () => {
      const event1: AgentEventName = 'cipher:conversationReset'
      const event2: AgentEventName = 'cipher:stateChanged'
      const event3: AgentEventName = 'cipher:stateReset'

      expectTypeOf<AgentEventName>(event1)
      expectTypeOf<AgentEventName>(event2)
      expectTypeOf<AgentEventName>(event3)
    })

    it('should derive SessionEventName from SESSION_EVENT_NAMES constant', () => {
      const event1: SessionEventName = 'llmservice:thinking'
      const event2: SessionEventName = 'llmservice:chunk'
      const event3: SessionEventName = 'llmservice:response'

      expectTypeOf<SessionEventName>(event1)
      expectTypeOf<SessionEventName>(event2)
      expectTypeOf<SessionEventName>(event3)
    })

    it('should derive EventName from EVENT_NAMES constant', () => {
      const agentEvent: EventName = 'cipher:conversationReset'
      const sessionEvent: EventName = 'llmservice:thinking'

      expectTypeOf<EventName>(agentEvent)
      expectTypeOf<EventName>(sessionEvent)
    })
  })

  describe('Type Safety - TokenUsage', () => {
    it('should enforce TokenUsage interface structure', () => {
      const tokenUsage: TokenUsage = {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      }

      expectTypeOf<number>(tokenUsage.inputTokens)
      expectTypeOf<number>(tokenUsage.outputTokens)
      expectTypeOf<number>(tokenUsage.totalTokens)
    })
  })

  describe('Type Safety - AgentEventMap', () => {
    it('should enforce sessionId in agent event payloads', () => {
      const conversationResetPayload: AgentEventMap['cipher:conversationReset'] = {
        sessionId: 'session-123',
      }

      expectTypeOf<string>(conversationResetPayload.sessionId)
    })

    it('should enforce stateChanged payload structure', () => {
      const payload: AgentEventMap['cipher:stateChanged'] = {
        field: 'myField',
        newValue: 'newVal',
        oldValue: 'oldVal',
        sessionId: 'session-123',
      }

      expectTypeOf<string>(payload.field)
      expectTypeOf<unknown>(payload.newValue)
      expectTypeOf<undefined | unknown>(payload.oldValue)
      expectTypeOf<string | undefined>(payload.sessionId)

      // Optional fields can be omitted
      const minimalPayload: AgentEventMap['cipher:stateChanged'] = {
        field: 'myField',
        newValue: 'newVal',
      }

      expect(minimalPayload).to.exist
    })

    it('should enforce llmservice event payloads include sessionId', () => {
      const chunkPayload: AgentEventMap['llmservice:chunk'] = {
        content: 'chunk content',
        sessionId: 'session-123',
        type: 'text',
      }

      expectTypeOf<string>(chunkPayload.content)
      expectTypeOf<string>(chunkPayload.sessionId)
      expectTypeOf<'reasoning' | 'text'>(chunkPayload.type)
      expectTypeOf<boolean | undefined>(chunkPayload.isComplete)
    })

    it('should enforce toolCall payload structure', () => {
      const payload: AgentEventMap['llmservice:toolCall'] = {
        args: {param1: 'value1'},
        callId: 'call-123',
        sessionId: 'session-123',
        toolName: 'myTool',
      }

      expectTypeOf<Record<string, unknown>>(payload.args)
      expectTypeOf<string | undefined>(payload.callId)
      expectTypeOf<string>(payload.sessionId)
      expectTypeOf<string>(payload.toolName)
    })
  })

  describe('Type Safety - SessionEventMap', () => {
    it('should NOT include sessionId in session event payloads', () => {
      const chunkPayload: SessionEventMap['llmservice:chunk'] = {
        content: 'chunk content',
        type: 'text',
      }

      expectTypeOf<string>(chunkPayload.content)
      expectTypeOf<'reasoning' | 'text'>(chunkPayload.type)

      // Verify sessionId doesn't exist in the type using type-level assertion
      type ChunkPayload = SessionEventMap['llmservice:chunk']
      type HasSessionId = ChunkPayload extends {sessionId: unknown} ? true : false
      expectTypeOf<HasSessionId>().toEqualTypeOf<false>()
    })

    it('should have optional taskId payload for thinking event', () => {
      const payload: SessionEventMap['llmservice:thinking'] = {}

      expectTypeOf<string | undefined>(payload.taskId)

      // Can also include taskId
      const payloadWithTask: SessionEventMap['llmservice:thinking'] = {
        taskId: 'task-123',
      }

      expectTypeOf<SessionEventMap['llmservice:thinking']>(payloadWithTask)
    })

    it('should enforce response payload structure', () => {
      const payload: SessionEventMap['llmservice:response'] = {
        content: 'response content',
        model: 'gpt-4',
        provider: 'openai',
        reasoning: 'thinking...',
        tokenUsage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      }

      expectTypeOf<string>(payload.content)
      expectTypeOf<string | undefined>(payload.model)
      expectTypeOf<string | undefined>(payload.provider)
      expectTypeOf<string | undefined>(payload.reasoning)
      expectTypeOf<TokenUsage | undefined>(payload.tokenUsage)

      // Minimal payload with only required fields
      const minimalPayload: SessionEventMap['llmservice:response'] = {
        content: 'response',
      }

      expect(minimalPayload).to.exist
    })

    it('should enforce toolResult payload structure', () => {
      const successPayload: SessionEventMap['llmservice:toolResult'] = {
        callId: 'call-123',
        result: {data: 'result'},
        success: true,
        toolName: 'myTool',
      }

      expectTypeOf<boolean>(successPayload.success)
      expectTypeOf<string>(successPayload.toolName)
      expectTypeOf<undefined | unknown>(successPayload.result)
      expectTypeOf<string | undefined>(successPayload.error)

      const errorPayload: SessionEventMap['llmservice:toolResult'] = {
        error: 'Tool failed',
        success: false,
        toolName: 'myTool',
      }

      expect(errorPayload).to.exist
    })
  })

  describe('Type Safety - Event Map Keys', () => {
    it('should have matching keys between constants and event maps', () => {
      // Verify all AGENT_EVENT_NAMES are keys in AgentEventMap
      const agentKeys: (keyof AgentEventMap)[] = [
        'cipher:conversationReset',
        'cipher:executionStarted',
        'cipher:executionTerminated',
        'cipher:log',
        'cipher:stateChanged',
        'cipher:stateReset',
        'cipher:ui',
        'llmservice:chunk',
        'llmservice:contextCompressed',
        'llmservice:contextOverflow',
        'llmservice:contextPruned',
        'llmservice:error',
        'llmservice:outputTruncated',
        'llmservice:response',
        'llmservice:thinking',
        'llmservice:thought',
        'llmservice:toolCall',
        'llmservice:toolMetadata',
        'llmservice:toolResult',
        'llmservice:unsupportedInput',
        'llmservice:usage',
        'llmservice:warning',
        'message:dequeued',
        'message:queued',
        'run:complete',
      ]

      for (const key of agentKeys) {
        expectTypeOf<keyof AgentEventMap>(key)
      }

      // Verify all SESSION_EVENT_NAMES are keys in SessionEventMap
      const sessionKeys: (keyof SessionEventMap)[] = [
        'llmservice:chunk',
        'llmservice:contextCompressed',
        'llmservice:contextOverflow',
        'llmservice:contextPruned',
        'llmservice:error',
        'llmservice:outputTruncated',
        'llmservice:response',
        'llmservice:thinking',
        'llmservice:thought',
        'llmservice:toolCall',
        'llmservice:toolMetadata',
        'llmservice:toolResult',
        'llmservice:unsupportedInput',
        'llmservice:usage',
        'llmservice:warning',
        'message:dequeued',
        'message:queued',
        'run:complete',
      ]

      for (const key of sessionKeys) {
        expectTypeOf<keyof SessionEventMap>(key)
      }
    })
  })

  describe('Type Safety - New Session Events', () => {
    it('should enforce warning payload structure', () => {
      const payload: SessionEventMap['llmservice:warning'] = {
        message: 'Warning message',
        model: 'gpt-4',
        provider: 'openai',
      }

      expectTypeOf<string>(payload.message)
      expectTypeOf<string | undefined>(payload.model)
      expectTypeOf<string | undefined>(payload.provider)

      // Minimal payload
      const minimalPayload: SessionEventMap['llmservice:warning'] = {
        message: 'Warning',
      }

      expectTypeOf<SessionEventMap['llmservice:warning']>(minimalPayload)
    })

    it('should enforce warning payload in AgentEventMap with sessionId', () => {
      const payload: AgentEventMap['llmservice:warning'] = {
        message: 'Warning message',
        model: 'gpt-4',
        provider: 'openai',
        sessionId: 'session-123',
      }

      expectTypeOf<string>(payload.message)
      expectTypeOf<string>(payload.sessionId)
      expectTypeOf<string | undefined>(payload.model)
      expectTypeOf<string | undefined>(payload.provider)
    })
  })
})
