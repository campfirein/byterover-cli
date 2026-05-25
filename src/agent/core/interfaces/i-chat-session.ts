import type {Message} from '../domain/session/types.js'
import type {ExecutionContext} from './i-cipher-agent.js'
import type {ILLMService} from './i-llm-service.js'

/**
 * Interface for a chat session.
 * Represents an isolated conversation context with message history.
 */
export interface IChatSession {
  /**
   * Cancel the current operation or a specific task.
   * Aborts the abort controller scoped to the given taskId; when no taskId is
   * provided, aborts the legacy fallback controller used by interactive runs.
   *
   * @param taskId - Optional task ID to target a specific in-flight run
   * @returns true when a controller was found and aborted, false otherwise
   */
  cancel(taskId?: string): boolean

  /**
   * Cleanup session resources but preserve history for later restoration.
   * Call this when ending a session temporarily (e.g., user navigates away).
   * History remains persisted; event listeners stay for potential reactivation.
   */
  cleanup(): void

  /**
   * Dispose of the session completely and clean up all resources.
   * Removes event listeners to prevent memory leaks.
   * Should be called when session is permanently no longer needed.
   */
  dispose(): void

  /**
   * Get the conversation history.
   *
   * @returns Array of messages in chronological order
   */
  getHistory(): Message[]

  /**
   * Get the LLM service for direct access to context manager.
   * Useful for pre-loading conversation history in JSON input mode.
   *
   * @returns The LLM service instance
   */
  getLLMService(): ILLMService

  /**
   * Get the number of messages in the conversation.
   *
   * @returns Message count
   */
  getMessageCount(): number

  /** Unique session identifier */
  readonly id: string

  /**
   * Reset the conversation history.
   * Clears all messages except the system prompt (if present).
   */
  reset(): Promise<void>

  /**
   * Send a message and get a response.
   * Handles tool execution loop automatically.
   *
   * @param input - User message content
   * @param options - Optional execution options
   * @param options.executionContext - Optional execution context
   * @param options.taskId - Optional task ID for billing tracking and event correlation
   * @param options.emitTaskId - Whether to include taskId in emitted events (default: true)
   * @returns Assistant response
   * @throws SessionCancelledError if operation is cancelled
   * @throws MaxIterationsExceededError if tool loop exceeds maximum iterations
   * @throws LLMError if LLM call fails
   */
  run(
    input: string,
    options?: {
      emitTaskId?: boolean
      executionContext?: ExecutionContext
      taskId?: string
    },
  ): Promise<string>

  /**
   * Send a message, queuing if the session is busy executing.
   * If the session is idle, executes immediately via run().
   * If the session is busy, queues the message and returns the queue position.
   *
   * @param input - User message content
   * @param options - Optional execution options and attachments
   * @param options.executionContext - Optional execution context for the LLM
   * @param options.fileData - Optional file attachment
   * @param options.imageData - Optional image attachment
   * @returns Response string if executed, or queue info if queued
   */
  sendMessage(
    input: string,
    options?: {
      executionContext?: ExecutionContext
      fileData?: unknown
      imageData?: unknown
    },
  ): Promise<string | {position: number; queued: true}>

  /**
   * Stream execution with real-time event emission.
   * Unlike run(), this does not return a response directly - events are yielded via the agent's stream().
   * Emits run:complete event when finished.
   *
   * @param input - User message
   * @param options - Execution options with optional signal for cancellation
   * @param options.executionContext - Optional execution context for the LLM
   * @param options.signal - Optional AbortSignal for cancellation
   * @param options.taskId - Optional task ID for concurrent task isolation (included in all emitted events)
   */
  streamRun(
    input: string,
    options?: {
      executionContext?: ExecutionContext
      signal?: AbortSignal
      taskId?: string
    },
  ): Promise<void>
}
