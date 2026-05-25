import type {Message} from '../../core/domain/session/types.js'
import type {CipherAgentServices, SessionServices} from '../../core/interfaces/cipher-services.js'
import type {IChatSession} from '../../core/interfaces/i-chat-session.js'
import type {ExecutionContext} from '../../core/interfaces/i-cipher-agent.js'
import type {ILLMService} from '../../core/interfaces/i-llm-service.js'
import type {FileData, ImageData} from '../llm/context/context-manager.js'

import {LLMError, SessionCancelledError} from '../../core/domain/errors/session-error.js'
import {SessionEventBus} from '../events/event-emitter.js'
import {MessageQueueService} from './message-queue.js'
import {sessionStatusManager} from './session-status.js'

// List of all session events that should be forwarded to agent bus.
// Mirrors the canonical SESSION_EVENT_NAMES in `agent/core/domain/agent-events/types.ts`
// (subset, with `llmservice:usage` deliberately included so token-telemetry
// emission lands on the agent bus where TaskUsageAggregator subscribes).
const SESSION_EVENT_NAMES: readonly [
  'llmservice:thinking',
  'llmservice:chunk',
  'llmservice:response',
  'llmservice:toolCall',
  'llmservice:toolResult',
  'llmservice:doomLoopDetected',
  'llmservice:error',
  'llmservice:unsupportedInput',
  'llmservice:usage',
  'message:queued',
  'message:dequeued',
  'run:complete',
  'session:statusChanged',
  'step:started',
  'step:finished',
] = [
  'llmservice:thinking',
  'llmservice:chunk',
  'llmservice:response',
  'llmservice:toolCall',
  'llmservice:toolResult',
  'llmservice:doomLoopDetected',
  'llmservice:error',
  'llmservice:unsupportedInput',
  'llmservice:usage',
  'message:queued',
  'message:dequeued',
  'run:complete',
  'session:statusChanged',
  'step:started',
  'step:finished',
]

/**
 * Chat session implementation.
 * (LLM, EventBus) and receives shared services (ToolManager, SystemPromptManager).
 *
 * The LLM service handles:
 * - Message history (via ContextManager)
 * - Agentic loop
 * - Tool execution
 *
 * This session provides:
 * - Session isolation
 * - Cancellation support
 * - Event forwarding to agent bus
 * - Proper cleanup/disposal
 */
export class ChatSession implements IChatSession {
  public readonly eventBus: SessionEventBus
  public readonly id: string
  /** Map of taskId -> AbortController for concurrent task cancellation */
  private readonly activeControllers = new Map<string, AbortController>()
  /** Fallback controller for non-task executions (interactive mode) */
  private currentController?: AbortController
  /** Fallback taskId for non-task executions - DEPRECATED: use activeControllers */
  private currentTaskId?: string
  private readonly forwarders = new Map<string, (payload?: unknown) => void>()
  private isExecuting: boolean = false
  private readonly llmService: ILLMService
  private readonly messageQueue: MessageQueueService
  private readonly sharedServices: CipherAgentServices
  /** When true, strip taskId from forwarded events (subagent mode via emitTaskId: false) */
  private suppressTaskIdForwarding: boolean = false

  /**
   * Creates a new chat session
   *
   * @param id - Unique session identifier
   * @param sharedServices - Shared services from CipherAgent
   * @param sessionServices - Session-specific services (LLM, EventBus)
   */
  public constructor(id: string, sharedServices: CipherAgentServices, sessionServices: SessionServices) {
    this.id = id
    this.sharedServices = sharedServices
    this.eventBus = sessionServices.sessionEventBus
    this.llmService = sessionServices.llmService
    this.messageQueue = new MessageQueueService(sessionServices.sessionEventBus)

    // Setup event forwarding from session bus to agent bus
    this.setupEventForwarding()
  }

  /**
   * Cancel the current operation or a specific task.
   * @param taskId - Optional taskId to cancel specific task, otherwise cancels fallback controller
   */
  public cancel(taskId?: string): void {
    if (taskId) {
      const controller = this.activeControllers.get(taskId)
      if (controller) {
        controller.abort()
        this.activeControllers.delete(taskId)
      }
    } else if (this.currentController) {
      this.currentController.abort()
    }
  }

  /**
   * Cleanup session resources but preserve history for later restoration.
   * Call this when ending a session temporarily (e.g., user navigates away).
   * History remains in ContextManager for persistence; event listeners stay for potential reactivation.
   */
  public cleanup(): void {
    // Cancel all active task controllers
    for (const controller of this.activeControllers.values()) {
      controller.abort()
    }

    this.activeControllers.clear()

    // Cancel fallback controller
    if (this.currentController) {
      this.currentController.abort()
      this.currentController = undefined
    }
    // Note: History remains in LLMService's ContextManager for persistence
    // Event listeners remain for potential reactivation
  }

