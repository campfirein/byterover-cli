import {randomUUID} from 'node:crypto'

import type {CipherAgentServices, SessionManagerConfig} from '../../core/interfaces/cipher-services.js'
import type {IChatSession} from '../../core/interfaces/i-chat-session.js'
import type {FileSystemService} from '../file-system/file-system-service.js'

import {type ByteRoverHttpConfig, createSessionServices} from '../agent/service-initializer.js'
import {CoreToolScheduler} from '../tools/core-tool-scheduler.js'
import {DEFAULT_POLICY_RULES} from '../tools/default-policy-rules.js'
import {PolicyEngine} from '../tools/policy-engine.js'
import {ToolManager} from '../tools/tool-manager.js'
import {ToolProvider} from '../tools/tool-provider.js'
import {ChatSession} from './chat-session.js'
import {generateSessionTitle} from './title-generator.js'

/**
 * Service overrides for creating sessions with custom services.
 * Used to create restricted sessions (e.g., context-tree only search).
 */
export interface SessionServiceOverrides {
  /**
   * Custom file system service to use for this session.
   * If provided, a new ToolProvider and ToolManager will be created
   * using this file system service instead of the shared one.
   */
  fileSystemService?: FileSystemService
}

/**
 * Metadata about a session for listing purposes.
 */
export interface SessionMetadata {
  /** Name of the agent running this session (e.g., 'plan', 'query', 'curate') */
  agentName?: string
  createdAt: number
  id: string
  lastActivity: number
  messageCount: number
  /** Parent session ID for subagent sessions */
  parentId?: string
  title?: string
}

/**
 * Options for SessionManager constructor
 */
export type SessionRemovalReason = 'deleted' | 'ended' | 'ttl_expired'

export interface SessionManagerOptions {
  config?: SessionManagerConfig
  /**
   * Optional lifecycle callback fired after a session is removed from memory maps.
   * Used by CipherAgent to synchronize external registries (e.g., nesting registry).
   */
  onSessionRemoved?: (sessionId: string, reason: SessionRemovalReason) => void
}

/**
 * Session manager.
 *
 * Manages multiple chat sessions with creation, retrieval, and deletion.
 * Each session gets its own LLM service instance with isolated context.
 * and creates session-specific services (LLM, EventBus) per conversation.
 */
export class SessionManager {
  private cleanupTimer?: ReturnType<typeof setInterval>
  private readonly config: Required<SessionManagerConfig>
  private readonly httpConfig: ByteRoverHttpConfig
  private readonly llmConfig: {
    httpReferer?: string
    maxIterations?: number
    maxTokens?: number
    model: string
    openRouterApiKey?: string
    provider?: string
    providerApiKey?: string
    providerBaseUrl?: string
    providerHeaders?: Record<string, string>
    requestTimeoutMs?: number
    siteName?: string
    temperature?: number
    timeout?: number
    verbose?: boolean
  }
  private readonly onSessionRemoved?: (sessionId: string, reason: SessionRemovalReason) => void
  private pendingCreations = new Map<string, Promise<IChatSession>>()
  /** Agent name for each session (e.g., 'plan', 'query', 'curate') */
  private readonly sessionAgentNames: Map<string, string> = new Map()
  private readonly sessionCreatedAt: Map<string, number> = new Map()
  private readonly sessionLastActivity: Map<string, number> = new Map()
  /** Parent session ID for subagent sessions */
  private readonly sessionParentIds: Map<string, string> = new Map()
  private readonly sessions: Map<string, IChatSession> = new Map()
  private readonly sessionTitles: Map<string, string> = new Map()
  private readonly sharedServices: CipherAgentServices

