import type {MessageParam} from '@anthropic-ai/sdk/resources/messages'
import type {Content} from '@google/genai'
import type {ChatCompletionMessageParam} from 'openai/resources/chat/completions'

import type {ToolExecutionResult} from '../../core/domain/tools/tool-error.js'
import type {ToolSet} from '../../core/domain/tools/types.js'
import type {ExecutionContext} from '../../core/interfaces/i-cipher-agent.js'
import type {IHistoryStorage} from '../../core/interfaces/i-history-storage.js'
import type {ILLMService} from '../../core/interfaces/i-llm-service.js'
import type {ILogger} from '../../core/interfaces/i-logger.js'
import type {IMessageFormatter} from '../../core/interfaces/i-message-formatter.js'
import type {ISandboxService} from '../../core/interfaces/i-sandbox-service.js'
import type {ITokenizer} from '../../core/interfaces/i-tokenizer.js'
import type {
  InternalMessage,
  ToolCall,
  ToolStateCompleted,
  ToolStateError,
  ToolStateRunning,
} from '../../core/interfaces/message-types.js'
import type {MemoryManager} from '../memory/memory-manager.js'
import type {SystemPromptManager} from '../system-prompt/system-prompt-manager.js'
import type {ToolManager} from '../tools/tool-manager.js'
import type {CompactionService} from './context/compaction/compaction-service.js'
import type {ICompressionStrategy} from './context/compression/types.js'

import {AGENT_LLM_ITERATION_BUDGET_MS} from '../../../server/constants.js'
import {getErrorMessage} from '../../../server/utils/error-helpers.js'
import {AgentStateMachine} from '../../core/domain/agent/agent-state-machine.js'
import {AgentState, TerminationReason} from '../../core/domain/agent/agent-state.js'
import {LlmGenerationError, LlmMaxIterationsError, LlmResponseParsingError} from '../../core/domain/errors/llm-error.js'
import {
  getEffectiveMaxInputTokens,
  getMaxInputTokensForModel,
  isValidProviderModel,
  resolveRegistryProvider,
  safeParseLLMConfig,
} from '../../core/domain/llm/index.js'
import {
  type GenerateContentRequest,
  type IContentGenerator,
  StreamChunkType,
} from '../../core/interfaces/i-content-generator.js'
import {NoOpLogger} from '../../core/interfaces/i-logger.js'
import {EnvironmentContextBuilder} from '../environment/environment-context-builder.js'
import {SessionEventBus} from '../events/event-emitter.js'
import {ToolMetadataHandler} from '../tools/streaming/metadata-handler.js'
import {AsyncMutex} from './context/async-mutex.js'
import {ContextManager, type FileData, type ImageData} from './context/context-manager.js'
import {DeferredEffects} from './context/deferred-effects.js'
import {LoopDetector} from './context/loop-detector.js'
import {ClaudeMessageFormatter} from './formatters/claude-formatter.js'
import {GeminiMessageFormatter} from './formatters/gemini-formatter.js'
import {OpenRouterMessageFormatter} from './formatters/openrouter-formatter.js'
import {type ThinkingConfig, ThoughtParser} from './thought-parser.js'
import {ClaudeTokenizer} from './tokenizers/claude-tokenizer.js'
import {GeminiTokenizer} from './tokenizers/gemini-tokenizer.js'
import {OpenRouterTokenizer} from './tokenizers/openrouter-tokenizer.js'
import {type ProcessedOutput, ToolOutputProcessor, type TruncationConfig} from './tool-output-processor.js'

/** Target utilization ratio for message tokens (leaves headroom for response) */
const TARGET_MESSAGE_TOKEN_UTILIZATION = 0.7

/**
 * Build a `<dateTime>...</dateTime>\n\n` prefix for a user-message body.
 *
 * Per-call timestamps must NOT enter the system prompt (they would poison
 * the prefix cache). They are injected into the user message instead, at
 * the boundaries where the model legitimately needs fresh time context:
 * the iter-0 input, and after a rolling-checkpoint history clear.
 */
export function buildDateTimePrefix(now: Date = new Date()): string {
  return `<dateTime>Current date and time: ${now.toISOString()}</dateTime>\n\n`
}

/**
 * Result of parallel tool execution (before adding to context).
 * Contains all information needed to add the result to context in order.
 */
interface ParallelToolResult {
  /** If set, signals early exit — the agentic loop should terminate with this value */
  earlyExitResult?: string
  /** Error message if tool execution failed */
  error?: string
  /** Original tool call for reference */
  toolCall: ToolCall
  /** Tool result data (only present if success) */
  toolResult?: {
    errorType?: string
    metadata: Record<string, unknown>
    processedOutput: ProcessedOutput
    success: boolean
  }
}

/**
 * Configuration for ByteRover LLM service
 */
export interface AgentLLMServiceConfig {
  maxInputTokens?: number
  maxIterations?: number
  maxTokens?: number
  model: string
  /**
   * Explicit provider ID for formatter/tokenizer selection.
   * When set, overrides the model-name-based heuristic detection.
   * Used for direct provider connections (anthropic, openai, google, xai, groq, mistral).
   */
  provider?: string
  temperature?: number
  /**
   * Thinking configuration for Gemini models (optional).
   * If not provided, will be auto-configured based on model version.
   */
  thinkingConfig?: ThinkingConfig
  timeout?: number
  /**
   * Truncation configuration for tool outputs (optional).
   * If not provided, will use default truncation settings.
   */
  truncationConfig?: TruncationConfig
  verbose?: boolean
}

/**
 * LLM service configuration response
 */
export interface LLMServiceConfig {
  configuredMaxInputTokens: number
  model: string
  modelMaxInputTokens: number
  provider: string
  router: string
}

/**
 * Options for building generation request
 */
interface BuildGenerateContentRequestOptions {
  executionContext?: ExecutionContext
  systemPrompt: string
  taskId?: string
  tools: ToolSet
}

/**
 * ByteRover LLM Service.
 *
 * Orchestrates the agentic loop using IContentGenerator for LLM calls.
 * Responsibilities:
 * - Manage conversation context via ContextManager
 * - Execute agentic loop (call LLM → execute tools → repeat)
 * - Delegate tool execution to ToolManager
 * - Delegate LLM calls to IContentGenerator
 * - Handle errors and iteration limits
 *
 * Does NOT:
 * - Execute tools directly (uses ToolManager)
 * - Store persistent history (uses in-memory ContextManager)
 * - Format messages for specific providers (handled by generators)
 * - Handle retry logic (handled by RetryableContentGenerator decorator)
 */
