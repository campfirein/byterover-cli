import type {ITransportClient} from '@campfirein/brv-transport-client'

import {randomUUID} from 'node:crypto'
import {setMaxListeners} from 'node:events'

import type {BrvConfig} from '../../../server/core/domain/entities/brv-config.js'
import type {ProviderConfigResponse} from '../../../server/core/domain/transport/schemas.js'
import type {AgentEventMap} from '../../core/domain/agent-events/types.js'
import type {GenerateResponse, StreamingEvent, StreamOptions} from '../../core/domain/streaming/types.js'
import type {CipherAgentServices} from '../../core/interfaces/cipher-services.js'
import type {IChatSession} from '../../core/interfaces/i-chat-session.js'
import type {AgentState, ExecutionContext, ICipherAgent} from '../../core/interfaces/i-cipher-agent.js'
import type {IHistoryStorage} from '../../core/interfaces/i-history-storage.js'
import type {ITokenizer} from '../../core/interfaces/i-tokenizer.js'
import type {FileSystemService} from '../file-system/file-system-service.js'
import type {MemoryManager} from '../memory/memory-manager.js'
import type {ProcessService} from '../process/process-service.js'
import type {SystemPromptManager} from '../system-prompt/system-prompt-manager.js'
import type {ToolManager} from '../tools/tool-manager.js'
import type {ToolProvider} from '../tools/tool-provider.js'
import type {AgentConfig} from './agent-schemas.js'
import type {ProviderUpdateConfig} from './provider-update-config.js'

import {SETTINGS_KEYS} from '../../../server/core/domain/entities/settings.js'
import {TransportStateEventNames} from '../../../server/core/domain/transport/schemas.js'
import {agentLog} from '../../../server/utils/process-logger.js'
import {getEffectiveMaxInputTokens, resolveRegistryProvider} from '../../core/domain/llm/index.js'
import {STREAMING_EVENT_NAMES} from '../../core/domain/streaming/types.js'
import {ToolName} from '../../core/domain/tools/constants.js'
import {AgentEventBus} from '../events/event-emitter.js'
import {RetryableContentGenerator} from '../llm/generators/index.js'
import {createGeneratorForProvider} from '../llm/providers/index.js'
import {DEFAULT_RETRY_POLICY} from '../llm/retry/retry-policy.js'
import {EventBasedLogger} from '../logger/event-based-logger.js'
import {deregisterRootEligibleSession, registerRootEligibleSession} from '../map/agentic-map-service.js'
import {MemoryDeduplicator} from '../memory/memory-deduplicator.js'
import {createCurateService} from '../sandbox/curate-service.js'
import {SessionCompressor} from '../session/session-compressor.js'
import {SessionManager} from '../session/session-manager.js'
import {getAgentSettingValue} from '../settings/agent-settings-snapshot.js'
import {TransportEventBridge} from '../transport/transport-event-bridge.js'
import {AgentError} from './agent-error.js'
import {BaseAgent} from './base-agent.js'
import {type ByteRoverHttpConfig, createCipherAgentServices, type SessionLLMConfig} from './service-initializer.js'

const QUEUE_TRACE_ENABLED = process.env.BRV_QUEUE_TRACE === '1'

/**
 * CipherAgent - Main agent implementation extending BaseAgent.
 *
 * Inherits from BaseAgent:
 * - Two-phase initialization (constructor + start)
 * - Lifecycle management (start, stop, restart)
 * - State management with session overrides
 * - Typed error handling
 * - Configuration validation (Zod)
 *
 * Architecture:
 * - Agent creates AgentEventBus in constructor (available before start)
 * - Agent creates and owns shared services (ToolManager, SystemPromptManager, etc.)
 * - SessionManager creates session-specific services (LLM, SessionEventBus)
 * - Agent delegates execution to sessions via session.run()
 *
 * Usage:
 * - execute(input) uses default session automatically
 * - execute(input, sessionId) for multi-session support
 */
export class CipherAgent extends BaseAgent implements ICipherAgent {
  // Private state (must come before methods)
  private readonly _agentEventBus: AgentEventBus
  private readonly _brvConfig?: BrvConfig
  /** Unique ID for this agent instance — scopes nesting registry ownership. */
  private readonly _instanceId = randomUUID()
  private readonly _projectIdProvider?: () => string
  /**
   * Session ID - created once during start().
   * Each agent has exactly 1 session (Single-Session pattern).
   */
  private _sessionId?: string
  private readonly _sessionKeyProvider?: () => string
  private readonly _spaceIdProvider?: () => string
  private readonly _teamIdProvider?: () => string
  private readonly _transportClient?: ITransportClient
  private readonly activeStreamControllers: Map<string, AbortController> = new Map()
  private eventBridge?: TransportEventBridge
  /**
   * Tracks session IDs this agent instance registered as root-eligible.
   * Used for bulk deregistration on agent teardown (cleanupServices).
   */
  private readonly rootEligibleSessions = new Set<string>()
  /** Lazily-created session compressor, rebuilt on each rebindCurateTools() call. */
  private sessionCompressor?: SessionCompressor
  private sessionManager?: SessionManager
  /** Tracks user-facing task sessions for post-session memory extraction. */
  private readonly userFacingTaskSessions = new Set<string>()

