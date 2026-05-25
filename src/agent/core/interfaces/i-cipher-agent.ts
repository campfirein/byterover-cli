import type {TerminationReason} from '../domain/agent/agent-state.js'
import type {SessionMetadata} from '../domain/storage/history-types.js'
import type {GenerateResponse, StreamingEvent, StreamOptions} from '../domain/streaming/types.js'
import type {ConversationMetadata} from '../domain/system-prompt/types.js'

/**
 * Execution context for the agent
 * Contains runtime information about how the agent is being executed
 */
export interface ExecutionContext {
  /** Clear conversation history before execution (RLM mode — prevents accumulation across calls) */
  clearHistory?: boolean

  /** Command type that initiated the execution (for command-specific prompt loading) */
  commandType?: 'chat' | 'curate' | 'query'

  /** Metadata about the conversation (for JSON input mode) */
  conversationMetadata?: ConversationMetadata

  /** File reference instructions for agent to read files (for curate command with --files flag) */
  fileReferenceInstructions?: string

  /** Whether running in JSON input mode (headless with conversation history) */
  isJsonInputMode?: boolean

  /** Override maxIterations for this execution (e.g., 2 for queries with pre-fetched context) */
  maxIterations?: number

  /** Override maxTokens for this execution (e.g., 1024 for queries) */
  maxTokens?: number

  /** Override temperature for this execution (e.g., 0.3 for factual queries) */
  temperature?: number
}

/**
 * Agent execution state (string union for external consumers).
 */
export type AgentExecutionState = 'aborted' | 'complete' | 'error' | 'executing' | 'idle' | 'tool_calling'

/**
 * Agent state information.
 *
 * Enhanced to include execution state, termination reason, timing,
 * and tool metrics. Maintains backward compatibility with legacy fields.
 */
export interface AgentState {
  /** Current iteration/turn count */
  currentIteration: number

  /** Execution duration in milliseconds (if available) */
  durationMs?: number

  /** End time of execution (if complete) */
  endTime?: Date

  /** Legacy: execution history records */
  executionHistory: string[]

  /** Current execution state */
  executionState: AgentExecutionState

  /** Start time of execution (if started) */
  startTime?: Date

  /** Why the execution terminated (if complete) */
  terminationReason?: TerminationReason

  /** Number of tool calls executed */
  toolCallsExecuted: number
}

/**
 * Interface for the CipherAgent
 * Provides an agentic execution layer on top of the LLM service
 */
export interface ICipherAgent {
  /**
   * Cancels the currently running turn for the agent's default session.
   * Safe to call even if no run is in progress.
   *
   * @returns true if a run was in progress and was signaled to abort; false otherwise
   */
  cancel(): Promise<boolean>

  /**
   * Cancels a specific in-flight task by fanning the cancel across all live
   * sessions. Idempotent: a second call for the same taskId returns false
   * because the controller has already been aborted and removed.
   *
   * @param taskId - Task identifier (matches the taskId passed to run/streamRun)
   * @returns true when any session held a controller for the task; false otherwise
   */
  cancelTask(taskId: string): Promise<boolean>

  /**
   * Create a task-scoped child session for parallel execution.
   * The session gets its own sandbox, context manager, and LLM service.
   *
   * @param taskId - Unique task identifier (used as part of session ID)
   * @param commandType - Command type for agent name tracking ('curate' | 'query')
   * @param options - Optional configuration
   * @param options.mapRootEligible - If true, registers the session as root-eligible for
   *   agentic_map calls (Guard C). Only set for top-level task sessions that may invoke
   *   agentic_map directly (e.g., curate-executor, folder-pack-executor). Defaults to false.
   * @returns Session ID of the created task session
   */
  createTaskSession(taskId: string, commandType: string, options?: {mapRootEligible?: boolean; userFacing?: boolean}): Promise<string>

  /**
   * Delete a sandbox variable from the agent's default session.
   *
   * @param key - Variable name to delete
   */
  deleteSandboxVariable(key: string): void