export class AgentLLMService implements ILLMService {
  /** Cached base system prompt (everything built by SystemPromptManager) for reuse across iterations */
  private cachedBasePrompt: null | string = null
  private readonly compactionService?: CompactionService
  private readonly config: {
    maxInputTokens: number
    maxIterations: number
    maxTokens: number
    model: string
    temperature: number
    thinkingConfig?: ThinkingConfig
    timeout?: number
    verbose: boolean
  }
  private readonly contextManager: ContextManager<Content | MessageParam>
  private readonly environmentBuilder: EnvironmentContextBuilder
  private readonly formatter: IMessageFormatter<ChatCompletionMessageParam | Content | MessageParam>
  private readonly generator: IContentGenerator
  private readonly logger: ILogger
  private readonly loopDetector: LoopDetector
  /** Flag indicating memory was modified by tools during this task, requiring prompt rebuild */
  private memoryDirtyFlag = false
  private readonly memoryManager?: MemoryManager
  private readonly metadataHandler: ToolMetadataHandler
  private readonly mutex = new AsyncMutex()
  private readonly outputProcessor: ToolOutputProcessor
  private readonly providerId: string
  private readonly providerType: 'claude' | 'gemini' | 'openai'
  /** Optional sandbox service for rolling checkpoint variable injection (Pattern 1) */
  private readonly sandboxService?: ISandboxService
  private readonly sessionEventBus: SessionEventBus
  private readonly sessionId: string
  private readonly systemPromptManager: SystemPromptManager
  private readonly tokenizer: ITokenizer
  private readonly toolManager: ToolManager
  private readonly workingDirectory: string

  /**
   * Initialize a new ByteRover LLM service instance.
   *
   * Sets up the service with all required dependencies and initializes:
   * - Context manager for conversation history
   * - Message formatter (Gemini or Claude format based on model)
   * - Token counter/tokenizer for the selected model
   * - Configuration with sensible defaults
   *
   * Each service instance maintains isolated conversation context,
   * allowing multiple concurrent sessions with separate histories.
   *
   * @param sessionId - Unique identifier for this session
   * @param generator - Content generator for LLM calls (with decorators pre-applied)
   * @param config - LLM service configuration (model, tokens, temperature)
   * @param options - Service dependencies
   * @param options.toolManager - Tool manager for executing agent tools
   * @param options.systemPromptManager - System prompt manager for building system prompts
   * @param options.memoryManager - Memory manager for agent memories
   * @param options.sessionEventBus - Event bus for session lifecycle events
   * @param options.compactionService - Optional compaction service for context overflow management
   * @param options.historyStorage - Optional history storage for persistence
   * @param options.logger - Optional logger for structured logging
   * @param options.sandboxService - Optional sandbox service for rolling checkpoint variable injection
   */
  public constructor(
    sessionId: string,
    generator: IContentGenerator,
    config: AgentLLMServiceConfig,
    options: {
      compactionService?: CompactionService
      /** Optional compression strategies for context overflow management */
      compressionStrategies?: ICompressionStrategy[]
      historyStorage?: IHistoryStorage
      logger?: ILogger
      memoryManager?: MemoryManager
      /** Optional sandbox service for rolling checkpoint variable injection */
      sandboxService?: ISandboxService
      sessionEventBus: SessionEventBus
      systemPromptManager: SystemPromptManager
      toolManager: ToolManager
    },
  ) {
    this.sessionId = sessionId
    this.generator = generator
    this.compactionService = options.compactionService
    this.sandboxService = options.sandboxService
    this.toolManager = options.toolManager
    this.systemPromptManager = options.systemPromptManager
    this.memoryManager = options.memoryManager
    this.sessionEventBus = options.sessionEventBus
    this.logger = options.logger ?? new NoOpLogger()
    this.loopDetector = new LoopDetector()
    this.environmentBuilder = new EnvironmentContextBuilder()
    this.metadataHandler = new ToolMetadataHandler(this.sessionEventBus)
    this.workingDirectory = process.cwd()
    // Detect provider type: explicit provider config takes priority over model name heuristic
    const modelName = config.model ?? 'claude-haiku-4-5@20251001'
    this.providerId = config.provider ?? 'byterover'
    this.providerType = this.detectProviderType(modelName, config.provider)

    // Validate core LLM config using Zod schema (logs warning if invalid)
    this.validateConfig(modelName, config.maxInputTokens)

    // Get effective max input tokens from registry (respects model limits)
    // For 'openai' provider type, use 'openai' registry; for others use existing logic
    const registryProvider = this.providerType === 'openai' ? 'openai' : this.providerType
    const effectiveMaxInputTokens = getEffectiveMaxInputTokens(registryProvider, modelName, config.maxInputTokens)

    this.config = {
      maxInputTokens: effectiveMaxInputTokens,
      maxIterations: config.maxIterations ?? 50,
      maxTokens: config.maxTokens ?? 8192,
      model: modelName,
      temperature: config.temperature ?? 0.7,
      thinkingConfig: config.thinkingConfig,
      timeout: config.timeout,
      verbose: config.verbose ?? false,
    }

    // Initialize output processor after config so maxInputTokens is available
    this.outputProcessor = new ToolOutputProcessor(this.config.maxInputTokens, config.truncationConfig)

    // Initialize formatter and tokenizer based on provider type
    if (this.providerType === 'openai') {
      this.formatter = new OpenRouterMessageFormatter()
      this.tokenizer = new OpenRouterTokenizer()
    } else if (this.providerType === 'claude') {
      this.formatter = new ClaudeMessageFormatter()
      this.tokenizer = new ClaudeTokenizer(this.config.model)
    } else {
      this.formatter = new GeminiMessageFormatter()
      this.tokenizer = new GeminiTokenizer(this.config.model)
    }

    // Initialize context manager with optional history storage
    this.contextManager = new ContextManager({
      compressionStrategies: options.compressionStrategies,
      formatter: this.formatter,
      historyStorage: options.historyStorage,
      maxInputTokens: this.config.maxInputTokens,
      sessionId,
      tokenizer: this.tokenizer,
    })
  }

  /**
   * Complete a task with tool calling support.
   *
   * This is the main entry point for the agentic loop.
   * It handles:
   * 1. Adding user message to context
   * 2. Looping: call LLM → check for tool calls → execute tools
   * 3. Returning final response when no more tool calls
   *
   * @param textInput - User input text
   * @param options - Execution options
   * @param options.executionContext - Optional execution context
   * @param options.signal - Optional abort signal for cancellation
   * @param options.imageData - Optional image data
   * @param options.fileData - Optional file data
   * @param options.stream - Whether to stream response (not implemented yet)
   * @param options.taskId - Task ID from usecase for billing tracking
   * @returns Final assistant response
   */
  public async completeTask(
    textInput: string,
    options?: {
      executionContext?: ExecutionContext
      fileData?: FileData
      imageData?: ImageData
      signal?: AbortSignal
      stream?: boolean
      taskId?: string
    },
  ): Promise<string> {
    // Reset per-task prompt cache (each task gets a fresh prompt on its first iteration)
    this.cachedBasePrompt = null
    this.memoryDirtyFlag = false

    // Extract options with defaults
    const {executionContext, fileData, imageData, signal, stream, taskId} = options ?? {}

    // RLM mode: Clear conversation history to prevent accumulation across calls.
    // Context and history are offloaded to files, accessed via code_exec instead.
    if (executionContext?.clearHistory) {
      await this.contextManager.clearHistory()
    }

    // Get filtered tools based on command type (e.g., only read-only tools for 'query')
    const toolSet = this.toolManager.getToolsForCommand(options?.executionContext?.commandType)

    // Create state machine with configured limits (per-invocation overrides via ExecutionContext)
    const effectiveMaxIterations = executionContext?.maxIterations ?? this.config.maxIterations
    const maxTimeMs = this.config.timeout ?? AGENT_LLM_ITERATION_BUDGET_MS
    const stateMachine = new AgentStateMachine(effectiveMaxIterations, maxTimeMs)
    stateMachine.transition(AgentState.EXECUTING)

    // Agentic loop with state machine
    while (!stateMachine.isTerminal()) {
      // Check termination conditions (timeout, max turns)
      const terminationReason = stateMachine.shouldTerminate()
      if (terminationReason) {
        return this.handleTermination(terminationReason, stateMachine, taskId)
      }

      // Check if aborted via signal
      if (signal?.aborted) {
        stateMachine.abort()
        throw new Error('Operation aborted')
      }

      try {
        // eslint-disable-next-line no-await-in-loop -- Sequential iterations required for agentic loop
        const result = await this.executeAgenticIteration({
          effectiveMaxIterations,
          executionContext,
          fileData,
          imageData,
          iterationCount: stateMachine.getContext().turnCount,
          stream,
          taskId,
          textInput,
          tools: toolSet,
        })

        if (result !== null) {
          // Task complete - no tool calls
          stateMachine.complete()
          return result
        }

        // Tool calls were executed, continue loop
        stateMachine.incrementTurn()
      } catch (error) {
        stateMachine.fail(error as Error)
        this.handleLLMError(error, taskId)
      }
    }

    // Should not reach here - state machine should exit via terminal states
    throw new Error('Agent loop terminated unexpectedly')
  }