  /**
   * Creates a new CipherAgent instance.
   * Does NOT initialize services - call start() for async initialization.
   *
   * @param config - Agent configuration (Zod-validated AgentConfig)
   * @param brvConfig - Optional ByteRover config for spaceId/teamId
   * @param options - Optional lazy providers and transport client; resolved per HTTP request from StateServer
   * @param options.projectIdProvider - Lazy provider for project ID
   * @param options.sessionKeyProvider - Lazy provider for session key
   * @param options.spaceIdProvider - Lazy provider for space ID
   * @param options.teamIdProvider - Lazy provider for team ID
   * @param options.transportClient - Transport client for daemon communication
   */
  public constructor(
    config: AgentConfig,
    brvConfig?: BrvConfig,
    options?: {
      projectIdProvider?: () => string
      sessionKeyProvider?: () => string
      spaceIdProvider?: () => string
      teamIdProvider?: () => string
      transportClient?: ITransportClient
    },
  ) {
    // Call parent constructor (validates with Zod)
    super(config)

    // Create event bus early (available before start)
    this._agentEventBus = new AgentEventBus()

    this._brvConfig = brvConfig
    this._projectIdProvider = options?.projectIdProvider
    this._sessionKeyProvider = options?.sessionKeyProvider
    this._spaceIdProvider = options?.spaceIdProvider
    this._teamIdProvider = options?.teamIdProvider
    this._transportClient = options?.transportClient
  }

  public get agentEventBus() {
    return this.services?.agentEventBus
  }

  // === Public Getters (expose services for backward compatibility) ===

  public get fileSystemService(): FileSystemService | undefined {
    return this.services?.fileSystemService
  }

  public get historyStorage(): IHistoryStorage | undefined {
    return this.services?.historyStorage
  }

  public get memoryManager(): MemoryManager | undefined {
    return this.services?.memoryManager
  }

  public get processService(): ProcessService | undefined {
    return this.services?.processService
  }

  /**
   * Get the session ID (created during start()).
   * Each agent has exactly 1 session (Single-Session pattern).
   */
  public get sessionId(): string | undefined {
    return this._sessionId
  }

  public get systemPromptManager(): SystemPromptManager | undefined {
    return this.services?.systemPromptManager
  }

  public get toolManager(): ToolManager | undefined {
    return this.services?.toolManager
  }

  public get toolProvider(): ToolProvider | undefined {
    return this.services?.toolProvider
  }

  /**
   * Get the injected transport client (if any).
   * Available when agent runs as a child process connected to daemon.
   */
  public get transportClient(): ITransportClient | undefined {
    return this._transportClient
  }

  /**
   * Cancels the currently running turn for the agent's default session.
   * Safe to call even if no run is in progress.
   *
   * @returns true if a run was in progress and was signaled to abort; false otherwise
   */
  public async cancel(): Promise<boolean> {
    this.ensureStarted()

    const sessionId = this.getSessionIdInternal()

    // Abort the stream iterator first (so consumer's for-await loop exits cleanly)
    const streamController = this.activeStreamControllers.get(sessionId)
    if (streamController) {
      streamController.abort()
      this.activeStreamControllers.delete(sessionId)
    }

    // Then cancel the session's LLM/tool execution
    const session = this.getSessionManagerInternal().getSession(sessionId)
    if (session) {
      session.cancel()
      return true
    }

    // If no session found but stream was aborted, still return true
    return Boolean(streamController)
  }

  // === Public Methods (alphabetical order) ===

  protected override async cleanupServices(): Promise<void> {
    // Drain abstract generation queue before session disposal
    await this.drainAbstractQueue()

    // Abort all active streams and clear controllers
    for (const controller of this.activeStreamControllers.values()) {
      controller.abort()
    }

    this.activeStreamControllers.clear()

    // Dispose event bridge (removes all transport forwarding listeners)
    if (this.eventBridge) {
      this.eventBridge.dispose()
      this.eventBridge = undefined
    }

    // Deregister all root-eligible sessions before session manager disposal.
    // stop()/restart() disposes without calling deleteSession() per session,
    // so this bulk cleanup prevents registry accumulation across restarts.
    for (const sessionId of this.rootEligibleSessions) {
      deregisterRootEligibleSession(sessionId, this._instanceId)
    }

    this.rootEligibleSessions.clear()

    // Dispose session manager
    if (this.sessionManager) {
      this.sessionManager.dispose()
      this.sessionManager = undefined
    }

    // Reset execution state (only if state manager exists - may not during early cleanup)
    if (this.stateManager) {
      this.stateManager.reset()
    }

    // Clean up sandbox service (release VM contexts and pending operations)
    if (this.services?.sandboxService) {
      await this.services.sandboxService.cleanup()
    }

    // Close SQLite databases to release file handles and ensure clean shutdown
    if (this.services?.blobStorage) {
      this.services.blobStorage.close()
    }
  }

  /**
   * Create a new session.
   */
  public async createSession(sessionId?: string): Promise<IChatSession> {
    this.ensureStarted()
    const session = await this.getSessionManagerInternal().createSession(sessionId)
    this.registerSessionInternal(session.id)
    return session
  }

  /**
   * Create a task-scoped child session for parallel execution.
   * The session gets its own sandbox, context manager, and LLM service.
   */
  public async createTaskSession(
    taskId: string,
    commandType: string,
    options?: {mapRootEligible?: boolean; userFacing?: boolean},
  ): Promise<string> {
    this.ensureStarted()
    const sessionMgr = this.getSessionManagerInternal()
    const parentSessionId = this.getSessionIdInternal()
    const childSession = await sessionMgr.createChildSession(
      parentSessionId,
      commandType,
      `task-${commandType}-${taskId}`,
    )

    // Only register as root-eligible when explicitly opted in.
    // Top-level executors that may call agentic_map (curate-executor,
    // folder-pack-executor) pass mapRootEligible: true.
    // For agentic_map sub-sessions (created by processItem), registration
    // is skipped here — processItem sets its own isRootCaller: false record.
    if (options?.mapRootEligible) {
      this.registerSessionInternal(childSession.id)
    }

    // Track user-facing sessions for post-session memory extraction.
    if (options?.userFacing) {
      this.userFacingTaskSessions.add(childSession.id)
    }

    return childSession.id
  }

