/**
 * Agent-level event names for CipherAgent.
 * These events are emitted at the agent level and include sessionId in payloads.
 */
export const AGENT_EVENT_NAMES = [
  'cipher:conversationReset',
  'cipher:executionStarted',
  'cipher:executionTerminated',
  'cipher:log',
  'cipher:stateChanged',
  'cipher:stateReset',
  'cipher:ui',
] as const

/**
 * Session-level event names for LLM service operations.
 * These events are emitted at the session level and do not include sessionId in payloads.
 */
export const SESSION_EVENT_NAMES = [
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
] as const

/**
 * All event names (union of agent and session events).
 */
export const EVENT_NAMES = [...AGENT_EVENT_NAMES, ...SESSION_EVENT_NAMES] as const

/**
 * Union type of all agent event names.
 */
export type AgentEventName = (typeof AGENT_EVENT_NAMES)[number]

/**
 * Union type of all session event names.
 */
export type SessionEventName = (typeof SESSION_EVENT_NAMES)[number]

/**
 * Union type of all event names.
 */
export type EventName = (typeof EVENT_NAMES)[number]

/**
 * Token usage information for LLM responses.
 */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

/**
 * Log level for structured logging events.
 */
export type LogLevel = 'debug' | 'error' | 'info' | 'warn'

/**
 * UI event type for user interface actions.
 */
export type UIEventType = 'banner' | 'help' | 'prompt' | 'response' | 'separator' | 'shutdown'

/**
 * Tool error type classification.
 * Used for structured error reporting in tool execution.
 */
export type ToolErrorType =
  | 'CANCELLED'
  | 'CONFIRMATION_REJECTED'
  | 'EXECUTION_FAILED'
  | 'INTERNAL_ERROR'
  | 'INVALID_PARAM_TYPE'
  | 'INVALID_PARAMS'
  | 'MISSING_REQUIRED_PARAM'
  | 'PARAM_VALIDATION_FAILED'
  | 'PERMISSION_DENIED'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'TOOL_DISABLED'
  | 'TOOL_NOT_FOUND'

/**
 * Termination reason type for agent execution.
 * Matches TerminationReason enum values as strings.
 */
export type AgentTerminationReason = 'ABORTED' | 'ERROR' | 'GOAL' | 'MAX_TURNS' | 'PROTOCOL_VIOLATION' | 'TIMEOUT'

/**
 * Agent execution state type.
 * Matches AgentState enum values as strings.
 */
export type AgentExecutionStateType = 'ABORTED' | 'COMPLETE' | 'ERROR' | 'EXECUTING' | 'IDLE' | 'TOOL_CALLING'

/**
 * Agent-level event payloads.
 * All agent events include sessionId for tracking which session triggered the event.
 */
export interface AgentEventMap {
  /**
   * Emitted when a conversation is reset.
   * @property {string} sessionId - ID of the session being reset
   */
  'cipher:conversationReset': {
    sessionId: string
  }

  /**
   * Emitted when agent execution starts.
   * @property {number} maxIterations - Maximum iterations allowed
   * @property {number} [maxTimeMs] - Maximum execution time in milliseconds
   * @property {string} sessionId - ID of the session
   * @property {Date} startTime - When execution started
   */
  'cipher:executionStarted': {
    maxIterations: number
    maxTimeMs?: number
    sessionId: string
    startTime: Date
  }

  /**
   * Emitted when agent execution terminates.
   * @property {number} [durationMs] - Execution duration in milliseconds
   * @property {Date} endTime - When execution ended
   * @property {Error} [error] - Error if terminated due to error
   * @property {AgentTerminationReason} reason - Why execution terminated
   * @property {string} sessionId - ID of the session
   * @property {number} toolCallsExecuted - Number of tool calls made
   * @property {number} turnCount - Number of turns completed
   */
  'cipher:executionTerminated': {
    durationMs?: number
    endTime: Date
    error?: Error
    reason: AgentTerminationReason
    sessionId: string
    toolCallsExecuted: number
    turnCount: number
  }