  /**
   * Get all available tools for the agent.
   *
   * Retrieves the current set of tools that can be used during task execution.
   * These tools are passed to the LLM to enable function calling capabilities.
   *
   * @returns Promise resolving to a map of tool names to their schemas
   */
  public async getAllTools(): Promise<ToolSet> {
    return this.toolManager.getAllTools()
  }

  /**
   * Get the service's runtime configuration.
   *
   * Returns metadata about the service including:
   * - Configured and model-specific token limits
   * - Selected LLM model
   * - Provider identity (e.g. 'byterover', 'anthropic', 'openrouter')
   * - Router type (always 'in-built')
   *
   * This is useful for introspecting service capabilities and limits
   * without needing access to the internal config object.
   *
   * @returns Service configuration object with model info and constraints
   */
  public getConfig(): LLMServiceConfig {
    // Get model's actual max tokens from registry
    const modelMaxTokens = getMaxInputTokensForModel(this.providerType, this.config.model)

    return {
      configuredMaxInputTokens: this.config.maxInputTokens,
      model: this.config.model,
      modelMaxInputTokens: modelMaxTokens,
      provider: this.providerId,
      router: 'in-built',
    }
  }

  /**
   * Get access to the conversation context manager.
   *
   * Provides access to the ContextManager instance that maintains:
   * - Conversation history (messages and responses)
   * - Token counting and compression
   * - Message formatting for the selected model
   *
   * Useful for:
   * - Inspecting conversation state
   * - Retrieving formatted messages
   * - Managing context during multi-turn interactions
   *
   * @returns The ContextManager instance managing conversation state
   */
  public getContextManager(): ContextManager<unknown> {
    return this.contextManager
  }

  /**
   * Initialize the LLM service by loading persisted history.
   * Should be called after construction to restore previous conversation.
   *
   * @returns True if history was loaded, false otherwise
   */
  public async initialize(): Promise<boolean> {
    return this.contextManager.initialize()
  }

  /**
   * Add a parallel tool result to the context.
   * Called sequentially after parallel execution to preserve message order.
   *
   * @param result - Parallel tool result to add
   */
  private async addParallelToolResultToContext(result: ParallelToolResult): Promise<void> {
    const {toolCall, toolResult} = result

    if (!toolResult) {
      // This shouldn't happen, but handle gracefully
      await this.contextManager.addToolResult(toolCall.id, toolCall.function.name, 'Error: No tool result available', {
        errorType: 'NO_RESULT',
        success: false,
      })
      return
    }

    await this.contextManager.addToolResult(
      toolCall.id,
      toolCall.function.name,
      toolResult.processedOutput.content,
      {
        errorType: toolResult.errorType,
        metadata: toolResult.metadata,
        success: toolResult.success,
      },
      toolResult.processedOutput.attachments,
    )
  }

  /**
   * Build generation request for the IContentGenerator.
   *
   * Converts internal context to the standardized GenerateContentRequest format.
   *
   * @param options - Request options
   * @param options.systemPrompt - System prompt text
   * @param options.tools - Available tools for function calling
   * @param options.executionContext - Optional execution context
   * @returns GenerateContentRequest for the generator
   */
  private buildGenerateContentRequest(options: BuildGenerateContentRequestOptions): GenerateContentRequest {
    // Get internal messages from context manager
    const messages = this.contextManager.getMessages()

    // Apply per-invocation overrides from ExecutionContext (e.g., query-optimized config)
    const effectiveMaxTokens = options.executionContext?.maxTokens ?? this.config.maxTokens
    const effectiveTemperature = options.executionContext?.temperature ?? this.config.temperature

    return {
      config: {
        maxTokens: effectiveMaxTokens,
        temperature: effectiveTemperature,
      },
      contents: messages,
      executionContext: options.executionContext,
      model: this.config.model,
      systemPrompt: options.systemPrompt,
      taskId: options.taskId ?? '',
      tools: options.tools,
    }
  }

  /**
   * Build a compact progress summary from current messages.
   * Used by rolling checkpoint to capture agentic state before clearing history.
   *
   * @param messages - Current conversation messages
   * @returns JSON string summarizing progress
   */
  private buildProgressSummary(messages: InternalMessage[]): string {
    const toolCalls = messages
      .filter((m) => m.toolCalls && m.toolCalls.length > 0)
      .flatMap((m) => m.toolCalls!.map((tc) => tc.function.name))

    const assistantMessages = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => typeof m.content === 'string' ? m.content.slice(0, 300) : '')
      .filter(Boolean)