  /**
   * Delete a sandbox variable from the agent's default session.
   */
  public deleteSandboxVariable(key: string): void {
    this.ensureStarted()
    const sessionId = this.getSessionIdInternal()
    this.services!.sandboxService.deleteSandboxVariable(sessionId, key)
  }

  /**
   * Delete a sandbox variable from a specific session's sandbox.
   */
  public deleteSandboxVariableOnSession(sessionId: string, key: string): void {
    this.ensureStarted()
    this.services!.sandboxService.deleteSandboxVariable(sessionId, key)
  }

  /**
   * Delete a session completely (memory + history).
   */
  public async deleteSession(sessionId: string): Promise<boolean> {
    this.ensureStarted()

    // Clear session config overrides
    if (this.stateManager) {
      this.stateManager.clearSessionOverride(sessionId)
    }

    const deleted = await this.getSessionManagerInternal().deleteSession(sessionId)
    if (deleted && this.rootEligibleSessions.has(sessionId)) {
      // Deregister only if this agent instance owns the session.
      // Scoping prevents one agent's teardown from removing another
      // agent's live record when they share a session ID.
      deregisterRootEligibleSession(sessionId, this._instanceId)
      this.rootEligibleSessions.delete(sessionId)
    }

    return deleted
  }

  /**
   * Delete a task session and all its resources (sandbox + history).
   */
  public async deleteTaskSession(sessionId: string): Promise<void> {
    this.ensureStarted()

    // Compress memories for user-facing sessions before disposal (fail-open).
    if (this.userFacingTaskSessions.has(sessionId) && this.sessionCompressor) {
      try {
        // Refresh OAuth token and rebuild compressor before compression
        if (this._transportClient && this.services) {
          try {
            await this.refreshSessionCompressorFromTransport()
          } catch {
            // Fail-open: use existing compressor with potentially stale token
          }
        }

        const session = this.getSessionManagerInternal().getSession(sessionId)
        if (session) {
          const messages = session.getLLMService().getContextManager().getComprehensiveMessages()
          const commandType = this.getSessionManagerInternal().getSessionCommandType(sessionId) ?? 'curate'
          // Task sessions often contain a compact prompt/response trace, so use a
          // lower threshold than the interactive default to preserve useful memories.
          await this.sessionCompressor.compress(messages, commandType, {minMessages: 2}).catch((error) => {
            const msg = error instanceof Error ? error.message : String(error)
            console.debug(`[CipherAgent] Session compression failed for ${sessionId}: ${msg}`)
          })
        }
      } catch (error) {
        // Fail-open: synchronous errors in the session accessor chain (e.g. corrupted
        // session state) must not prevent clearSession + deleteSession from running.
        const msg = error instanceof Error ? error.message : String(error)
        console.debug(`[CipherAgent] Session compression setup failed for ${sessionId}: ${msg}`)
      }

      this.userFacingTaskSessions.delete(sessionId)
    }

    await this.services!.sandboxService.clearSession(sessionId)
    await this.getSessionManagerInternal().deleteSession(sessionId)

    // Deregister root-eligible record if this agent owns it.
    // For agentic_map sub-sessions, the record was overwritten to isRootCaller: false
    // by processItem, so deregisterRootEligibleSession is a no-op (correct).
    if (this.rootEligibleSessions.has(sessionId)) {
      deregisterRootEligibleSession(sessionId, this._instanceId)
      this.rootEligibleSessions.delete(sessionId)
    }
  }

  /**
   * Wait for shared background work (such as abstract generation) to finish.
   * Used by task executors before reporting task completion.
   */
  public async drainBackgroundWork(): Promise<void> {
    this.ensureStarted()
    await this.drainAbstractQueue()
  }

  /**
   * Execute the agent with user input.
   * Uses the agent's default session (created during start()).
   * Internally uses generate() for single code path maintainability.
   *
   * @param input - User message
   * @param options - Optional execution options
   * @param options.executionContext - Optional execution context
   * @param options.taskId - Optional task ID for concurrent task isolation
   */
  public async execute(
    input: string,
    options?: {executionContext?: ExecutionContext; taskId?: string},
  ): Promise<string> {
    this.ensureStarted()

    // Use generate() internally for single code path
    const response = await this.generate(input, {
      executionContext: options?.executionContext,
      taskId: options?.taskId,
    })

    return response.content
  }

  /**
   * Execute the agent on a specific session (not the default session).
   * Used for per-task session isolation in parallel execution.
   */
  public async executeOnSession(
    sessionId: string,
    input: string,
    options?: {executionContext?: ExecutionContext; signal?: AbortSignal; taskId?: string},
  ): Promise<string> {
    this.ensureStarted()

    const response = await this.generate(input, {
      executionContext: options?.executionContext,
      sessionId,
      signal: options?.signal,
      taskId: options?.taskId,
    })

    return response.content
  }