  /**
   * Emitted for structured logging from any layer.
   * @property {Record<string, unknown>} [context] - Optional structured context data
   * @property {LogLevel} level - Log level (debug, info, warn, error)
   * @property {string} message - Human-readable log message
   * @property {string} [sessionId] - Optional session ID (if log is session-specific)
   * @property {string} [source] - Optional source identifier (e.g., class name, module)
   */
  'cipher:log': {
    context?: Record<string, unknown>
    level: LogLevel
    message: string
    sessionId?: string
    source?: string
  }

  /**
   * Emitted when agent state changes.
   * @property {string} field - Name of the state field that changed
   * @property {unknown} newValue - New value
   * @property {unknown} [oldValue] - Previous value (if applicable)
   * @property {string} [sessionId] - ID of the session (optional for global state changes)
   */
  'cipher:stateChanged': {
    field: string
    newValue: unknown
    oldValue?: unknown
    sessionId?: string
  }

  /**
   * Emitted when agent state is completely reset.
   * @property {string} [sessionId] - ID of the session (optional for global state resets)
   */
  'cipher:stateReset': {
    sessionId?: string
  }

  /**
   * Emitted for UI-related actions (banners, prompts, responses, etc.).
   * This separates UI concerns from business logic logging.
   * @property {Record<string, unknown>} [context] - Optional context (e.g., colors, formatting data)
   * @property {string} [message] - Optional human-readable message
   * @property {string} [sessionId] - Optional session ID
   * @property {UIEventType} type - Type of UI event
   */
  'cipher:ui': {
    context?: Record<string, unknown>
    message?: string
    sessionId?: string
    type: UIEventType
  }

  /**
   * Session events forwarded to agent bus with sessionId added.
   */

  /**
   * Emitted when a chunk of content is received (streaming).
   * @property {string} content - Content of the chunk
   * @property {boolean} [isComplete] - Whether this is the final chunk
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {'reasoning' | 'text'} type - Type of chunk (text or reasoning)
   */
  'llmservice:chunk': {
    content: string
    isComplete?: boolean
    sessionId: string
    taskId?: string
    type: 'reasoning' | 'text'
  }

  /**
   * Emitted when conversation context is compressed via summarization.
   * @property {number} compressedTokens - Token count after compression
   * @property {number} originalTokens - Token count before compression
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {'middle_removal' | 'oldest_removal' | 'summary'} strategy - Compression strategy used
   */
  'llmservice:contextCompressed': {
    compressedTokens: number
    originalTokens: number
    sessionId: string
    strategy: 'middle_removal' | 'oldest_removal' | 'summary'
    taskId?: string
  }

  /**
   * Emitted when context is approaching the token limit.
   * @property {number} currentTokens - Current token count
   * @property {number} maxTokens - Maximum allowed tokens
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {number} utilizationPercent - Percentage of context used (0-100)
   */
  'llmservice:contextOverflow': {
    currentTokens: number
    maxTokens: number
    sessionId: string
    taskId?: string
    utilizationPercent: number
  }

  /**
   * Emitted when old tool outputs are pruned to save context space.
   * @property {number} pruneCount - Number of tool outputs pruned
   * @property {'manual' | 'overflow'} reason - Why pruning was triggered
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {number} tokensSaved - Estimated tokens saved
   */
  'llmservice:contextPruned': {
    pruneCount: number
    reason: 'manual' | 'overflow'
    sessionId: string
    taskId?: string
    tokensSaved: number
  }

  /**
   * Emitted when a doom loop is detected (repeated identical tool calls).
   * The tool call is automatically rejected to prevent infinite loops.
   * @property {Record<string, unknown>} args - Arguments that were repeated
   * @property {'exact_repeat' | 'oscillation'} loopType - Type of loop detected
   * @property {number} repeatCount - Number of times the pattern repeated
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool involved in the loop
   */
  'llmservice:doomLoopDetected': {
    args: Record<string, unknown>
    loopType: 'exact_repeat' | 'oscillation'
    repeatCount: number
    sessionId: string
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when an error occurs during LLM service operation.
   * @property {string} [code] - Error code (optional)
   * @property {string} error - Error message
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:error': {
    code?: string
    error: string
    sessionId: string
    taskId?: string
  }