    return JSON.stringify({
      assistantSummaries: assistantMessages.slice(-3),
      messageCount: messages.length,
      toolsUsed: [...new Set(toolCalls)],
      totalToolCalls: toolCalls.length,
    })
  }

  /**
   * Call LLM via generator and process the response.
   *
   * Uses the IContentGenerator interface which already has:
   * - Retry logic (via RetryableContentGenerator decorator)
   * - Logging (via LoggingContentGenerator decorator)
   *
   * @param request - Generation request
   * @returns Parsed internal message from response
   */
  private async callLLMAndParseResponse(request: GenerateContentRequest): Promise<InternalMessage> {
    try {
      const response = await this.generator.generateContent(request)

      // Convert response to InternalMessage format. The reasoning field must
      // round-trip on the next turn for some providers (e.g. DeepSeek-R1
      // rejects with "reasoning_content must be passed back to the API"
      // otherwise).
      const message: InternalMessage = {
        content: response.content,
        ...(response.reasoning && {reasoning: response.reasoning}),
        role: 'assistant',
        toolCalls: response.toolCalls,
      }

      // Validate the message has content or tool calls
      if (!message.content && (!message.toolCalls || message.toolCalls.length === 0)) {
        throw new LlmResponseParsingError('Response has neither content nor tool calls', 'byterover', this.config.model)
      }

      return message
    } catch (error) {
      // Re-throw LLM errors as-is
      if (error instanceof LlmResponseParsingError || error instanceof LlmGenerationError) {
        throw error
      }

      // Wrap other errors
      throw new LlmGenerationError(
        error instanceof Error ? error.message : String(error),
        'byterover',
        this.config.model,
      )
    }
  }

  /**
   * Streaming variant of callLLMAndParseResponse that:
   * - Uses generateContentStream for real-time chunk delivery
   * - Accumulates content and tool calls from chunks
   * - Emits llmservice:chunk events for thinking/reasoning chunks
   * - Returns complete InternalMessage when stream ends
   *
   * @param request - Generation request
   * @param taskId - Task ID for event emission
   * @returns Parsed internal message from accumulated stream
   */
  private async callLLMAndParseResponseStreaming(
    request: GenerateContentRequest,
    taskId?: string,
  ): Promise<InternalMessage> {
    try {
      let accumulatedContent = ''
      let accumulatedReasoning = ''
      let accumulatedToolCalls: ToolCall[] = []

      // Stream chunks and accumulate content
      for await (const chunk of this.generator.generateContentStream(request)) {
        // Emit thinking/reasoning chunks as events for TUI display + accumulate
        // for the InternalMessage so it round-trips on the next turn (DeepSeek-R1
        // requires reasoning_content to be passed back).
        if (chunk.type === StreamChunkType.THINKING && chunk.reasoning) {
          accumulatedReasoning += chunk.reasoning
          this.sessionEventBus.emit('llmservice:chunk', {
            content: chunk.reasoning,
            isComplete: chunk.isComplete,
            taskId,
            type: 'reasoning', // Convert THINKING to 'reasoning' for TUI compatibility
          })
        }

        // Accumulate text content (skip thinking chunks from accumulated content)
        if (chunk.content && chunk.type !== StreamChunkType.THINKING) {
          accumulatedContent += chunk.content

          // Emit text chunks for TUI display
          this.sessionEventBus.emit('llmservice:chunk', {
            content: chunk.content,
            isComplete: chunk.isComplete,
            taskId,
            type: 'text',
          })
        }

        // Accumulate tool calls
        if (chunk.toolCalls) {
          accumulatedToolCalls = chunk.toolCalls
        }
      }

      // Convert accumulated response to InternalMessage format
      const message: InternalMessage = {
        content: accumulatedContent || null,
        ...(accumulatedReasoning && {reasoning: accumulatedReasoning}),
        role: 'assistant',
        toolCalls: accumulatedToolCalls.length > 0 ? accumulatedToolCalls : undefined,
      }

      // Validate the message has content or tool calls
      if (!message.content && (!message.toolCalls || message.toolCalls.length === 0)) {
        throw new LlmResponseParsingError('Response has neither content nor tool calls', 'byterover', this.config.model)
      }

      return message
    } catch (error) {
      // Re-throw LLM errors as-is
      if (error instanceof LlmResponseParsingError || error instanceof LlmGenerationError) {
        throw error
      }

      // Wrap other errors
      throw new LlmGenerationError(
        error instanceof Error ? error.message : String(error),
        'byterover',
        this.config.model,
      )
    }
  }

  /**
   * Check for context overflow and trigger compaction if needed.
   * Called after each assistant response and after tool execution batches.
   *
   * Follows OpenCode's compaction patterns:
   * - First tries pruning tool outputs (if overflow > 85%)
   * - Then tries full compaction with LLM summary (if overflow > 95%)
   *
   * @param taskId - Task ID from usecase for billing tracking (passed from caller)
   */
  private async checkAndTriggerCompaction(taskId: string): Promise<void> {
    if (!this.compactionService) return

    // Calculate current token usage
    const messages = this.contextManager.getMessages()
    const messagesTokens = messages.reduce(
      (total, msg) =>
        total +
        this.generator.estimateTokensSync(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)),
      0,
    )

    // Estimate system prompt tokens (rough estimate since we don't have full context here)
    // Using a conservative estimate of 2000 tokens for system prompt
    const estimatedSystemPromptTokens = 2000
    const currentTokens = estimatedSystemPromptTokens + messagesTokens

    // Check overflow
    const overflowResult = this.compactionService.checkOverflow(currentTokens, this.config.maxInputTokens)

    if (!overflowResult.isOverflow) return

    // Emit context overflow event
    const utilizationPercent = Math.round((currentTokens / this.config.maxInputTokens) * 100)
    this.sessionEventBus.emit('llmservice:contextOverflow', {
      currentTokens,
      maxTokens: this.config.maxInputTokens,
      taskId: taskId || undefined,
      utilizationPercent,
    })

    // Defer event emissions until after DB operations succeed
    const effects = new DeferredEffects()

    try {
      if (overflowResult.recommendation === 'prune') {
        // Try pruning tool outputs first
        const pruneResult = await this.compactionService.pruneToolOutputs(this.sessionId, this.config.maxInputTokens)

        // Sync in-memory state with storage (replace compacted tool outputs)
        if (pruneResult.compactedCount > 0) {
          this.contextManager.markToolOutputsCompacted()

          effects.defer(() => {
            this.sessionEventBus.emit('llmservice:contextPruned', {
              pruneCount: pruneResult.compactedCount,
              reason: 'overflow',
              taskId: taskId || undefined,
              tokensSaved: pruneResult.tokensSaved,
            })

            this.sessionEventBus.emit('llmservice:warning', {
              message: `Context compaction: pruned ${pruneResult.compactedCount} old tool outputs (~${pruneResult.tokensSaved} tokens)`,
              taskId: taskId || undefined,
            })
          })
        }
      } else if (overflowResult.recommendation === 'compact') {
        const originalTokens = currentTokens

        // Full compaction needed - generate LLM summary
        // Use the same taskId from caller for billing tracking
        const summary = await this.compactionService.generateSummary(
          this.generator,
          messages,
          taskId,
          this.config.model,
        )

        await this.compactionService.createCompactionBoundary(this.sessionId, summary)

        // Reload in-memory state to only include post-boundary messages
        await this.contextManager.reloadFromStorage()

        const compressedTokens = this.generator.estimateTokensSync(summary)
        effects.defer(() => {
          this.sessionEventBus.emit('llmservice:contextCompressed', {
            compressedTokens,
            originalTokens,
            strategy: 'summary',
            taskId: taskId || undefined,
          })

          this.sessionEventBus.emit('llmservice:warning', {
            message: 'Context compaction: created summary boundary for conversation history',
            taskId: taskId || undefined,
          })
        })
      }

      // All DB ops succeeded — fire events
      effects.flush()
    } catch (error) {
      // DB ops failed — discard pending events
      effects.discard()
      throw error
    }
  }

  /**
   * Detect provider type from model name using the LLM registry.
   *
   * Uses explicit provider config first, then the centralized registry,
   * and falls back to string prefix matching if model is not in registry.
   *
   * @param model - Model identifier
   * @param explicitProvider - Optional explicit provider ID from config
   * @returns Provider type ('claude', 'gemini', or 'openai')
   */
  private detectProviderType(model: string, explicitProvider?: string): 'claude' | 'gemini' | 'openai' {
    return resolveRegistryProvider(model, explicitProvider)
  }

  /**
   * Determine which reflection prompt to add based on hierarchical priority.
   * Only the highest priority eligible reflection is returned.
   *
   * Priority (highest to lowest):
   * 1. final_iteration - query only, at the last iteration
   * 2. near_max_iterations - general, at 80% threshold
   * 3. mid_point_check - query only, at 50% threshold
   * 4. completion_check - general, periodic every 3 iterations
   *
   * @param iterationCount - Current iteration count (0-indexed)
   * @param commandType - Command type ('query' or 'curate')
   * @returns Reflection type to add, or undefined if none eligible
   */
  private determineReflectionType(
    iterationCount: number,
    commandType?: 'chat' | 'curate' | 'query',
    maxIterations?: number,
  ): 'completion_check' | 'final_iteration' | 'mid_point_check' | 'near_max_iterations' | undefined {
    const effectiveMax = maxIterations ?? this.config.maxIterations
    const isQuery = commandType === 'query'
    const isLastIteration = iterationCount === effectiveMax - 1
    const midPoint = Math.floor(effectiveMax / 2)
    const isAtMidPoint = iterationCount === midPoint
    const isNearMax = iterationCount >= Math.floor(effectiveMax * 0.8)
    const isPeriodicCheck = iterationCount > 0 && iterationCount % 3 === 0

    // Priority 1: final_iteration (query only, last iteration) - highest priority
    if (isQuery && isLastIteration) {
      return 'final_iteration'
    }

    // Priority 2: near_max_iterations (general, 80% threshold)
    if (isNearMax) {
      return 'near_max_iterations'
    }

    // Priority 3: mid_point_check (query only, 50% threshold)
    if (isQuery && isAtMidPoint) {
      return 'mid_point_check'
    }

    // Priority 4: completion_check (general, periodic every 3 iterations) - lowest priority
    if (isPeriodicCheck) {
      return 'completion_check'
    }

    return undefined
  }

  /**
   * Execute a single iteration of the agentic loop.
   *
   * @param options - Iteration options
   * @param options.effectiveMaxIterations - Effective max iterations (per-invocation override or config default)
   * @param options.executionContext - Optional execution context
   * @param options.fileData - Optional file data (only used on first iteration)
   * @param options.imageData - Optional image data (only used on first iteration)
   * @param options.iterationCount - Current iteration number
   * @param options.stream - Whether to stream response and emit thinking chunks
   * @param options.taskId - Task ID from usecase for billing tracking
   * @param options.textInput - User input text (only used on first iteration)
   * @param options.tools - Available tools for this iteration
   * @returns Final response string if complete, null if more iterations needed
   */
  private async executeAgenticIteration(options: {
    effectiveMaxIterations: number
    executionContext?: ExecutionContext
    fileData?: FileData
    imageData?: ImageData
    iterationCount: number
    stream?: boolean
    taskId?: string
    textInput: string
    tools: ToolSet
  }): Promise<null | string> {
    const {effectiveMaxIterations, executionContext, fileData, imageData, iterationCount, stream, taskId, textInput, tools} = options
    // Build system prompt using SystemPromptManager (before compression for correct token accounting)
    // Use filtered tool names based on command type (e.g., only read-only tools for 'query')
    const availableTools = this.toolManager.getToolNamesForCommand(executionContext?.commandType)
    const markersSet = this.toolManager.getAvailableMarkers()
    // Convert Set to Record for prompt factory
    const availableMarkers: Record<string, string> = {}
    for (const marker of markersSet) {
      availableMarkers[marker] = marker
    }

    // Build base system prompt (cached across iterations within the same task)
    const needsFullRebuild = iterationCount === 0 || this.cachedBasePrompt === null || this.memoryDirtyFlag
    let basePrompt: string

    if (needsFullRebuild) {
      // Full rebuild: first iteration, no cache, or memory was modified by tools
      const environmentContext = await this.environmentBuilder.build({
        includeBrvStructure: true,
        includeFileTree: true,
        maxFileTreeDepth: 3,
        maxFileTreeEntries: 100,
        workingDirectory: this.workingDirectory,
      })

      basePrompt = await this.systemPromptManager.build({
        availableMarkers,
        availableTools,
        commandType: executionContext?.commandType,
        conversationMetadata: executionContext?.conversationMetadata,
        environmentContext,
        fileReferenceInstructions: executionContext?.fileReferenceInstructions,
        memoryManager: this.memoryManager,
      })

      this.cachedBasePrompt = basePrompt
      this.memoryDirtyFlag = false
    } else {
      // Cache hit: reuse base prompt verbatim. The cached prompt has no
      // dateTime section to refresh — dateTime is injected into the
      // first user message instead so the system prefix stays byte-stable
      // across iterations and prompt caching can engage cleanly.
      basePrompt = this.cachedBasePrompt!
    }

    let systemPrompt = basePrompt

    // Determine which reflection prompt to add (only highest priority is chosen)
    const reflectionType = this.determineReflectionType(iterationCount, executionContext?.commandType, effectiveMaxIterations)

    // Add reflection prompt if eligible (hierarchical: only one reflection per iteration)
    if (reflectionType) {
      const reflectionPrompt = this.systemPromptManager.buildReflectionPrompt({
        currentIteration: iterationCount + 1,
        maxIterations: effectiveMaxIterations,
        type: reflectionType,
      })
      systemPrompt = systemPrompt + '\n\n' + reflectionPrompt
    }

    // Verbose debug: Show complete system prompt
    if (this.config.verbose) {
      this.logger.debug('System prompt details', {
        first500Chars: systemPrompt.slice(0, 500),
        iteration: iterationCount + 1,
        last500Chars: systemPrompt.slice(-500),
        length: systemPrompt.length,
        lines: systemPrompt.split('\n').length,
        reflectionType,
      })
    }

    // Final iteration optimization for query: strip tools (reflection already added above)
    let toolsForThisIteration = tools
    if (executionContext?.commandType === 'query' && iterationCount === effectiveMaxIterations - 1) {
      toolsForThisIteration = {} // Empty toolset forces text response
    }

    // Get token count for logging (using system prompt for token accounting)
    const systemPromptTokens = this.generator.estimateTokensSync(systemPrompt)

    // Add user message and compress context within mutex lock
    return this.mutex.withLock(async () => {
      // Add user message to context only on the first iteration. The
      // dateTime block is prefixed here (not in the system prompt) so
      // the cached system prefix stays byte-stable across iterations
      // and Anthropic/OpenAI/Google prefix caches can engage cleanly.
      if (iterationCount === 0) {
        const inputWithDateTime = `${buildDateTimePrefix()}${textInput}`
        await this.contextManager.addUserMessage(inputWithDateTime, imageData, fileData)
      }

      // Rolling checkpoint: periodically save progress and clear history for RLM commands.
      // This prevents unbounded token accumulation during long curation/query tasks.
      if (iterationCount > 0) {
        const preCheckpointMessages = this.contextManager.getMessages()
        const preCheckpointTokens = preCheckpointMessages.reduce(
          (sum, msg) => sum + this.generator.estimateTokensSync(
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          ),
          0,
        )

        if (this.shouldTriggerCheckpoint(iterationCount, executionContext?.commandType, preCheckpointTokens)) {
          await this.performRollingCheckpoint(iterationCount, this.sessionId, textInput)
        }
      }

      const maxMessageTokens = this.config.maxInputTokens - systemPromptTokens
      // Target utilization to leave headroom for response
      const targetMessageTokens = Math.floor(maxMessageTokens * TARGET_MESSAGE_TOKEN_UTILIZATION)

      // Count current token usage
      const currentMessages = this.contextManager.getMessages()
      const currentTokens = currentMessages.reduce(
        (sum, msg) => sum + this.generator.estimateTokensSync(
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        ),
        0,
      )

      // Zero-cost continuity: skip all compression work if under threshold.
      // Below 70% utilization, the agent pays zero overhead for context management.
      if (currentTokens > targetMessageTokens) {
        // Step 1: Non-destructive pruning — clear old tool outputs first
        this.contextManager.markToolOutputsCompacted(2)

        // Step 2: Recount after pruning
        const afterPruningMessages = this.contextManager.getMessages()
        const afterPruningTokens = afterPruningMessages.reduce(
          (sum, msg) => sum + this.generator.estimateTokensSync(
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          ),
          0,
        )

        // Step 3: If still over, run escalated compression (L1→L2→L3) via strategy chain
        if (afterPruningTokens > targetMessageTokens) {
          await this.contextManager.compressAndReplace(systemPromptTokens, targetMessageTokens)
        }

        // Step 4: Emergency guard for curate/query commands.
        // Critical because curate/query have only 1 user turn, making
        // protectedTurns=2 in markToolOutputsCompacted() ineffective.
        if (executionContext?.commandType === 'curate' || executionContext?.commandType === 'query') {
          const postCompressionMessages = this.contextManager.getMessages()
          const postCompressionTokens = postCompressionMessages.reduce(
            (sum, msg) => sum + this.generator.estimateTokensSync(
              typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            ),
            0,
          )
          const totalWithSystem = postCompressionTokens + systemPromptTokens

          if (totalWithSystem > this.config.maxInputTokens * 0.9) {
            // Aggressive: compact ALL tool outputs (protect 0 turns instead of 2)
            this.contextManager.markToolOutputsCompacted(0)

            // Re-run escalated compression with aggressively pruned context
            await this.contextManager.compressAndReplace(systemPromptTokens, targetMessageTokens)

            this.sessionEventBus.emit('llmservice:warning', {
              message: `Emergency context compression triggered (${Math.round((totalWithSystem / this.config.maxInputTokens) * 100)}% utilization)`,
              taskId,
            })
          }
        }
      }

      // Build generation request
      const request = this.buildGenerateContentRequest({
        executionContext,
        systemPrompt,
        taskId,
        tools: toolsForThisIteration,
      })

      // Call LLM via generator (retry + logging handled by decorators)
      // Use streaming variant if enabled to emit thinking/reasoning chunks
      const lastMessage = stream
        ? await this.callLLMAndParseResponseStreaming(request, taskId)
        : await this.callLLMAndParseResponse(request)

      // Check if there are tool calls
      if (!lastMessage.toolCalls || lastMessage.toolCalls.length === 0) {
        const response = await this.handleFinalResponse(lastMessage, taskId)

        // Auto-compaction check after assistant response
        await this.checkAndTriggerCompaction(taskId ?? '')

        return response
      }

      // Has tool calls - handle them (pass taskId and executionContext for context-aware behavior)
      const earlyExitResult = await this.handleToolCalls(lastMessage, taskId, executionContext)

      // Check for early exit from setFinalResult()
      if (earlyExitResult) {
        this.sessionEventBus.emit('llmservice:response', {
          content: earlyExitResult,
          model: this.config.model,
          provider: this.providerId,
          taskId,
        })

        return earlyExitResult
      }

      // Auto-compaction check after tool execution batch
      await this.checkAndTriggerCompaction(taskId ?? '')

      return null
    })
  }

  /**
   * Execute a single tool call in parallel (without adding to context).
   * Returns all information needed to add the result to context later.
   *
   * @param toolCall - Tool call to execute
   * @param taskId - Task ID from usecase for billing tracking (passed to subagents)
   * @param executionContext - Optional execution context for context-aware tool behavior
   * @returns Parallel tool result with all execution data
   */
  private async executeToolCallParallel(toolCall: ToolCall, taskId?: string, executionContext?: ExecutionContext): Promise<ParallelToolResult> {
    const toolName = toolCall.function.name
    const toolArgs = JSON.parse(toolCall.function.arguments)

    try {
      // Check for loops before execution (mutex-protected)
      const loopResult = await this.loopDetector.recordAndCheck(toolName, toolArgs)

      if (loopResult.isLoop) {
        // Emit dedicated doom loop event for observability
        this.sessionEventBus.emit('llmservice:doomLoopDetected', {
          args: toolArgs,
          loopType: loopResult.loopType!,
          repeatCount: loopResult.repeatCount ?? 0,
          taskId: taskId || undefined,
          toolName,
        })

        // Also emit warning event for backward compatibility
        this.sessionEventBus.emit('llmservice:warning', {
          message: `Doom loop detected: ${loopResult.loopType} - tool "${toolName}" repeated ${loopResult.repeatCount} times. Auto-denying to prevent infinite loop.`,
          taskId: taskId || undefined,
        })

        return {
          toolCall,
          toolResult: {
            errorType: 'LOOP_DETECTED',
            metadata: {
              loopType: loopResult.loopType,
              repeatCount: loopResult.repeatCount,
            },
            processedOutput: {
              content: `⚠️ DOOM LOOP DETECTED: ${loopResult.suggestion}\n\nThe tool call has been automatically rejected to prevent an infinite loop. Please try a different approach to accomplish your goal.`,
            },
            success: false,
          },
        }
      }

      // Emit tool call event
      this.sessionEventBus.emit('llmservice:toolCall', {
        args: toolArgs,
        callId: toolCall.id,
        taskId: taskId || undefined,
        toolName,
      })

      // Create metadata callback for streaming tool output
      const metadataCallback = this.metadataHandler.createCallback(toolCall.id, toolName)

      // Execute tool via ToolManager (returns structured result)
      // Pass taskId and commandType in context for subagent billing tracking and context-aware behavior
      const result: ToolExecutionResult = await this.toolManager.executeTool(toolName, toolArgs, this.sessionId, {
        commandType: executionContext?.commandType,
        metadata: metadataCallback,
        taskId,
      })

      // Process output (truncation and file saving if needed, with per-command overrides)
      const processedOutput = await this.outputProcessor.processStructuredOutput(toolName, result.content, executionContext?.commandType)

      // Emit truncation event if output was truncated
      if (processedOutput.metadata?.truncated) {
        this.sessionEventBus.emit('llmservice:outputTruncated', {
          originalLength: processedOutput.metadata.originalLength!,
          savedToFile: processedOutput.metadata.savedToFile!,
          taskId: taskId || undefined,
          toolName,
        })
      }

      // Emit tool result event with success/error info
      this.sessionEventBus.emit('llmservice:toolResult', {
        callId: toolCall.id,
        error: result.errorMessage,
        errorType: result.errorType,
        metadata: {
          ...result.metadata,
          ...processedOutput.metadata,
        },
        result: processedOutput.content,
        success: result.success,
        taskId: taskId || undefined,
        toolName,
      })

      // Check for early exit signal from setFinalResult() in sandbox
      const toolContent = result.content as Record<string, unknown> | undefined
      const earlyExitResult = typeof toolContent?.finalResult === 'string' ? toolContent.finalResult : undefined

      return {
        earlyExitResult,
        toolCall,
        toolResult: {
          errorType: result.errorType,
          metadata: {
            ...result.metadata,
            ...processedOutput.metadata,
          },
          processedOutput,
          success: result.success,
        },
      }
    } catch (error) {
      // Catch any unexpected errors during execution
      const errorMessage = getErrorMessage(error)
      this.logger.error('Error executing tool in parallel', {error, toolCallId: toolCall.id, toolName})

      return {
        error: errorMessage,
        toolCall,
        toolResult: {
          errorType: 'EXECUTION_ERROR',
          metadata: {},
          processedOutput: {content: `Error executing tool: ${errorMessage}`},
          success: false,
        },
      }
    }
  }

  /**
   * Extract text content from an internal message.
   *
   * @param message - Internal message
   * @returns Text content as string
   */
  private extractTextContent(message: InternalMessage): string {
    if (typeof message.content === 'string') {
      return message.content
    }

    if (Array.isArray(message.content)) {
      return message.content
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('')
    }

    return ''
  }

  /**
   * Extract partial response from conversation history when max iterations reached.
   * Returns the last assistant message or accumulated tool outputs.
   *
   * @returns Partial response string
   */
  private async getPartialResponse(): Promise<string> {
    const history = this.contextManager.getMessages()

    // Find last assistant message
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i]
      if (msg && msg.role === 'assistant') {
        return this.extractTextContent(msg)
      }
    }

    return ''
  }

  /**
   * Handle final response when there are no tool calls.
   *
   * @param lastMessage - Last message from LLM
   * @param taskId - Optional task ID for concurrent task isolation
   * @returns Final response content
   */
  private async handleFinalResponse(lastMessage: InternalMessage, taskId?: string): Promise<string> {
    const content = this.extractTextContent(lastMessage)

    // Emit response event
    this.sessionEventBus.emit('llmservice:response', {
      content,
      model: this.config.model,
      provider: this.providerId,
      taskId: taskId || undefined,
    })

    // Add assistant message to context. Pass reasoning so it round-trips to
    // providers that demand it (DeepSeek-R1 rejects with "reasoning_content
    // must be passed back to the API" otherwise).
    await this.contextManager.addAssistantMessage(content, undefined, lastMessage.reasoning)

    return content
  }

  /**
   * Handle LLM errors and re-throw or wrap appropriately.
   *
   * @param error - Error to handle
   * @param taskId - Optional task ID for concurrent task isolation
   */
  private handleLLMError(error: unknown, taskId?: string): never {
    // Emit error event
    const errorMessage = error instanceof Error ? error.message : String(error)
    this.sessionEventBus.emit('llmservice:error', {
      error: errorMessage,
      taskId: taskId || undefined,
    })

    // Re-throw LLM errors as-is
    if (
      error instanceof LlmResponseParsingError ||
      error instanceof LlmGenerationError ||
      error instanceof LlmMaxIterationsError
    ) {
      throw error
    }

    // Wrap other errors
    if (error && typeof error === 'object' && 'message' in error) {
      throw new LlmGenerationError(getErrorMessage(error), 'byterover', this.config.model)
    }

    throw new LlmGenerationError(String(error), 'byterover', this.config.model)
  }

  /**
   * Handle agent termination due to timeout or max turns.
   *
   * Emits appropriate events and returns a partial response.
   *
   * @param reason - Why the agent is terminating
   * @param stateMachine - The state machine for context
   * @param taskId - Optional task ID for concurrent task isolation
   * @returns Partial response or fallback message
   */
  private async handleTermination(
    reason: TerminationReason,
    stateMachine: AgentStateMachine,
    taskId?: string,
  ): Promise<string> {
    const context = stateMachine.getContext()
    const durationMs = Date.now() - context.startTime.getTime()

    this.logger.warn('Agent execution terminated', {
      durationMs,
      reason,
      toolCallsExecuted: context.toolCallsExecuted,
      turnCount: context.turnCount,
    })

    // Emit termination event
    this.sessionEventBus.emit('llmservice:warning', {
      message: `Agent terminated: ${reason} after ${context.turnCount} turns`,
      model: this.config.model,
      provider: this.providerId,
      taskId: taskId || undefined,
    })

    // Get accumulated response from context
    const partialResponse = await this.getPartialResponse()

    // Compute final content with fallback BEFORE emitting, so the event
    // carries the same content that is returned (prevents empty-string mismatch
    // when the streaming pipeline reads from the emitted event rather than the return value)
    let finalContent: string
    if (reason === TerminationReason.MAX_TURNS) {
      finalContent =
        partialResponse ||
        'Maximum iterations reached without completing the task. Please try breaking down the task into smaller steps.'
    } else if (reason === TerminationReason.TIMEOUT) {
      finalContent = partialResponse || 'Execution timed out. Please try a simpler task or increase the timeout.'
    } else {
      finalContent = partialResponse || 'Agent execution terminated unexpectedly.'
    }

    this.sessionEventBus.emit('llmservice:response', {
      content: finalContent,
      model: this.config.model,
      partial: true,
      provider: this.providerId,
      taskId: taskId || undefined,
    })

    return finalContent
  }

  /**
   * Handle thoughts from LLM response (Gemini only).
   *
   * Extracts and emits thought events if present.
   *
   * @param message - Message potentially containing thoughts
   * @param taskId - Optional task ID for concurrent task isolation
   */
  private handleThoughts(message: InternalMessage, taskId?: string): void {
    // Only process thoughts for Gemini models
    if (this.providerType !== 'gemini') {
      return
    }

    // Check if message has thought content
    if (message.thought) {
      // Parse thought if not already parsed
      if (!message.thoughtSummary) {
        message.thoughtSummary = ThoughtParser.parse(message.thought)
      }

      // Emit thought event
      this.sessionEventBus.emit('llmservice:thought', {
        description: message.thoughtSummary.description,
        subject: message.thoughtSummary.subject,
        taskId: taskId || undefined,
      })
    }
  }

  /**
   * Handle tool calls from LLM response.
   * Uses tool parts with state machine: pending → running → completed/error.
   * Executes tools in parallel for performance, but updates state in order.
   *
   * @param lastMessage - Last message containing tool calls
   * @param taskId - Task ID from usecase for billing tracking (passed to subagents)
   * @param executionContext - Optional execution context for context-aware tool behavior
   * @returns Early exit result if setFinalResult() was called, undefined otherwise
   */
  private async handleToolCalls(lastMessage: InternalMessage, taskId?: string, executionContext?: ExecutionContext): Promise<string | undefined> {
    if (!lastMessage.toolCalls || lastMessage.toolCalls.length === 0) {
      return
    }

    // Emit thought events if present
    this.handleThoughts(lastMessage, taskId)

    // Has tool calls - add assistant message with tool calls. Pass reasoning
    // so it round-trips to providers that demand it.
    const assistantContent = this.extractTextContent(lastMessage)
    await this.contextManager.addAssistantMessage(assistantContent, lastMessage.toolCalls, lastMessage.reasoning)

    // Step 1: Create pending tool parts for all tool calls
    for (const toolCall of lastMessage.toolCalls) {
      const toolArgs = JSON.parse(toolCall.function.arguments)
      // eslint-disable-next-line no-await-in-loop -- Must add pending parts in order
      await this.contextManager.addToolCallPending(toolCall.id, toolCall.function.name, toolArgs)
    }

    // Step 2: Transition all to running state
    const startTime = Date.now()
    for (const toolCall of lastMessage.toolCalls) {
      const runningState: ToolStateRunning = {
        input: JSON.parse(toolCall.function.arguments),
        startedAt: startTime,
        status: 'running',
      }
      // eslint-disable-next-line no-await-in-loop -- Must update states in order
      await this.contextManager.updateToolCallState(toolCall.id, runningState)
    }

    // Check if any memory-modifying tools are being called (invalidates cached system prompt)
    const memoryModifyingTools = new Set(['delete_memory', 'edit_memory', 'write_memory'])
    if (lastMessage.toolCalls.some((tc) => memoryModifyingTools.has(tc.function.name))) {
      this.memoryDirtyFlag = true
    }

    // Step 3: Execute all tool calls in parallel (pass taskId + commandType for context-aware behavior)
    const parallelResults = await Promise.allSettled(
      lastMessage.toolCalls.map((toolCall) => this.executeToolCallParallel(toolCall, taskId, executionContext)),
    )

    // Step 4: Update tool part states with results (in order)
    const endTime = Date.now()
    // eslint-disable-next-line unicorn/no-for-loop -- Need index to access both parallelResults and toolCalls in parallel
    for (let i = 0; i < parallelResults.length; i++) {
      const settledResult = parallelResults[i]
      const toolCall = lastMessage.toolCalls[i]
      const toolArgs = JSON.parse(toolCall.function.arguments)

      if (settledResult.status === 'fulfilled') {
        const result = settledResult.value

        if (result.toolResult?.success) {
          // Transition to completed state
          const completedState: ToolStateCompleted = {
            attachments: result.toolResult.processedOutput.attachments,
            input: toolArgs,
            metadata: result.toolResult.metadata,
            output: result.toolResult.processedOutput.content,
            status: 'completed',
            time: {end: endTime, start: startTime},
            title: result.toolResult.processedOutput.title,
          }
          // eslint-disable-next-line no-await-in-loop -- Must update states in order
          await this.contextManager.updateToolCallState(toolCall.id, completedState)
        } else {
          // Transition to error state
          const errorState: ToolStateError = {
            error: result.toolResult?.processedOutput.content ?? result.error ?? 'Unknown error',
            input: toolArgs,
            status: 'error',
            time: {end: endTime, start: startTime},
          }
          // eslint-disable-next-line no-await-in-loop -- Must update states in order
          await this.contextManager.updateToolCallState(toolCall.id, errorState)
        }

        // Also add to context as tool result message (for backward compatibility)
        // eslint-disable-next-line no-await-in-loop -- Must add results in order
        await this.addParallelToolResultToContext(result)
      } else {
        // Handle unexpected Promise rejection
        const errorMessage = getErrorMessage(settledResult.reason)
        this.logger.error('Unexpected error in parallel tool execution', {
          error: settledResult.reason,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
        })

        // Transition to error state
        const errorState: ToolStateError = {
          error: errorMessage,
          input: toolArgs,
          status: 'error',
          time: {end: endTime, start: startTime},
        }
        // eslint-disable-next-line no-await-in-loop -- Must update states in order
        await this.contextManager.updateToolCallState(toolCall.id, errorState)

        // Also add to context as tool result message (for backward compatibility)
        // eslint-disable-next-line no-await-in-loop -- Must add results in order
        await this.contextManager.addToolResult(toolCall.id, toolCall.function.name, `Error: ${errorMessage}`, {
          errorType: 'UNEXPECTED_ERROR',
          success: false,
        })
      }
    }

    // Check for early exit signal from setFinalResult() in any tool result
    for (const settledResult of parallelResults) {
      if (settledResult.status === 'fulfilled' && settledResult.value.earlyExitResult) {
        return settledResult.value.earlyExitResult
      }
    }
  }

  /**
   * Perform a rolling checkpoint: save progress to sandbox variable, clear history, re-inject prompt.
   * This treats each batch of iterations as a mini-task, preventing unbounded token accumulation.
   *
   * @param iterationCount - Current iteration number
   * @param sessionId - Session ID for sandbox variable injection
   * @param textInput - Original user input text (for continuation prompt)
   */
  private async performRollingCheckpoint(
    iterationCount: number,
    sessionId: string,
    textInput: string,
  ): Promise<void> {
    const messages = this.contextManager.getMessages()
    const progressSummary = this.buildProgressSummary(messages)

    // Store progress in sandbox variable (persists across history clears)
    const checkpointVar = `__checkpoint_progress`
    this.sandboxService!.setSandboxVariable(sessionId, checkpointVar, progressSummary)

    // Clear conversation history
    await this.contextManager.clearHistory()

    // Re-inject continuation prompt with variable reference.
    // Prepend the dateTime block: clearHistory wiped the iter-0 user
    // message that originally carried it, and the iter-0 guard upstream
    // prevents re-injection. Without this, every iteration after the
    // first checkpoint loses time context for the rest of the run.
    const continuationPrompt = buildDateTimePrefix() + [
      `Continue task. Iteration checkpoint at turn ${iterationCount}.`,
      `Previous progress stored in variable: ${checkpointVar}`,
      `Original task: ${textInput.slice(0, 200)}${textInput.length > 200 ? '...' : ''}`,
      `Read ${checkpointVar} via code_exec to understand what was done, then continue.`,
    ].join('\n')

    await this.contextManager.addUserMessage(continuationPrompt)

    this.sessionEventBus.emit('llmservice:warning', {
      message: `Rolling checkpoint at iteration ${iterationCount}: history cleared, progress saved to ${checkpointVar}`,
    })
  }

  /**
   * Check if a rolling checkpoint should trigger.
   * Triggers every N iterations for curate/query commands, or when token utilization is high.
   *
   * @param iterationCount - Current iteration number
   * @param commandType - Command type (only curate/query trigger checkpoints)
   * @param currentTokens - Current estimated token count for messages
   * @returns True if checkpoint should trigger
   */
  private shouldTriggerCheckpoint(
    iterationCount: number,
    commandType?: string,
    currentTokens?: number,
  ): boolean {
    // Only for curate/query commands (never disrupt chat)
    if (commandType !== 'curate' && commandType !== 'query') {
      return false
    }

    // Never on first iteration
    if (iterationCount === 0) {
      return false
    }

    // Need sandbox service for variable injection
    if (!this.sandboxService) {
      return false
    }

    // Trigger every 5 iterations
    const CHECKPOINT_INTERVAL = 5
    if (iterationCount % CHECKPOINT_INTERVAL === 0) {
      return true
    }

    // Trigger on high token utilization (> 60%)
    if (currentTokens && currentTokens > this.config.maxInputTokens * 0.6) {
      return true
    }

    return false
  }

  /**
   * Validate LLM configuration using Zod schema.
   *
   * Performs validation against the centralized LLM config schema.
   * Logs warnings for invalid configurations but doesn't throw to maintain
   * backward compatibility with existing code.
   *
   * @param model - Model name to validate
   * @param maxInputTokens - Optional max input tokens to validate
   */
  private validateConfig(model: string, maxInputTokens?: number): void {
    const result = safeParseLLMConfig({
      maxInputTokens,
      maxIterations: this.config?.maxIterations ?? 50,
      model,
      provider: this.providerType,
    })

    if (!result.success) {
      // Log validation warnings but don't throw (backward compatibility)
      const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')

      this.logger.warn('LLM config validation warning', {
        issues,
        model,
        provider: this.providerType,
      })

      // Also check if model is valid in registry
      if (!isValidProviderModel(this.providerType, model)) {
        this.logger.info('Model not in registry, using fallback defaults', {
          model,
          provider: this.providerType,
        })
      }
    }
  }
}
