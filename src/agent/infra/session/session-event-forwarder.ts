import type {AgentEventBus, SessionEventBus} from '../events/event-emitter.js'

/**
 * Session Event Forwarder
 *
 * Automatically forwards session-level events to the agent-level event bus
 * by adding the sessionId to each event payload.
 *
 * This allows external listeners to subscribe to AgentEventBus and receive
 * all events from all sessions with proper session identification.
 *
 * Pattern mirrors Dexto's event forwarding implementation.
 *
 * @example
 * ```typescript
 * const agentBus = new AgentEventBus();
 * const sessionBus = new SessionEventBus();
 *
 * setupEventForwarding(sessionBus, agentBus, 'session-123');
 *
 * // Session event...
 * sessionBus.emit('llmservice:thinking');
 *
 * // ...is automatically forwarded to agent bus with sessionId:
 * // agentBus receives: { sessionId: 'session-123' }
 * ```
 */

/**
 * Setup event forwarding from SessionEventBus to AgentEventBus.
 *
 * Creates listeners on the session bus that automatically forward events
 * to the agent bus with sessionId added to the payload.
 *
 * @param sessionEventBus - Session-scoped event bus to listen to
 * @param agentEventBus - Agent-wide event bus to forward events to
 * @param sessionId - Unique session identifier to add to forwarded events
 */
export function setupEventForwarding(
  sessionEventBus: SessionEventBus,
  agentEventBus: AgentEventBus,
  sessionId: string,
): void {
  // Forward llmservice:thinking (may carry taskId from AgentLLMService)
  sessionEventBus.on('llmservice:thinking', (payload) => {
    agentEventBus.emit('llmservice:thinking', {
      ...(typeof payload === 'object' && payload !== null ? payload : {}),
      sessionId,
    })
  })

  // Forward llmservice:chunk
  sessionEventBus.on('llmservice:chunk', (payload) => {
    agentEventBus.emit('llmservice:chunk', {
      ...payload,
      sessionId,
    })
  })

  // Forward llmservice:response
  sessionEventBus.on('llmservice:response', (payload) => {
    agentEventBus.emit('llmservice:response', {
      ...payload,
      sessionId,
    })
  })

  // Forward llmservice:toolCall
  sessionEventBus.on('llmservice:toolCall', (payload) => {
    agentEventBus.emit('llmservice:toolCall', {
      ...payload,
      sessionId,
    })
  })

  // Forward llmservice:toolResult
  sessionEventBus.on('llmservice:toolResult', (payload) => {
    agentEventBus.emit('llmservice:toolResult', {
      ...payload,
      sessionId,
    })
  })

  // Forward llmservice:error
  sessionEventBus.on('llmservice:error', (payload) => {
    agentEventBus.emit('llmservice:error', {
      ...payload,
      sessionId,
    })
  })

  // Forward llmservice:unsupportedInput
  sessionEventBus.on('llmservice:unsupportedInput', (payload) => {
    agentEventBus.emit('llmservice:unsupportedInput', {
      ...payload,
      sessionId,
    })
  })

  // Forward llmservice:usage  — token + latency rollup per LLM call.
  // TaskUsageAggregator subscribes at the agent-process layer to roll up totals
  // onto QueryLogEntry / CurateLogEntry.
  sessionEventBus.on('llmservice:usage', (payload) => {
    agentEventBus.emit('llmservice:usage', {
      ...payload,
      sessionId,
    })
  })
}