  /**
   * Creates a new session manager
   *
   * @param sharedServices - Shared services from CipherAgent (ToolManager, SystemPromptManager, etc.)
   * @param httpConfig - HTTP client configuration
   * @param llmConfig - LLM service configuration
   * @param llmConfig.httpReferer - Optional HTTP Referer for OpenRouter rankings
   * @param llmConfig.maxIterations - Maximum iterations for agentic loop
   * @param llmConfig.maxTokens - Maximum output tokens
   * @param llmConfig.model - LLM model identifier
   * @param llmConfig.openRouterApiKey - Optional OpenRouter API key for direct service
   * @param llmConfig.provider - Optional direct provider ID (anthropic, openai, google, xai, groq, mistral)
   * @param llmConfig.providerApiKey - Optional API key for direct provider
   * @param llmConfig.providerBaseUrl - Optional base URL for OpenAI-compatible provider
   * @param llmConfig.providerHeaders - Optional custom headers for provider
   * @param llmConfig.siteName - Optional site name for OpenRouter rankings
   * @param llmConfig.temperature - Temperature for generation
   * @param llmConfig.verbose - Optional verbose debug output
   * @param options - Optional session manager options
   * @param options.config - Session manager configuration
   */
  public constructor(
    sharedServices: CipherAgentServices,
    httpConfig: ByteRoverHttpConfig,
    llmConfig: {
      httpReferer?: string
      maxIterations?: number
      maxTokens?: number
      model: string
      openRouterApiKey?: string
      provider?: string
      providerApiKey?: string
      providerBaseUrl?: string
      providerHeaders?: Record<string, string>
      requestTimeoutMs?: number
      siteName?: string
      temperature?: number
      timeout?: number
      verbose?: boolean
    },
    options?: SessionManagerOptions,
  ) {
    this.sharedServices = sharedServices
    this.httpConfig = httpConfig
    this.llmConfig = llmConfig
    this.onSessionRemoved = options?.onSessionRemoved
    this.config = {
      maxSessions: options?.config?.maxSessions ?? 100,
      sessionTTL: options?.config?.sessionTTL ?? 3_600_000, // 1 hour
    }

    // Start periodic cleanup (every 15 minutes or 1/4 TTL, whichever is smaller)
    const cleanupInterval = Math.min(15 * 60 * 1000, this.config.sessionTTL / 4)
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions().catch(() => {
        // Silently ignore cleanup errors
      })
    }, cleanupInterval)
  }

  /**
   * Create a child session for a subagent.
   * Child sessions are linked to their parent and have an agent name.
   *
   * @param parentId - Parent session ID
   * @param agentName - Name of the agent (e.g., 'query', 'curate')
   * @param sessionId - Optional session ID (generates one if not provided)
   * @returns New child chat session instance
   */
  public async createChildSession(parentId: string, agentName: string, sessionId?: string): Promise<IChatSession> {
    // Generate session ID if not provided
    const id = sessionId ?? `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Create the session using normal flow
    const session = await this.createSession(id)

    // Track parent-child relationship and agent name
    this.sessionParentIds.set(id, parentId)
    this.sessionAgentNames.set(id, agentName)

    return session
  }

  /**
   * Create a child session for a subagent with custom service overrides.
   * This is used to create sessions with restricted file system access
   * (e.g., context-tree only search for query commands).
   *
   * @param parentId - Parent session ID
   * @param agentName - Name of the agent (e.g., 'explore', 'curate')
   * @param sessionId - Optional session ID (generates one if not provided)
   * @param overrides - Service overrides (e.g., restricted FileSystemService)
   * @returns New child chat session instance with overridden services
   */
  public async createChildSessionWithOverrides(
    parentId: string,
    agentName: string,
    sessionId?: string,
    overrides?: SessionServiceOverrides,
  ): Promise<IChatSession> {
    // If no overrides, use the standard createChildSession
    if (!overrides?.fileSystemService) {
      return this.createChildSession(parentId, agentName, sessionId)
    }

    // Generate session ID if not provided
    const id = sessionId ?? `${agentName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

    // Check pending operations (race condition protection)
    if (this.pendingCreations.has(id)) {
      const pending = this.pendingCreations.get(id)

      if (!pending) {
        throw new Error(`Pending session ${id} not found. This is a bug.`)
      }

      return pending
    }

    // Check in-memory cache
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id)

      if (!existing) {
        throw new Error(`Session ${id} not found in cache. This is a bug.`)
      }

      return existing
    }

    // Check max sessions limit
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(
        `Maximum sessions (${this.config.maxSessions}) reached. Delete unused sessions or increase maxSessions limit.`,
      )
    }

    // Create with pending tracker
    const creationPromise = this.createSessionWithOverridesInternal(id, overrides)
    this.pendingCreations.set(id, creationPromise)

    try {
      const session = await creationPromise

      // Track parent-child relationship and agent name
      this.sessionParentIds.set(id, parentId)
      this.sessionAgentNames.set(id, agentName)

      return session
    } finally {
      this.pendingCreations.delete(id)
    }
  }

  /**
   * Create a new chat session.
   *
   * Each session gets its own LLM service instance for isolated conversation context.
   *
   * @param sessionId - Optional session ID (generates UUID if not provided)
   * @returns New or existing chat session instance
   */
  public async createSession(sessionId?: string): Promise<IChatSession> {
    const id = sessionId ?? randomUUID()

    // Check pending operations (race condition protection)
    if (this.pendingCreations.has(id)) {
      const pending = this.pendingCreations.get(id)

      if (!pending) {
        throw new Error(`Pending session ${id} not found. This is a bug.`)
      }

      return pending
    }

    // Check in-memory cache
    if (this.sessions.has(id)) {
      const existing = this.sessions.get(id)

      if (!existing) {
        throw new Error(`Session ${id} not found in cache. This is a bug.`)
      }

      return existing
    }

    // Check max sessions limit
    if (this.sessions.size >= this.config.maxSessions) {
      throw new Error(
        `Maximum sessions (${this.config.maxSessions}) reached. Delete unused sessions or increase maxSessions limit.`,
      )
    }

    // Create with pending tracker
    const creationPromise = this.createSessionInternal(id)
    this.pendingCreations.set(id, creationPromise)

    try {
      return await creationPromise
    } finally {
      this.pendingCreations.delete(id)
    }
  }

  /**
   * Delete a session completely (memory + history).
   *
   * @param id - Session ID to delete
   * @returns True if session existed and was deleted
   */
  public async deleteSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) {
      return false
    }

    // Clear session history
    await session.reset()

    // Dispose session to remove event listeners (prevents memory leak on repeated task sessions)
    session.dispose()

    // Clean up metadata maps
    this.sessionCreatedAt.delete(id)
    this.sessionLastActivity.delete(id)
    this.sessionTitles.delete(id)
    this.sessionAgentNames.delete(id)
    this.sessionParentIds.delete(id)

    // Remove from memory
    const deleted = this.sessions.delete(id)
    if (deleted) {
      try {
        this.onSessionRemoved?.(id, 'deleted')
      } catch {
        // Fail-open: session deletion must not fail due to callback errors
      }
    }

    return deleted
  }

  /**
   * Stop cleanup timer and dispose of all resources.
   * Call this when shutting down the session manager.
   *
   * IMPORTANT: This method now properly disposes all sessions to prevent
   * memory leaks from event forwarders and other session resources.
   */
  public dispose(): void {
    // Clear cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }

    // Dispose all sessions (prevents event forwarder leaks)
    for (const session of this.sessions.values()) {
      session.dispose()
    }

    this.sessions.clear()

    // Clear all metadata maps
    this.sessionCreatedAt.clear()
    this.sessionLastActivity.clear()
    this.sessionTitles.clear()
    this.sessionAgentNames.clear()
    this.sessionParentIds.clear()
    this.pendingCreations.clear()
  }

  /**
   * End a session (remove from memory, preserve history for future restoration).
   * Unlike deleteSession, this preserves the conversation history in storage
   * so the session can be restored later.
   *
   * @param id - Session ID to end
   * @returns True if session existed and was ended
   */
  public async endSession(id: string, reason: SessionRemovalReason = 'ended'): Promise<boolean> {
    const session = this.sessions.get(id)
    if (!session) {
      return false
    }

    // Ensure history is persisted before removing from memory
    const contextManager = session.getLLMService().getContextManager()
    await contextManager.flush()

    // Dispose session to remove event listeners (dispose calls cleanup internally)
    session.dispose()

    // Clean up metadata maps
    this.sessionCreatedAt.delete(id)
    this.sessionLastActivity.delete(id)
    this.sessionTitles.delete(id)
    this.sessionAgentNames.delete(id)
    this.sessionParentIds.delete(id)

    // Remove from memory only - history remains in storage
    const ended = this.sessions.delete(id)
    if (ended) {
      try {
        this.onSessionRemoved?.(id, reason)
      } catch {
        // Fail-open: session ending must not fail due to callback errors
      }
    }

    return ended
  }

  /**
   * Get a session by ID.
   *
   * @param id - Session ID
   * @returns Session instance or undefined if not found
   */
  public getSession(id: string): IChatSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * Get the command type (agent name) registered for a session.
   *
   * @param id - Session ID
   * @returns Command type string (e.g. 'curate', 'query') or undefined if not found
   */
  public getSessionCommandType(id: string): string | undefined {
    return this.sessionAgentNames.get(id)
  }

  /**
   * Get the number of active sessions.
   *
   * @returns Session count
   */
  public getSessionCount(): number {
    return this.sessions.size
  }

  /**
   * Check if a session exists.
   *
   * @param id - Session ID to check
   * @returns True if session exists
   */
  public hasSession(id: string): boolean {
    return this.sessions.has(id)
  }

  /**
   * List all session IDs.
   *
   * @returns Array of session IDs
   */
  public listSessions(): string[] {
    return [...this.sessions.keys()]
  }

  /**
   * List all sessions with metadata.
   * Returns sessions sorted by last activity (most recent first).
   *
   * @returns Array of session metadata
   */
  public listSessionsWithMetadata(): SessionMetadata[] {
    const sessions: SessionMetadata[] = []

    for (const [id, session] of this.sessions) {
      const contextManager = session.getLLMService().getContextManager()
      sessions.push({
        agentName: this.sessionAgentNames.get(id),
        createdAt: this.sessionCreatedAt.get(id) ?? Date.now(),
        id,
        lastActivity: this.sessionLastActivity.get(id) ?? Date.now(),
        messageCount: contextManager.getMessages().length,
        parentId: this.sessionParentIds.get(id),
        title: this.sessionTitles.get(id),
      })
    }

    // Sort by last activity (most recent first)
    return sessions.sort((a, b) => b.lastActivity - a.lastActivity)
  }

  /**
   * Set session title from the first user message.
   * Uses heuristic extraction (no LLM call).
   *
   * @param sessionId - Session ID
   * @param firstMessage - First user message
   */
  public setSessionTitleFromMessage(sessionId: string, firstMessage: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }

    const title = generateSessionTitle(firstMessage)
    this.sessionTitles.set(sessionId, title)
  }

  /**
   * Update the last activity timestamp for a session.
   * Should be called after each message exchange.
   *
   * @param sessionId - Session ID
   */
  public updateSessionActivity(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      this.sessionLastActivity.set(sessionId, Date.now())
    }
  }

  /**
   * Remove sessions that have exceeded TTL.
   *
   * @returns Number of sessions cleaned up
   */
  private async cleanupExpiredSessions(): Promise<number> {
    const now = Date.now()
    let cleaned = 0

    for (const [id] of this.sessions) {
      const lastActivity = this.sessionLastActivity.get(id) ?? 0

      if (now - lastActivity > this.config.sessionTTL) {
        // eslint-disable-next-line no-await-in-loop
        await this.endSession(id, 'ttl_expired') // Preserve history
        cleaned++
      }
    }

    return cleaned
  }

  /**
   * Internal session creation logic.
   *
   * @param id - Session ID
   * @returns New chat session instance
   */
  private async createSessionInternal(id: string): Promise<IChatSession> {
    // Create session-specific services using factory
    const sessionServices = createSessionServices(id, this.sharedServices, this.httpConfig, this.llmConfig)

    // Create session with both shared and session services
    const session = new ChatSession(id, this.sharedServices, sessionServices)

    // Initialize LLM service to load persisted history from blob storage
    // Only call initialize() if the service has the method (AgentLLMService has it)
    if ('initialize' in sessionServices.llmService && typeof sessionServices.llmService.initialize === 'function') {
      await sessionServices.llmService.initialize()
      // Debug logging removed for cleaner user experience
    }

    // Track session metadata
    const now = Date.now()
    this.sessionCreatedAt.set(id, now)
    this.sessionLastActivity.set(id, now)

    this.sessions.set(id, session)
    return session
  }

  /**
   * Internal session creation with service overrides.
   * Creates a new ToolProvider and ToolManager with the overridden FileSystemService
   * to provide file access restrictions for the session.
   *
   * @param id - Session ID
   * @param overrides - Service overrides (e.g., restricted FileSystemService)
   * @returns New chat session instance with overridden services
   */
  private async createSessionWithOverridesInternal(
    id: string,
    overrides: SessionServiceOverrides,
  ): Promise<IChatSession> {
    // Create a holder object to allow self-reference in the getToolProvider callback
    const toolProviderHolder: {provider?: ToolProvider} = {}

    // Create a new ToolProvider with the overridden FileSystemService
    const overriddenToolProvider = new ToolProvider(
      {
        fileSystemService: overrides.fileSystemService!,
        getToolProvider: (): ToolProvider => toolProviderHolder.provider!,
        memoryManager: this.sharedServices.memoryManager,
        processService: this.sharedServices.processService,
      },
      this.sharedServices.systemPromptManager,
    )
    toolProviderHolder.provider = overriddenToolProvider
    await overriddenToolProvider.initialize()

    // Create a new PolicyEngine and ToolScheduler for the overridden session
    const overriddenPolicyEngine = new PolicyEngine({defaultDecision: 'ALLOW'})
    overriddenPolicyEngine.addRules(DEFAULT_POLICY_RULES)

    const overriddenToolScheduler = new CoreToolScheduler(overriddenToolProvider, overriddenPolicyEngine, undefined, {
      verbose: false,
    })

    // Create a new ToolManager with the overridden ToolProvider
    const overriddenToolManager = new ToolManager(overriddenToolProvider, overriddenToolScheduler)
    await overriddenToolManager.initialize()

    // Create overridden shared services with the new tool stack
    const overriddenSharedServices: CipherAgentServices = {
      ...this.sharedServices,
      fileSystemService: overrides.fileSystemService!,
      policyEngine: overriddenPolicyEngine,
      toolManager: overriddenToolManager,
      toolProvider: overriddenToolProvider,
      toolScheduler: overriddenToolScheduler,
    }

    // Create session-specific services using the overridden shared services
    const sessionServices = createSessionServices(id, overriddenSharedServices, this.httpConfig, this.llmConfig)

    // Create session with overridden shared services
    const session = new ChatSession(id, overriddenSharedServices, sessionServices)

    // Initialize LLM service to load persisted history from blob storage
    if ('initialize' in sessionServices.llmService && typeof sessionServices.llmService.initialize === 'function') {
      await sessionServices.llmService.initialize()
    }

    // Track session metadata
    const now = Date.now()
    this.sessionCreatedAt.set(id, now)
    this.sessionLastActivity.set(id, now)

    this.sessions.set(id, session)
    return session
  }
}