  /**
   * Generate a complete response (waits for full completion).
   * Wrapper around stream() that collects all events and returns final result.
   * Uses the agent's default session (created during start()).
   *
   * @param input - User message
   * @param options - Optional configuration (signal for cancellation, taskId for billing)
   * @returns Complete response with content, usage, and tool calls
   */
  public async generate(input: string, options?: StreamOptions): Promise<GenerateResponse> {
    const sessionId = this.getSessionIdInternal()

    // Collect all events from stream
    const events: StreamingEvent[] = []

    for await (const event of await this.stream(input, options)) {
      events.push(event)
    }

    // Check for non-recoverable error events
    const fatalErrorEvent = events.find(
      (e): e is Extract<StreamingEvent, {name: 'llmservice:error'}> =>
        e.name === 'llmservice:error' && e.recoverable !== true,
    )
    if (fatalErrorEvent) {
      throw new Error(fatalErrorEvent.error)
    }

    // Find the final response event
    const responseEvent = events.find((e) => e.name === 'llmservice:response')
    if (!responseEvent || responseEvent.name !== 'llmservice:response') {
      throw new Error('Stream did not complete successfully - no response received')
    }

    // Collect tool calls
    const toolCallEvents = events.filter(
      (e): e is Extract<StreamingEvent, {name: 'llmservice:toolCall'}> => e.name === 'llmservice:toolCall',
    )
    const toolResultEvents = events.filter(
      (e): e is Extract<StreamingEvent, {name: 'llmservice:toolResult'}> => e.name === 'llmservice:toolResult',
    )

    const toolCalls = toolCallEvents.map((tc) => {
      const toolResult = toolResultEvents.find((tr) => tr.callId === tc.callId)
      return {
        args: tc.args,
        callId: tc.callId ?? `tool_${Date.now()}`,
        result: toolResult ? {data: toolResult.result, success: toolResult.success} : undefined,
        toolName: tc.toolName,
      }
    })

    const defaultUsage = {inputTokens: 0, outputTokens: 0, totalTokens: 0}

    return {
      content: responseEvent.content,
      reasoning: responseEvent.reasoning,
      sessionId,
      toolCalls,
      usage: responseEvent.tokenUsage ?? defaultUsage,
    }
  }

  /**
   * Get an existing session or create a new one.
   */
  public async getOrCreateSession(sessionId: string): Promise<IChatSession> {
    this.ensureStarted()
    const sessionMgr = this.getSessionManagerInternal()
    const existingSession = sessionMgr.getSession(sessionId)
    if (existingSession) return existingSession
    const newSession = await sessionMgr.createSession(sessionId)
    this.registerSessionInternal(newSession.id) // only on actual creation
    return newSession
  }

  /**
   * Get a session by ID.
   */
  public getSession(sessionId: string): IChatSession | undefined {
    this.ensureStarted()
    return this.getSessionManagerInternal().getSession(sessionId)
  }

  /**
   * Get session metadata without loading full history.
   */
  public async getSessionMetadata(
    sessionId: string,
  ): Promise<import('../../core/domain/storage/history-types.js').SessionMetadata | undefined> {
    this.ensureStarted()
    return this.getHistoryStorageInternal().getSessionMetadata(sessionId)
  }

  /**
   * Get current agent state.
   * Returns default state if agent is not yet started.
   */
  public getState(): AgentState {
    // Return default state if not started yet (for backward compatibility)
    if (!this.stateManager) {
      return {
        currentIteration: 0,
        executionHistory: [],
        executionState: 'idle',
        toolCallsExecuted: 0,
      }
    }

    return this.stateManager.getExecutionState()
  }

  /**
   * Get the current system prompt.
   */
  public async getSystemPrompt(): Promise<string> {
    this.ensureStarted()
    return this.getSystemPromptManagerInternal().build({})
  }

  protected override async initializeServices(): Promise<CipherAgentServices> {
    // Pass pre-created event bus to service initializer
    return createCipherAgentServices(this.config, this._agentEventBus)
  }

  /**
   * List all persisted session IDs from history storage.
   */
  public async listPersistedSessions(): Promise<string[]> {
    this.ensureStarted()
    return this.getHistoryStorageInternal().listSessions()
  }

  /**
   * List all session IDs (in-memory only).
   */
  public listSessions(): string[] {
    this.ensureStarted()
    return this.getSessionManagerInternal().listSessions()
  }

  /**
   * Hot-swap the provider/model configuration by rebuilding the SessionManager.
   * Called by agent-process when a provider:updated event is received.
   *
   * Safety: this is called at the start of executeTask (before LLM calls), and
   * the task queue is sequential (max concurrency = 1), so no concurrent task
   * can be using the old SessionManager when this runs.
   *
   * @param providerUpdate - New provider configuration from daemon state server
   */
  public refreshProviderConfig(providerUpdate: ProviderUpdateConfig): void {
    this.ensureStarted()

    const services = this.getServices()
    const httpConfig = this.buildHttpConfig()

    // Build new LLM config with updated provider fields
    const sessionLLMConfig = {
      httpReferer: this.config.httpReferer,
      maxInputTokens: providerUpdate.maxInputTokens,
      maxIterations: this.config.llm.maxIterations,
      maxTokens: this.config.llm.maxTokens,
      model: providerUpdate.model,
      openRouterApiKey: providerUpdate.openRouterApiKey,
      provider: providerUpdate.provider,
      providerApiKey: providerUpdate.providerApiKey,
      providerBaseUrl: providerUpdate.providerBaseUrl,
      providerHeaders: providerUpdate.providerHeaders,
      requestTimeoutMs: getAgentSettingValue(SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS),
      siteName: this.config.siteName,
      temperature: this.config.llm.temperature,
      timeout: getAgentSettingValue(SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS),
      verbose: this.config.llm.verbose,
    }

    // Create new SessionManager FIRST — if this throws, old SM remains intact
    const newSessionManager = new SessionManager(services, httpConfig, sessionLLMConfig, {
      config: {
        maxSessions: this.config.sessions.maxSessions,
        sessionTTL: this.config.sessions.sessionTTL,
      },
      onSessionRemoved: (sessionId) => {
        this.handleSessionRemoved(sessionId)
      },
    })

    // Success — dispose old and swap.
    // Deregister all root-eligible sessions from the old SM first —
    // they no longer exist after dispose(). The next stream()/execute()
    // will recreate sessions via getOrCreateSession and re-register them.
    if (this.sessionManager) {
      for (const sid of this.rootEligibleSessions) {
        deregisterRootEligibleSession(sid, this._instanceId)
      }

      this.rootEligibleSessions.clear()
      this.sessionManager.dispose()
    }

    this.sessionManager = newSessionManager

    // Re-wire SessionManager into sandbox for tools.agentQuery()
    this.services!.sandboxService.setSessionManager?.(this.sessionManager)

    // Rebind map tools with fresh generator/tokenizer/maxContextTokens
    this.rebindMapTools(services, httpConfig, sessionLLMConfig)

    // Rebind curate tools with fresh generator + abstract queue
    this.rebindCurateTools(services, httpConfig, sessionLLMConfig)
  }