  /**
   * Dispose of the session completely - remove all event listeners.
   * Call this when permanently destroying a session.
   * Removes event listeners to prevent memory leaks.
   */
  public dispose(): void {
    // First cleanup any in-flight operations
    this.cleanup()

    // Remove all event forwarders
    for (const [eventName, forwarder] of this.forwarders.entries()) {
      this.eventBus.off(eventName as keyof typeof this.eventBus, forwarder)
    }

    this.forwarders.clear()

    // Clean up session status
    sessionStatusManager.remove(this.id)
  }

  /**
   * Get the conversation history.
   */
  public getHistory(): Message[] {
    // Get history from service's context manager
    const contextManager = this.llmService.getContextManager()
    const internalMessages = contextManager.getMessages()

    // Convert to session Message format
    return internalMessages.map((msg) => ({
      content: typeof msg.content === 'string' ? msg.content : '',
      role: msg.role,
      timestamp: Date.now(), // Internal messages don't have timestamps
      toolCallId: msg.toolCallId,
      toolCalls: msg.toolCalls?.map((tc) => ({
        arguments: JSON.parse(tc.function.arguments),
        id: tc.id,
        name: tc.function.name,
      })),
      toolName: msg.name,
    }))
  }

  /**
   * Get the LLM service for direct access to context manager.
   * Useful for pre-loading conversation history in JSON input mode.
   */
  public getLLMService(): ILLMService {
    return this.llmService
  }

  /**
   * Get the number of messages in the conversation.
   */
  public getMessageCount(): number {
    const contextManager = this.llmService.getContextManager()
    return contextManager.getMessages().length
  }

  /**
   * Reset the conversation history.
   */
  public async reset(): Promise<void> {
    const contextManager = this.llmService.getContextManager()
    await contextManager.clearHistory()

    // Emit conversation reset event
    this.sharedServices.agentEventBus.emit('cipher:conversationReset', {
      sessionId: this.id,
    })
  }

  /**
   * Send a message and get a response.
   * Delegates to the LLM service which handles the agentic loop.
   * Processes any queued messages first if present.
   *
   * @param input - User message
   * @param options - Execution options
   * @param options.executionContext - Optional execution context
   * @param options.taskId - Optional task ID for billing tracking
   * @param options.emitTaskId - Whether to include taskId in emitted events (default: true)
   */
  public async run(input: string, options?: {emitTaskId?: boolean; executionContext?: ExecutionContext; taskId?: string}): Promise<string> {
    const taskId = options?.taskId
    const emitTaskId = options?.emitTaskId !== false
    const controller = new AbortController()

    // Track controller per-task for concurrent execution support
    if (taskId) {
      this.activeControllers.set(taskId, controller)
    } else {
      this.currentController = controller
    }

    // Store taskId for event forwarding only if emitTaskId is true
    this.currentTaskId = emitTaskId ? taskId : undefined
    // Suppress taskId in forwarded events for subagent sessions (prevents subagent
    // events from appearing under the parent task in the TUI)
    this.suppressTaskIdForwarding = !emitTaskId
    this.isExecuting = true
    sessionStatusManager.setBusy(this.id, this.eventBus)

    try {
      let finalInput = input
      if (!taskId) {
        const queued = this.messageQueue.dequeueAll()
        finalInput = queued ? `${queued.content}\n\nAlso: ${input}` : input
      }

      const response = await this.llmService.completeTask(finalInput, {
        executionContext: options?.executionContext,
        signal: controller.signal,
        taskId,
      })

      return response
    } catch (error) {
      if (controller.signal.aborted) {
        throw new SessionCancelledError(this.id)
      }

      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new LLMError(errorMessage, this.id)
    } finally {
      if (taskId) {
        this.activeControllers.delete(taskId)
      } else {
        this.currentController = undefined
      }

      // Clear taskId if this was the active one
      if (this.currentTaskId === taskId) {
        this.currentTaskId = undefined
      }

      // Reset suppression flag
      this.suppressTaskIdForwarding = false

      // Only mark idle if no active tasks
      if (this.activeControllers.size === 0) {
        this.isExecuting = false
        sessionStatusManager.setIdle(this.id, this.eventBus)
      }
    }
  }

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
  public async sendMessage(
    input: string,
    options?: {
      executionContext?: ExecutionContext
      fileData?: FileData
      imageData?: ImageData
    },
  ): Promise<string | {position: number; queued: true}> {
    if (this.isExecuting) {
      // Queue the message for later processing
      const position = this.messageQueue.enqueue({
        content: input,
        fileData: options?.fileData,
        imageData: options?.imageData,
      })
      return {position, queued: true}
    }

    // Execute immediately
    return this.run(input, {executionContext: options?.executionContext})
  }