  /**
   * Emitted when tool output is truncated due to size.
   * @property {number} originalLength - Original output length before truncation
   * @property {string} savedToFile - Path to file where full output was saved
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool that produced the output
   */
  'llmservice:outputTruncated': {
    originalLength: number
    savedToFile: string
    sessionId: string
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when LLM completes a response.
   * @property {string} content - Full response content
   * @property {string} [model] - Model identifier
   * @property {boolean} [partial] - Whether this is a partial response (e.g., max iterations reached)
   * @property {string} [provider] - LLM provider name
   * @property {string} [reasoning] - Internal reasoning (if available)
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {TokenUsage} [tokenUsage] - Token usage statistics
   */
  'llmservice:response': {
    content: string
    model?: string
    partial?: boolean
    provider?: string
    reasoning?: string
    sessionId: string
    taskId?: string
    tokenUsage?: TokenUsage
  }

  /**
   * Emitted when LLM service starts thinking/processing.
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:thinking': {
    sessionId: string
    taskId?: string
  }

  /**
   * Emitted when LLM generates a thought (Gemini models only).
   * @property {string} description - Detailed thought description
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} subject - Brief thought subject
   */
  'llmservice:thought': {
    description: string
    sessionId: string
    subject: string
    taskId?: string
  }

  /**
   * Emitted when the todo list is updated via write_todos tool.
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {Array<{content: string, status: string, activeForm: string}>} todos - Updated todo list
   */
  'llmservice:todoUpdated': {
    sessionId: string
    taskId?: string
    todos: Array<{
      activeForm: string
      content: string
      status: 'cancelled' | 'completed' | 'in_progress' | 'pending'
    }>
  }

  /**
   * Emitted when LLM requests a tool call.
   * @property {Record<string, unknown>} args - Arguments for the tool
   * @property {string} [callId] - Unique identifier for this tool call
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool to execute
   */
  'llmservice:toolCall': {
    args: Record<string, unknown>
    callId?: string
    sessionId: string
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when a tool streams metadata updates during execution.
   * Allows tools to push real-time updates (e.g., bash output streaming).
   * @property {string} callId - Tool call identifier
   * @property {string} [description] - Human-readable status description
   * @property {Record<string, unknown>} metadata - The metadata update
   * @property {string} [output] - Streamed output content
   * @property {number} [progress] - Progress indicator (0-100)
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool streaming metadata
   */
  'llmservice:toolMetadata': {
    callId: string
    metadata: Record<string, unknown>
    sessionId: string
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when a tool execution completes.
   * @property {string} [callId] - Tool call identifier
   * @property {string} [error] - Error message (if failed)
   * @property {ToolErrorType} [errorType] - Classified error type (if failed)
   * @property {Record<string, unknown>} [metadata] - Execution metadata (duration, tokens, etc.)
   * @property {unknown} [result] - Tool execution result
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {boolean} success - Whether execution succeeded
   * @property {string} toolName - Name of the executed tool
   */
  'llmservice:toolResult': {
    callId?: string
    error?: string
    errorType?: ToolErrorType
    metadata?: Record<string, unknown>
    result?: unknown
    sessionId: string
    success: boolean
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when LLM receives unsupported input.
   * @property {string} reason - Reason why input is unsupported
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:unsupportedInput': {
    reason: string
    sessionId: string
    taskId?: string
  }

  /**
   * Emitted by LoggingContentGenerator after every LLM call with the per-call
   * token-usage rollup (canonical names). Consumed by `TaskUsageAggregator`
   * to roll up totals onto QueryLogEntry / CurateLogEntry.
   * @property {number} [cacheCreationTokens] - Tokens written to cache on first call
   * @property {number} [cachedInputTokens] - Tokens read from prompt cache
   * @property {number} durationMs - Wall-clock duration of the LLM call
   * @property {number} inputTokens - Tokens consumed for the prompt
   * @property {string} model - Model identifier
   * @property {number} outputTokens - Tokens emitted for the completion
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:usage': {
    cacheCreationTokens?: number
    cachedInputTokens?: number
    durationMs: number
    inputTokens: number
    model: string
    outputTokens: number
    sessionId: string
    taskId?: string
  }

  /**
   * Emitted when LLM service encounters a warning (e.g., max iterations reached).
   * @property {string} message - Warning message
   * @property {string} [model] - Model identifier
   * @property {string} [provider] - LLM provider name
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:warning': {
    message: string
    model?: string
    provider?: string
    sessionId: string
    taskId?: string
  }

  /**
   * Emitted when queued messages are dequeued for processing.
   * @property {number} count - Number of messages that were dequeued
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'message:dequeued': {
    count: number
    sessionId: string
    taskId?: string
  }

  /**
   * Emitted when a message is queued because session is busy.
   * @property {object} message - The queued message
   * @property {string} message.id - Unique identifier for the queued message
   * @property {string} message.content - Message text content
   * @property {number} message.queuedAt - Timestamp when queued
   * @property {number} position - Position in the queue (1-based)
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'message:queued': {
    message: {
      content: string
      id: string
      queuedAt: number
    }
    position: number
    sessionId: string
    taskId?: string
  }

  /**
   * Emitted when a session run completes (streaming API lifecycle event).
   * @property {number} durationMs - Execution duration in milliseconds
   * @property {Error} [error] - Error if terminated due to error
   * @property {'cancelled' | 'error' | 'max-iterations' | 'stop' | 'timeout'} finishReason - Why execution terminated
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {number} stepCount - Number of agentic steps completed
   */
  'run:complete': {
    durationMs: number
    error?: Error
    finishReason: 'cancelled' | 'error' | 'max-iterations' | 'stop' | 'timeout'
    sessionId: string
    stepCount: number
    taskId?: string
  }

  /**
   * Emitted when session status changes.
   * Tracks the lifecycle state of a session (idle, busy, retry, waiting).
   * @property {string} sessionId - ID of the session
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {SessionStatusType} status - The new session status
   */
  'session:statusChanged': {
    sessionId: string
    status: SessionStatusType
    taskId?: string
  }

  /**
   * Emitted when an execution step finishes.
   * Provides per-step cost and token tracking.
   * @property {number} cost - Cost in dollars for this step
   * @property {'max_tokens' | 'stop' | 'tool_calls'} finishReason - Why step finished
   * @property {string} sessionId - ID of the session
   * @property {number} stepIndex - Step index (0-based)
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {StepTokenUsage} tokens - Token usage for this step
   */
  'step:finished': {
    cost: number
    finishReason: 'max_tokens' | 'stop' | 'tool_calls'
    sessionId: string
    stepIndex: number
    taskId?: string
    tokens: StepTokenUsage
  }

  /**
   * Emitted when an execution step starts.
   * @property {string} sessionId - ID of the session
   * @property {number} stepIndex - Step index (0-based)
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'step:started': {
    sessionId: string
    stepIndex: number
    taskId?: string
  }
}

/**
 * Session-level event payloads.
 * These are scoped to a specific session and do not include sessionId.
 */
export interface SessionEventMap {
  /**
   * Emitted when a chunk of content is received (streaming).
   * @property {string} content - Content of the chunk
   * @property {boolean} [isComplete] - Whether this is the final chunk
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {'reasoning' | 'text'} type - Type of chunk (text or reasoning)
   */
  'llmservice:chunk': {
    content: string
    isComplete?: boolean
    taskId?: string
    type: 'reasoning' | 'text'
  }

  /**
   * Emitted when conversation context is compressed via summarization.
   * @property {number} compressedTokens - Token count after compression
   * @property {number} originalTokens - Token count before compression
   * @property {'middle_removal' | 'oldest_removal' | 'summary'} strategy - Compression strategy used
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:contextCompressed': {
    compressedTokens: number
    originalTokens: number
    strategy: 'middle_removal' | 'oldest_removal' | 'summary'
    taskId?: string
  }

  /**
   * Emitted when context is approaching the token limit.
   * @property {number} currentTokens - Current token count
   * @property {number} maxTokens - Maximum allowed tokens
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {number} utilizationPercent - Percentage of context used (0-100)
   */
  'llmservice:contextOverflow': {
    currentTokens: number
    maxTokens: number
    taskId?: string
    utilizationPercent: number
  }

  /**
   * Emitted when old tool outputs are pruned to save context space.
   * @property {number} pruneCount - Number of tool outputs pruned
   * @property {'manual' | 'overflow'} reason - Why pruning was triggered
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {number} tokensSaved - Estimated tokens saved
   */
  'llmservice:contextPruned': {
    pruneCount: number
    reason: 'manual' | 'overflow'
    taskId?: string
    tokensSaved: number
  }

  /**
   * Emitted when a doom loop is detected (repeated identical tool calls).
   * The tool call is automatically rejected to prevent infinite loops.
   * @property {Record<string, unknown>} args - Arguments that were repeated
   * @property {'exact_repeat' | 'oscillation'} loopType - Type of loop detected
   * @property {number} repeatCount - Number of times the pattern repeated
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool involved in the loop
   */
  'llmservice:doomLoopDetected': {
    args: Record<string, unknown>
    loopType: 'exact_repeat' | 'oscillation'
    repeatCount: number
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when an error occurs during LLM service operation.
   * @property {string} [code] - Error code (optional)
   * @property {string} error - Error message
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:error': {
    code?: string
    error: string
    taskId?: string
  }

  /**
   * Emitted when tool output is truncated due to size.
   * @property {number} originalLength - Original output length before truncation
   * @property {string} savedToFile - Path to file where full output was saved
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool that produced the output
   */
  'llmservice:outputTruncated': {
    originalLength: number
    savedToFile: string
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when LLM completes a response.
   * @property {string} content - Full response content
   * @property {string} [model] - Model identifier
   * @property {boolean} [partial] - Whether this is a partial response (e.g., max iterations reached)
   * @property {string} [provider] - LLM provider name
   * @property {string} [reasoning] - Internal reasoning (if available)
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {TokenUsage} [tokenUsage] - Token usage statistics
   */
  'llmservice:response': {
    content: string
    model?: string
    partial?: boolean
    provider?: string
    reasoning?: string
    taskId?: string
    tokenUsage?: TokenUsage
  }

  /**
   * Emitted when LLM service starts thinking/processing.
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:thinking': 
  void | {
    taskId?: string
  } 

  /**
   * Emitted when LLM generates a thought (Gemini models only).
   * @property {string} description - Detailed thought description
   * @property {string} subject - Brief thought subject
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:thought': {
    description: string
    subject: string
    taskId?: string
  }

  /**
   * Emitted when LLM requests a tool call.
   * @property {Record<string, unknown>} args - Arguments for the tool
   * @property {string} [callId] - Unique identifier for this tool call
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool to execute
   */
  'llmservice:toolCall': {
    args: Record<string, unknown>
    callId?: string
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when a tool streams metadata updates during execution.
   * Allows tools to push real-time updates (e.g., bash output streaming).
   * @property {string} callId - Tool call identifier
   * @property {Record<string, unknown>} metadata - The metadata update
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the tool streaming metadata
   */
  'llmservice:toolMetadata': {
    callId: string
    metadata: Record<string, unknown>
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when a tool execution completes.
   * @property {string} [callId] - Tool call identifier
   * @property {string} [error] - Error message (if failed)
   * @property {ToolErrorType} [errorType] - Classified error type (if failed)
   * @property {Record<string, unknown>} [metadata] - Execution metadata (duration, tokens, etc.)
   * @property {unknown} [result] - Tool execution result
   * @property {boolean} success - Whether execution succeeded
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {string} toolName - Name of the executed tool
   */
  'llmservice:toolResult': {
    callId?: string
    error?: string
    errorType?: ToolErrorType
    metadata?: Record<string, unknown>
    result?: unknown
    success: boolean
    taskId?: string
    toolName: string
  }

  /**
   * Emitted when LLM receives unsupported input.
   * @property {string} reason - Reason why input is unsupported
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:unsupportedInput': {
    reason: string
    taskId?: string
  }

  /**
   * Emitted by LoggingContentGenerator after every LLM call with the per-call
   * token-usage rollup (canonical names). Session-scoped (no sessionId in
   * payload — already implied by the bus). Consumed by `TaskUsageAggregator`.
   *
   * @property {number} [cacheCreationTokens] - Tokens written to cache on first call
   * @property {number} [cachedInputTokens] - Tokens read from prompt cache
   * @property {number} durationMs - Wall-clock duration of the LLM call
   * @property {number} inputTokens - Tokens consumed for the prompt
   * @property {string} model - Model identifier
   * @property {number} outputTokens - Tokens emitted for the completion
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:usage': {
    cacheCreationTokens?: number
    cachedInputTokens?: number
    durationMs: number
    inputTokens: number
    model: string
    outputTokens: number
    taskId?: string
  }

  /**
   * Emitted when LLM service encounters a warning (e.g., max iterations reached).
   * @property {string} message - Warning message
   * @property {string} [model] - Model identifier
   * @property {string} [provider] - LLM provider name
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'llmservice:warning': {
    message: string
    model?: string
    provider?: string
    taskId?: string
  }

  /**
   * Emitted when queued messages are dequeued for processing.
   * @property {number} count - Number of messages that were dequeued
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'message:dequeued': {
    count: number
    taskId?: string
  }

  /**
   * Emitted when a message is queued because session is busy.
   * @property {object} message - The queued message
   * @property {string} message.id - Unique identifier for the queued message
   * @property {string} message.content - Message text content
   * @property {number} message.queuedAt - Timestamp when queued
   * @property {number} position - Position in the queue (1-based)
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'message:queued': {
    message: {
      content: string
      id: string
      queuedAt: number
    }
    position: number
    taskId?: string
  }

  /**
   * Emitted when a session run completes (streaming API lifecycle event).
   * @property {number} durationMs - Execution duration in milliseconds
   * @property {Error} [error] - Error if terminated due to error
   * @property {'cancelled' | 'error' | 'max-iterations' | 'stop' | 'timeout'} finishReason - Why execution terminated
   * @property {number} stepCount - Number of agentic steps completed
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'run:complete': {
    durationMs: number
    error?: Error
    finishReason: 'cancelled' | 'error' | 'max-iterations' | 'stop' | 'timeout'
    stepCount: number
    taskId?: string
  }

  /**
   * Emitted when session status changes.
   * Tracks the lifecycle state of a session (idle, busy, retry, waiting).
   * @property {SessionStatusType} status - The new session status
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'session:statusChanged': {
    status: SessionStatusType
    taskId?: string
  }

  /**
   * Emitted when an execution step finishes.
   * Provides per-step cost and token tracking.
   * @property {number} cost - Cost in dollars for this step
   * @property {'max_tokens' | 'stop' | 'tool_calls'} finishReason - Why step finished
   * @property {number} stepIndex - Step index (0-based)
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   * @property {StepTokenUsage} tokens - Token usage for this step
   */
  'step:finished': {
    cost: number
    finishReason: 'max_tokens' | 'stop' | 'tool_calls'
    stepIndex: number
    taskId?: string
    tokens: StepTokenUsage
  }

  /**
   * Emitted when an execution step starts.
   * @property {number} stepIndex - Step index (0-based)
   * @property {string} [taskId] - Optional task ID for concurrent task isolation
   */
  'step:started': {
    stepIndex: number
    taskId?: string
  }
}

/**
 * Token usage for a single execution step.
 */
export interface StepTokenUsage {
  /** Cache tokens (read/write) */
  cache?: { read: number; write: number }
  /** Input tokens consumed */
  input: number
  /** Output tokens generated */
  output: number
  /** Reasoning tokens (if extended thinking enabled) */
  reasoning?: number
}

/**
 * Session status type representing lifecycle states.
 * - busy: Session is currently executing a request
 * - idle: Session is ready to accept new messages
 * - retry: Session is waiting to retry after a transient error
 * - waiting_permission: Session is waiting for user permission (e.g., tool confirmation)
 */
export type SessionStatusType =
  | { attempt: number; message: string; nextRetryAt: number; type: 'retry' }
  | { toolName: string; type: 'waiting_permission' }
  | { type: 'busy' }
  | { type: 'idle' }

/**
 * Compile-time validation: Ensure all AGENT_EVENT_NAMES are in AgentEventMap.
 */
type _AgentEventNamesInMap = (typeof AGENT_EVENT_NAMES)[number] extends keyof AgentEventMap ? true : never
const _checkAgentEventNames: _AgentEventNamesInMap = true

/**
 * Compile-time validation: Ensure all SESSION_EVENT_NAMES are in SessionEventMap.
 */
type _SessionEventNamesInMap = (typeof SESSION_EVENT_NAMES)[number] extends keyof SessionEventMap ? true : never
const _checkSessionEventNames: _SessionEventNamesInMap = true

/**
 * Prevent unused variable warnings for compile-time checks.
 */
export const __compileTimeChecks = {
  _checkAgentEventNames,
  _checkSessionEventNames,
}