  /**
   * Reset the agent to initial state.
   * Resets execution state only. To reset sessions, use resetSession(sessionId).
   */
  public reset(): void {
    // Reset execution state (only if state manager exists - may not if not started)
    if (this.stateManager) {
      this.stateManager.reset()
    }
  }

  // === Protected Methods (implement abstract from BaseAgent) ===

  /**
   * Reset a specific session's conversation history.
   * @param sessionId - The session ID to reset
   */
  public async resetSession(sessionId: string): Promise<void> {
    const session = this.getSessionManagerInternal().getSession(sessionId)
    if (session) {
      await session.reset()
    }

    // Emit conversation reset event (only if agent is started)
    if (this._isStarted && this.services?.agentEventBus) {
      this.services.agentEventBus.emit('cipher:conversationReset', {sessionId})
    }
  }

  /**
   * Set a variable in the agent's default session sandbox.
   */
  public setSandboxVariable(key: string, value: unknown): void {
    this.ensureStarted()
    const sessionId = this.getSessionIdInternal()
    this.services!.sandboxService.setSandboxVariable(sessionId, key, value)
  }

  /**
   * Set a variable in a specific session's sandbox.
   */
  public setSandboxVariableOnSession(sessionId: string, key: string, value: unknown): void {
    this.ensureStarted()
    this.services!.sandboxService.setSandboxVariable(sessionId, key, value)
  }

  /**
   * Setup per-task event forwarding via TransportEventBridge.
   * Registers listeners on AgentEventBus that forward llmservice:* events
   * matching the given taskId to the transport server.
   *
   * Only effective when a transport client is injected (child process mode).
   *
   * @param taskId - Task ID to filter events by
   * @returns Cleanup function that removes listeners, or undefined if no bridge
   */
  public setupTaskForwarding(taskId: string): (() => void) | undefined {
    return this.eventBridge?.setupForTask(taskId)
  }

  /**
   * Start the agent - initializes all services asynchronously.
   * Must be called before execute().
   */
  public override async start(): Promise<void> {
    // Call parent start (creates services)
    await super.start()

    // Create SessionManager with shared services
    const services = this.getServices()

    const httpConfig = this.buildHttpConfig()

    // Extract LLM config for sessions
    const sessionLLMConfig = {
      httpReferer: this.config.httpReferer,
      maxInputTokens: this.config.maxInputTokens,
      maxIterations: this.config.llm.maxIterations,
      maxTokens: this.config.llm.maxTokens,
      model: this.config.model,
      openRouterApiKey: this.config.openRouterApiKey,
      provider: this.config.provider,
      providerApiKey: this.config.providerApiKey,
      providerBaseUrl: this.config.providerBaseUrl,
      providerHeaders: this.config.providerHeaders,
      requestTimeoutMs: getAgentSettingValue(SETTINGS_KEYS.LLM_REQUEST_TIMEOUT_MS),
      siteName: this.config.siteName,
      temperature: this.config.llm.temperature,
      timeout: getAgentSettingValue(SETTINGS_KEYS.LLM_ITERATION_BUDGET_MS),
      verbose: this.config.llm.verbose,
    }

    // Create SessionManager
    this.sessionManager = new SessionManager(services, httpConfig, sessionLLMConfig, {
      config: {
        maxSessions: this.config.sessions.maxSessions,
        sessionTTL: this.config.sessions.sessionTTL,
      },
      onSessionRemoved: (sessionId) => {
        this.handleSessionRemoved(sessionId)
      },
    })

    // Wire SessionManager into sandbox for tools.agentQuery() sub-agent delegation
    this.services!.sandboxService.setSessionManager?.(this.sessionManager)

    // Create default session (Single-Session pattern)
    // Each agent has exactly 1 session created at start time
    const defaultSession = await this.sessionManager.createSession()
    this._sessionId = defaultSession.id
    this.registerSessionInternal(defaultSession.id)

    // Inject agent instance and content generator into ToolProvider for map tools.
    // Uses rebindMapTools() which atomically replaces map tools with fresh deps
    // (generator, tokenizer, maxContextTokens, logger).
    this.rebindMapTools(services, httpConfig, sessionLLMConfig)

    // Wire abstract generation queue with curate generator + rebuild curate service.
    this.rebindCurateTools(services, httpConfig, sessionLLMConfig)

    // Create event bridge if transport client is injected (child process mode).
    // The bridge forwards AgentEventBus llmservice:* events to the transport server.
    if (this._transportClient) {
      this.eventBridge = new TransportEventBridge({
        eventBus: this._agentEventBus,
        transport: this._transportClient,
      })
    }
  }