  /**
   * Stream execution with real-time event emission.
   * Unlike run(), this does not return a response directly - events are yielded via the agent's stream().
   * Emits run:complete event when finished.
   *
   * @param input - User message
   * @param options - Execution options with optional signal for cancellation
   * @param options.executionContext - Optional execution context for the LLM
   * @param options.signal - Optional AbortSignal for cancellation
   * @param options.taskId - Optional task ID for concurrent task isolation
   */
  public async streamRun(
    input: string,
    options?: {
      executionContext?: ExecutionContext
      signal?: AbortSignal
      taskId?: string
    },
  ): Promise<void> {
    const startTime = Date.now()
    const taskId = options?.taskId
    const controller = new AbortController()
    let finishReason: 'cancelled' | 'error' | 'max-iterations' | 'stop' | 'timeout' = 'stop'
    let error: Error | undefined

    // Track controller per-task for concurrent execution support
    if (taskId) {
      this.activeControllers.set(taskId, controller)
    } else {
      this.currentController = controller
    }

    // Store taskId for event forwarding (last-write-wins for concurrent tasks)
    this.currentTaskId = taskId
    this.isExecuting = true
    sessionStatusManager.setBusy(this.id, this.eventBus)

    // Link external signal if provided
    if (options?.signal) {
      options.signal.addEventListener('abort', () => controller.abort(), {once: true})
    }

    try {
      let finalInput = input
      if (!taskId) {
        const queued = this.messageQueue.dequeueAll()
        finalInput = queued ? `${queued.content}\n\nAlso: ${input}` : input
      }

      await this.llmService.completeTask(finalInput, {
        executionContext: options?.executionContext,
        signal: controller.signal,
        stream: true,
        taskId,
      })
    } catch (error_) {
      if (controller.signal.aborted) {
        finishReason = 'cancelled'
      } else {
        finishReason = 'error'
        error = error_ instanceof Error ? error_ : new Error(String(error_))
      }
    } finally {
      if (taskId) {
        this.activeControllers.delete(taskId)
      } else {
        this.currentController = undefined
      }

      // Clear taskId if this was the active one
      if (this.currentTaskId === taskId) {
        this.currentTaskId = undefined
      }

      // Only mark idle if no active tasks
      if (this.activeControllers.size === 0) {
        this.isExecuting = false
        sessionStatusManager.setIdle(this.id, this.eventBus)
      }

      // Emit run:complete event with taskId
      const durationMs = Date.now() - startTime
      this.eventBus.emit('run:complete', {
        durationMs,
        error,
        finishReason,
        stepCount: 0,
        ...(taskId && {taskId}),
      })
    }
  }

  /**
   * Setup automatic event forwarding from SessionEventBus to AgentEventBus.
   * All session events are forwarded with sessionId and taskId added to the payload.
   *
   * Note: taskId is preserved from the event payload if present (for concurrent task isolation).
   * Falls back to this.currentTaskId for backward compatibility with events that don't include taskId.
   */
  private setupEventForwarding(): void {
    for (const eventName of SESSION_EVENT_NAMES) {
      const forwarder = (payload?: unknown) => {
        // Add sessionId and taskId to payload
        const basePayload = payload && typeof payload === 'object' ? (payload as object) : {}
        // When suppressTaskIdForwarding is true (subagent mode), strip taskId from
        // forwarded events so they don't appear under the parent task in the TUI
        const payloadTaskId = (basePayload as {taskId?: string}).taskId
        const effectiveTaskId = this.suppressTaskIdForwarding
          ? undefined
          : (payloadTaskId ?? this.currentTaskId)
        const payloadWithSession = {
          ...basePayload,
          sessionId: this.id,
          ...(effectiveTaskId && {taskId: effectiveTaskId}),
        }

        // Forward to agent bus - eventName is properly typed from SESSION_EVENT_NAMES
        this.sharedServices.agentEventBus.emit(eventName, payloadWithSession)
      }

      // Track forwarder for cleanup
      this.forwarders.set(eventName, forwarder)

      // Register listener on session bus - eventName is properly typed from SESSION_EVENT_NAMES
      this.eventBus.on(eventName, forwarder)
    }
  }
}