  /**
   * Delete a sandbox variable from a specific session's sandbox.
   *
   * @param sessionId - Target session
   * @param key - Variable name to delete
   */
  deleteSandboxVariableOnSession(sessionId: string, key: string): void

  /**
   * Delete a session completely (memory + history)
   * @param sessionId - Session ID to delete
   * @returns True if session existed and was deleted
   */
  deleteSession(sessionId: string): Promise<boolean>

  /**
   * Delete a task session and all its resources (sandbox + history).
   * Use this for cleanup after per-task session execution.
   *
   * @param sessionId - Task session ID to delete
   */
  deleteTaskSession(sessionId: string): Promise<void>

  /**
   * Execute the agent with user input.
   * Uses the agent's default session (created during start()).
   *
   * @param input - User input string
   * @param options - Optional execution options
   * @param options.executionContext - Optional context for command-specific behavior (curate/query/chat)
   * @param options.taskId - Optional task ID for event routing (required for concurrent task isolation)
   * @returns Agent response
   */
  execute(
    input: string,
    options?: {executionContext?: ExecutionContext; taskId?: string},
  ): Promise<string>

  /**
   * Execute the agent on a specific session (not the default session).
   * Used for per-task session isolation in parallel execution.
   *
   * @param sessionId - Session to execute on
   * @param input - User input string
   * @param options - Optional execution options
   * @param options.executionContext - Optional context for command-specific behavior (curate/query/chat)
   * @param options.taskId - Optional task ID for event routing (required for concurrent task isolation)
   * @returns Agent response
   */
  executeOnSession(
    sessionId: string,
    input: string,
    options?: {executionContext?: ExecutionContext; signal?: AbortSignal; taskId?: string},
  ): Promise<string>

  /**
   * Generate a complete response (waits for full completion).
   * Wrapper around stream() that collects all events and returns final result.
   * Uses the agent's default session (created during start()).
   *
   * @param input - User message
   * @param options - Optional configuration (signal for cancellation, taskId for billing)
   * @returns Complete response with content, usage, and tool calls
   */
  generate(input: string, options?: StreamOptions): Promise<GenerateResponse>

  /**
   * Get session metadata without loading full history
   * @param sessionId - Session ID
   * @returns Session metadata or undefined if not found
   */
  getSessionMetadata(sessionId: string): Promise<SessionMetadata | undefined>

  /**
   * Get current agent state
   * @returns Current state information
   */
  getState(): AgentState

  /**
   * List all persisted session IDs from history storage
   * @returns Array of session IDs
   */
  listPersistedSessions(): Promise<string[]>

  /**
   * Reset the agent to initial state
   * Clears execution history and resets iteration counter
   */
  reset(): void

  /**
   * Set a variable in the agent's default session sandbox.
   * If the sandbox doesn't exist yet, the variable is buffered and injected
   * when the sandbox is created on the first code execution.
   *
   * @param key - Variable name
   * @param value - Variable value
   */
  setSandboxVariable(key: string, value: unknown): void

  /**
   * Set a variable in a specific session's sandbox.
   * Used for per-task session isolation in parallel execution.
   *
   * @param sessionId - Target session
   * @param key - Variable name
   * @param value - Variable value
   */
  setSandboxVariableOnSession(sessionId: string, key: string, value: unknown): void

  /**
   * Start the agent - initializes all services asynchronously
   * Must be called before execute()
   */
  start(): Promise<void>

  /**
   * Stream a response (yields events as they arrive).
   * This is the recommended method for real-time streaming UI updates.
   * Uses the agent's default session (created during start()).
   *
   * @param input - User message
   * @param options - Optional configuration (signal for cancellation, taskId for billing)
   * @returns AsyncIterator that yields StreamingEvent objects
   */
  stream(input: string, options?: StreamOptions): Promise<AsyncIterableIterator<StreamingEvent>>
}