  /**
   * Stream a response with real-time event emission.
   * Uses the agent's default session (created during start()).
   *
   * @param input - User message
   * @param options - Optional configuration (signal for cancellation, taskId for billing)
   * @returns AsyncIterator that yields StreamingEvent objects
   */
  public async stream(input: string, options?: StreamOptions): Promise<AsyncIterableIterator<StreamingEvent>> {
    this.ensureStarted()

    // Use provided sessionId (per-task session) or fall back to default session
    const sessionId = options?.sessionId ?? this.getSessionIdInternal()

    const signal = options?.signal

    // Event queue for aggregation
    const eventQueue: StreamingEvent[] = []
    let completed = false

    // Create AbortController for cleanup
    const controller = new AbortController()
    const cleanupSignal = controller.signal

    // Store controller so cancel() can abort this stream (keyed by sessionId)
    this.activeStreamControllers.set(sessionId, controller)

    // Increase listener limit - stream() registers many event listeners
    setMaxListeners(30, cleanupSignal)

    // Track listener references for manual cleanup
    const listeners: Array<{
      event: string
      listener: (payload?: unknown) => void
    }> = []

    // Get the agent event bus
    const agentEventBus = this.services?.agentEventBus
    if (!agentEventBus) {
      throw AgentError.serviceNotInitialized('AgentEventBus')
    }

    // Cleanup function to remove all listeners and stream controller
    const cleanupListeners = () => {
      if (listeners.length === 0) {
        return // Already cleaned up
      }

      for (const {event, listener} of listeners) {
        agentEventBus.off(event as keyof typeof agentEventBus, listener)
      }

      listeners.length = 0
      // Remove from active controllers map
      this.activeStreamControllers.delete(sessionId)
    }

    // Wire external signal to trigger cleanup
    if (signal) {
      const abortHandler = () => {
        cleanupListeners()
        controller.abort()
      }

      signal.addEventListener('abort', abortHandler, {once: true})
    }

    // Subscribe to streaming events (filter by sessionId - ChatSession.id)
    for (const eventName of STREAMING_EVENT_NAMES) {
      const listener = (payload: unknown) => {
        const data = payload as {sessionId?: string}
        if (data.sessionId !== sessionId) return

        // Add event to queue with name discriminant
        eventQueue.push({name: eventName, ...data} as StreamingEvent)

        // Close iterator on run:complete
        if (eventName === 'run:complete') {
          completed = true
        }
      }

      agentEventBus.on(eventName, listener, {signal: cleanupSignal})
      listeners.push({event: eventName, listener})
    }

    // Start streaming in background (fire-and-forget)
    ;(async () => {
      try {
        // Get or create session using the provided sessionId
        // ChatSession maintains conversation history
        const sessionMgr = this.getSessionManagerInternal()
        const existingSession = sessionMgr.getSession(sessionId)
        const session = existingSession ?? (await sessionMgr.createSession(sessionId))
        if (!existingSession) {
          this.registerSessionInternal(session.id) // only on actual creation
        }

        // Increment iteration counter
        this.getStateManager().incrementIteration()

        // Call session.streamRun() which emits events and run:complete
        // Pass taskId for concurrent task isolation (included in all emitted events)
        await session.streamRun(input, {
          executionContext: options?.executionContext,
          signal,
          taskId: options?.taskId,
        })
      } catch (error_) {
        // Emit error event if something goes wrong
        completed = true
        const error = error_ instanceof Error ? error_ : new Error(String(error_))

        eventQueue.push({
          code: undefined,
          error: error.message,
          name: 'llmservice:error',
          recoverable: false,
          sessionId,
        })
      }
    })()

    // Resolve function for waiting - will be called when new events arrive
    let notifyNewEvent: (() => void) | null = null

    // Wrap the original listener to also notify waiters
    const originalListeners = [...listeners]
    listeners.length = 0

    for (const {event, listener: originalListener} of originalListeners) {
      const wrappedListener = (payload: unknown) => {
        originalListener(payload)
        // Notify any waiting next() call
        if (notifyNewEvent) {
          notifyNewEvent()
          notifyNewEvent = null
        }
      }

      agentEventBus.off(event as keyof AgentEventMap, originalListener)
      agentEventBus.on(event as keyof AgentEventMap, wrappedListener, {signal: cleanupSignal})
      listeners.push({event, listener: wrappedListener})
    }

    // Return async iterable iterator
    const iterator: AsyncIterableIterator<StreamingEvent> = {
      async next(): Promise<IteratorResult<StreamingEvent>> {
        // If we already have events, return immediately
        if (eventQueue.length > 0) {
          return {done: false, value: eventQueue.shift()!}
        }

        // If already completed, cleanup and return
        if (completed) {
          cleanupListeners()
          return {done: true, value: undefined}
        }

        // Check for abort
        if (signal?.aborted || cleanupSignal.aborted) {
          cleanupListeners()
          return {done: true, value: undefined}
        }

        // Wait for new events
        await new Promise<void>((resolve) => {
          notifyNewEvent = resolve

          // Also resolve on abort
          const abortHandler = () => {
            notifyNewEvent = null
            resolve()
          }

          cleanupSignal.addEventListener('abort', abortHandler, {once: true})
          if (signal) {
            signal.addEventListener('abort', abortHandler, {once: true})
          }
        })

        // After waiting, check state again
        if (signal?.aborted || cleanupSignal.aborted) {
          cleanupListeners()
          return {done: true, value: undefined}
        }

        if (eventQueue.length > 0) {
          return {done: false, value: eventQueue.shift()!}
        }

        if (completed) {
          cleanupListeners()
          return {done: true, value: undefined}
        }

        // Recursive call to handle edge cases
        return iterator.next()
      },

      async return(): Promise<IteratorResult<StreamingEvent>> {
        // Called when consumer breaks out early or explicitly calls return()
        cleanupListeners()
        controller.abort()
        return {done: true, value: undefined}
      },

      [Symbol.asyncIterator]() {
        return iterator
      },
    }

    return iterator
  }

  /**
   * Switch the default session to a different session ID.
   * The session must already exist (created via createSession).
   *
   * @param sessionId - The session ID to switch to
   * @throws Error if session does not exist
   */
  public switchDefaultSession(sessionId: string): void {
    this.ensureStarted()

    // Verify the session exists
    const session = this.getSessionManagerInternal().getSession(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} does not exist. Create it first with createSession().`)
    }

    this._sessionId = sessionId
  }

  /**
   * Build HTTP config for ByteRover API calls.
   * Uses lazy providers when injected (child process mode), otherwise static config.
   */
  private buildHttpConfig(): ByteRoverHttpConfig {
    return {
      apiBaseUrl: this.config.apiBaseUrl,
      projectId: this._projectIdProvider ?? this.config.projectId,
      region: this.config.region,
      sessionKey: this._sessionKeyProvider ?? this.config.sessionKey,
      spaceId: this._spaceIdProvider ?? this.config.spaceId ?? this._brvConfig?.spaceId ?? '',
      teamId: this._teamIdProvider ?? this.config.teamId ?? this._brvConfig?.teamId ?? '',
    }
  }

  // === Private Helpers (alphabetical order) ===

  private createFreshRetryableGenerator(
    fresh: ProviderConfigResponse,
    options: {
      httpConfig: ByteRoverHttpConfig
      httpReferer?: string
      modelFallback: string
      siteName?: string
    },
  ): RetryableContentGenerator | undefined {
    if (fresh.providerKeyMissing || !fresh.activeProvider) {
      return
    }

    const provider = fresh.provider ?? (fresh.openRouterApiKey ? 'openrouter' : 'byterover')
    const freshGenerator = createGeneratorForProvider(provider, {
      apiKey: provider === 'openrouter'
        ? (fresh.openRouterApiKey ?? fresh.providerApiKey)
        : fresh.providerApiKey,
      baseUrl: fresh.providerBaseUrl,
      headers: fresh.providerHeaders,
      httpConfig: options.httpConfig as unknown as Record<string, unknown>,
      httpReferer: options.httpReferer,
      maxTokens: 4096,
      model: fresh.activeModel ?? options.modelFallback,
      siteName: options.siteName,
      temperature: 0,
    })

    return new RetryableContentGenerator(freshGenerator, {policy: DEFAULT_RETRY_POLICY})
  }

  private async drainAbstractQueue(): Promise<void> {
    const abstractQueue = this.services?.abstractQueue
    if (!abstractQueue) {
      return
    }

    const settleDeadline = Date.now() + 5000
    let idleSince: number | undefined
    let pass = 0

    /* eslint-disable no-await-in-loop */
    while (Date.now() <= settleDeadline) {
      pass++
      if (QUEUE_TRACE_ENABLED) {
        agentLog(`drainAbstractQueue:pass:${pass}:start`)
      }

      await abstractQueue.drain()
      const status = abstractQueue.getStatus()
      if (QUEUE_TRACE_ENABLED) {
        agentLog(`drainAbstractQueue:pass:${pass}:status pending=${status.pending} processing=${status.processing} processed=${status.processed} failed=${status.failed}`)
      }

      if (!status.processing && status.pending === 0) {
        idleSince ??= Date.now()
        if (Date.now() - idleSince >= 250) {
          if (QUEUE_TRACE_ENABLED) {
            agentLog(`drainAbstractQueue:settled pass=${pass}`)
          }

          return
        }
      } else {
        idleSince = undefined
      }

      await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
    }
    /* eslint-enable no-await-in-loop */

    if (QUEUE_TRACE_ENABLED) {
      agentLog('drainAbstractQueue:deadline-reached')
    }
  }

  private getHistoryStorageInternal(): IHistoryStorage {
    const storage = this.services?.historyStorage
    if (!storage) {
      throw AgentError.serviceNotInitialized('HistoryStorage')
    }

    return storage
  }

  private getSessionIdInternal(): string {
    if (!this._sessionId) {
      throw AgentError.serviceNotInitialized('Session (call start() first)')
    }

    return this._sessionId
  }

  private getSessionManagerInternal(): SessionManager {
    if (!this.sessionManager) {
      throw AgentError.serviceNotInitialized('SessionManager')
    }

    return this.sessionManager
  }

  private getSystemPromptManagerInternal(): SystemPromptManager {
    const manager = this.services?.systemPromptManager
    if (!manager) {
      throw AgentError.serviceNotInitialized('SystemPromptManager')
    }

    return manager
  }

  /**
   * Handle SessionManager lifecycle removals (delete/end/TTL-expire) and keep
   * root-eligible tracking synchronized with the global nesting registry.
   */
  private handleSessionRemoved(sessionId: string): void {
    if (!this.rootEligibleSessions.has(sessionId)) return
    deregisterRootEligibleSession(sessionId, this._instanceId)
    this.rootEligibleSessions.delete(sessionId)
  }

  /**
   * Rebuild map tool dependencies and update ToolProvider + SandboxService.
   * Called from both start() (initial setup) and refreshProviderConfig() (hot-swap).
   */
  private rebindCurateTools(
    services: CipherAgentServices,
    httpConfig: ByteRoverHttpConfig,
    sessionLLMConfig: SessionLLMConfig,
  ): void {
    const curateProvider = sessionLLMConfig.provider
      ?? (sessionLLMConfig.openRouterApiKey ? 'openrouter' : 'byterover')
    const curateGenerator = createGeneratorForProvider(curateProvider, {
      apiKey: curateProvider === 'openrouter'
        ? (sessionLLMConfig.openRouterApiKey ?? sessionLLMConfig.providerApiKey)
        : sessionLLMConfig.providerApiKey,
      baseUrl: sessionLLMConfig.providerBaseUrl,
      headers: sessionLLMConfig.providerHeaders,
      httpConfig: httpConfig as unknown as Record<string, unknown>,
      httpReferer: sessionLLMConfig.httpReferer,
      maxTokens: 4096,
      model: sessionLLMConfig.model,
      siteName: sessionLLMConfig.siteName,
      temperature: 0,
    })

    // Wrap with retry for background resilience (no event bus — background tasks have no UI)
    const retryableCurateGenerator = new RetryableContentGenerator(curateGenerator, {
      policy: DEFAULT_RETRY_POLICY,
    })

    // Wire generator into the abstract queue so background generation can proceed
    services.abstractQueue.setGenerator(retryableCurateGenerator)

    // Refresh OAuth token before each background generation (tokens expire between tasks)
    if (this._transportClient) {
      const transportClient = this._transportClient
      services.abstractQueue.setBeforeProcess(async () => {
        const fresh = await transportClient.requestWithAck<ProviderConfigResponse>(
          TransportStateEventNames.GET_PROVIDER_CONFIG,
        )
        const retryableFreshGenerator = this.createFreshRetryableGenerator(fresh, {
          httpConfig,
          httpReferer: sessionLLMConfig.httpReferer,
          modelFallback: sessionLLMConfig.model,
          siteName: sessionLLMConfig.siteName,
        })
        if (!retryableFreshGenerator) {
          return
        }

        services.abstractQueue.setGenerator(retryableFreshGenerator)
      })
    }

    // Rebuild sandbox CurateService with the queue — reuses existing hot-swap path.
    // runtimeSignalStore is threaded so agent-driven curate ADD/UPDATE seed +
    // bump the sidecar (matches the tool-registry wiring at construction time).
    const newCurateService = createCurateService(
      services.workingDirectory,
      services.abstractQueue,
      services.runtimeSignalStore,
    )
    services.sandboxService.setCurateService?.(newCurateService)

    // Atomically rebuild CURATE + INGEST_RESOURCE tools so both enqueue abstracts
    services.toolProvider.replaceTools(
      [ToolName.CURATE, ToolName.INGEST_RESOURCE],
      {abstractQueue: services.abstractQueue, contentGenerator: retryableCurateGenerator},
    )

    // Rebuild session compressor with the new generator (used in deleteTaskSession)
    const deduplicator = new MemoryDeduplicator(retryableCurateGenerator)
    this.sessionCompressor = new SessionCompressor(deduplicator, retryableCurateGenerator, services.memoryManager)
  }

  private rebindMapTools(
    services: CipherAgentServices,
    httpConfig: ByteRoverHttpConfig,
    sessionLLMConfig: SessionLLMConfig,
  ): void {
    const mapProvider = sessionLLMConfig.provider
      ?? (sessionLLMConfig.openRouterApiKey ? 'openrouter' : 'byterover')
    const mapGenerator = createGeneratorForProvider(mapProvider, {
      apiKey: mapProvider === 'openrouter'
        ? (sessionLLMConfig.openRouterApiKey ?? sessionLLMConfig.providerApiKey)
        : sessionLLMConfig.providerApiKey,
      baseUrl: sessionLLMConfig.providerBaseUrl,
      headers: sessionLLMConfig.providerHeaders,
      httpConfig: httpConfig as unknown as Record<string, unknown>,
      httpReferer: sessionLLMConfig.httpReferer,
      maxTokens: 4096,
      model: sessionLLMConfig.model,
      siteName: sessionLLMConfig.siteName,
      temperature: 0,
    })

    // Adapter pattern: wrap mapGenerator.estimateTokensSync() as ITokenizer
    const mapTokenizer: ITokenizer = {
      countTokens: (text: string) => mapGenerator.estimateTokensSync(text),
    }

    // Compute registry-clamped maxContextTokens
    const mapModel = sessionLLMConfig.model ?? 'gemini-3-flash-preview'
    const mapRegistryProvider = resolveRegistryProvider(mapModel, mapProvider)
    const effectiveMaxContextTokens = getEffectiveMaxInputTokens(
      mapRegistryProvider, mapModel, sessionLLMConfig.maxInputTokens,
    )

    const mapLogger = new EventBasedLogger(this._agentEventBus, 'MapTools')

    // Atomically replace map tools with fresh generator/tokenizer/maxContextTokens.
    // replaceTools() is build-then-swap — if build fails, old tools remain intact.
    services.toolProvider.replaceTools(
      [ToolName.LLM_MAP, ToolName.AGENTIC_MAP],
      {
        agentInstance: this,
        contentGenerator: mapGenerator,
        logger: mapLogger,
        maxContextTokens: effectiveMaxContextTokens,
        tokenizer: mapTokenizer,
      },
    )

    // Update sandbox for tools.curation.mapExtract()
    services.sandboxService.setContentGenerator?.(mapGenerator)
  }

  private async refreshSessionCompressorFromTransport(): Promise<void> {
    if (!this._transportClient || !this.services) {
      return
    }

    const fresh = await this._transportClient.requestWithAck<ProviderConfigResponse>(
      TransportStateEventNames.GET_PROVIDER_CONFIG,
    )
    const retryable = this.createFreshRetryableGenerator(fresh, {
      httpConfig: this.buildHttpConfig(),
      httpReferer: this.config.httpReferer,
      modelFallback: this.stateManager?.getModel() ?? this.config.model,
      siteName: this.config.siteName,
    })
    if (!retryable) {
      return
    }

    const deduplicator = new MemoryDeduplicator(retryable)
    this.sessionCompressor = new SessionCompressor(deduplicator, retryable, this.services.memoryManager)
  }

  /**
   * Register a session as root-eligible and track it for lifecycle cleanup.
   * Routes all root-eligible registrations through a single point.
   */
  private registerSessionInternal(sessionId: string): void {
    registerRootEligibleSession(sessionId, this._instanceId) // throws if id is a live sub-session record
    this.rootEligibleSessions.add(sessionId)
  }
}
