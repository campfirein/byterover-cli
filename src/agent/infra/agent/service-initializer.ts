/**
 * Service Initializer: Centralized Wiring for Cipher Agent Services
 *
 * This module is responsible for initializing and wiring together all core agent services.
 * It provides a single entry point for constructing the service graph.
 *
 * Following pattern:
 * - Config file is source of truth (ValidatedAgentConfig)
 * - Centralized function (not factory class) for service creation
 * - Explicit dependency order with numbered steps
 * - Event bus passed in as parameter (created in agent constructor)
 */

import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import type {CipherAgentServices, SessionServices} from '../../core/interfaces/cipher-services.js'
import type {IContentGenerator} from '../../core/interfaces/i-content-generator.js'
import type {ValidatedAgentConfig} from './agent-schemas.js'

import { RuntimeSignalStore } from '../../../server/infra/context-tree/runtime-signal-store.js'
import { createBlobStorage } from '../blob/blob-storage-factory.js'
import { EnvironmentContextBuilder } from '../environment/environment-context-builder.js'
import { AgentEventBus, SessionEventBus } from '../events/event-emitter.js'
import { FileSystemService } from '../file-system/file-system-service.js'
import { AgentLLMService } from '../llm/agent-llm-service.js'
import { CompactionService } from '../llm/context/compaction/compaction-service.js'
import { EscalatedCompressionStrategy } from '../llm/context/compression/escalated-compression.js'
import { MiddleRemovalStrategy } from '../llm/context/compression/middle-removal.js'
import { OldestRemovalStrategy } from '../llm/context/compression/oldest-removal.js'
import {
  LoggingContentGenerator,
  RetryableContentGenerator,
} from '../llm/generators/index.js'
import { createGeneratorForProvider } from '../llm/providers/index.js'
import { DEFAULT_RETRY_POLICY } from '../llm/retry/retry-policy.js'
import { GeminiTokenizer } from '../llm/tokenizers/gemini-tokenizer.js'
import { EventBasedLogger } from '../logger/event-based-logger.js'
import { AbstractGenerationQueue } from '../map/abstract-queue.js'
import { MemoryManager } from '../memory/memory-manager.js'
import { ProcessService } from '../process/process-service.js'
import { SandboxService } from '../sandbox/sandbox-service.js'
import { FileKeyStorage } from '../storage/file-key-storage.js'
import { GranularHistoryStorage } from '../storage/granular-history-storage.js'
import { MessageStorageService } from '../storage/message-storage-service.js'
import { loadSwarmConfig } from '../swarm/config/swarm-config-loader.js'
import { buildProvidersFromConfig } from '../swarm/provider-factory.js'
import { SwarmCoordinator } from '../swarm/swarm-coordinator.js'
import { validateSwarmProviders } from '../swarm/validation/config-validator.js'
import { ContextTreeStructureContributor } from '../system-prompt/contributors/context-tree-structure-contributor.js'
import { MapSelectionContributor } from '../system-prompt/contributors/map-selection-contributor.js'
import { SwarmStateContributor } from '../system-prompt/contributors/swarm-state-contributor.js'
import { SystemPromptManager } from '../system-prompt/system-prompt-manager.js'
import { CoreToolScheduler } from '../tools/core-tool-scheduler.js'
import { DEFAULT_POLICY_RULES } from '../tools/default-policy-rules.js'
import { createSearchKnowledgeService } from '../tools/implementations/search-knowledge-service.js'
import { PolicyEngine } from '../tools/policy-engine.js'
import { ToolDescriptionLoader } from '../tools/tool-description-loader.js'
import { ToolManager } from '../tools/tool-manager.js'
import { ToolProvider } from '../tools/tool-provider.js'

/**
 * HTTP configuration for ByteRover LLM service.
 *
 * projectId, sessionKey, spaceId, teamId accept either a static string or a provider function.
 * Provider functions are resolved lazily on each HTTP request,
 * so long-lived agents always get the latest values from the StateServer.
 */
export interface ByteRoverHttpConfig {
  apiBaseUrl: string
  projectId: (() => string) | string
  region?: string
  sessionKey: (() => string) | string
  spaceId: (() => string) | string
  teamId: (() => string) | string
  timeout?: number
}

/**
 * LLM configuration for per-session services.
 */
export interface SessionLLMConfig {
  httpReferer?: string
  /**
   * Override for the model's context window size in tokens.
   * When provided for an unknown model (e.g. from OpenRouter API), this becomes
   * the authoritative context limit instead of the 128K registry fallback.
   */
  maxInputTokens?: number
  maxIterations?: number
  maxTokens?: number
  model: string
  openRouterApiKey?: string
  /** Provider ID (anthropic, openai, google, xai, groq, mistral, openrouter, byterover) */
  provider?: string
  /** API key for the direct provider */
  providerApiKey?: string
  /** Base URL for OpenAI-compatible providers */
  providerBaseUrl?: string
  /** Custom headers for the provider */
  providerHeaders?: Record<string, string>
  /**
   * Optional per-request abort timeout, in milliseconds. Sourced from
   * the agent-side settings snapshot (`llm.requestTimeoutMs`). Flows to
   * AiSdkContentGenerator via the provider registry; absent → no per-
   * request abort.
   */
  requestTimeoutMs?: number
  siteName?: string
  temperature?: number
  /**
   * Optional wall-clock budget for the agentic loop, in milliseconds.
   * Sourced from the agent-side settings snapshot (`llm.iterationBudgetMs`).
   * Falls back to AgentLLMService's internal default when undefined.
   */
  timeout?: number
  verbose?: boolean
}

// Re-export service types for convenience
export type {CipherAgentServices, SessionManagerConfig, SessionServices} from '../../core/interfaces/cipher-services.js'

/**
 * Creates shared services for CipherAgent.
 * These services are singletons shared across all sessions.
 *
 * Initialization order (explicit numbered steps):
 * 1. Logger (uses provided event bus)
 * 2. File system service (no dependencies)
 * 3. Process service (no dependencies)
 * 4. Blob storage (no dependencies)
 * 5. Memory system (depends on BlobStorage, Logger)
 * 6. System prompt manager (no dependencies)
 * 7. Tool provider (depends on FileSystemService, ProcessService, MemoryManager)
 * 8. Policy engine (no dependencies)
 * 9. Tool scheduler (depends on ToolProvider, PolicyEngine)
 * 10. Tool manager (depends on ToolProvider, ToolScheduler)
 * 11. History storage (file-based granular storage)
 * 12. Return all services
 *
 * @param config - Validated agent configuration (Zod-validated)
 * @param agentEventBus - Pre-created event bus from agent constructor
 * @returns Initialized shared services
 */
export async function createCipherAgentServices(
  config: ValidatedAgentConfig,
  agentEventBus: AgentEventBus,
): Promise<CipherAgentServices> {
  // 1. Logger (uses provided event bus )
  const logger = new EventBasedLogger(agentEventBus, 'CipherAgent')

  // 2. File system service (no dependencies)
  const fileSystemService = new FileSystemService(config.fileSystem)
  await fileSystemService.initialize()

  // 3. Process service (no dependencies)
  const workingDirectory = config.fileSystem?.workingDirectory ?? process.cwd()
  const processService = new ProcessService({
    allowedCommands: [],
    blockedCommands: [],
    environment: {},
    maxConcurrentProcesses: 5,
    maxOutputBuffer: 1_048_576, // 1MB (1024 * 1024)
    maxTimeout: 600_000, // 10 minutes
    securityLevel: 'permissive', // Permissive mode: relies on working directory confinement
    workingDirectory,
  })
  await processService.initialize()

  // Storage base path: XDG storagePath (always required, provided by daemon)
  const storageBasePath = config.storagePath

  // 4. Blob storage (no dependencies)
  const blobStorage = createBlobStorage(
    config.blobStorage ?? {
      maxBlobSize: 100 * 1024 * 1024, // 100MB
      maxTotalSize: 1024 * 1024 * 1024, // 1GB
      storageDir: storageBasePath,
    },
  )
  await blobStorage.initialize()

  // 5. Memory system (depends on BlobStorage, Logger)
  const memoryLogger = logger.withSource('MemoryManager')
  const memoryManager = new MemoryManager(blobStorage, memoryLogger)

  // 5b. Sandbox service for code execution (no dependencies)
  const sandboxService = new SandboxService()

  // 5c. Build environment context for sandbox injection
  const environmentBuilder = new EnvironmentContextBuilder()
  const environmentContext = await environmentBuilder.build({
    includeBrvStructure: false, // Not needed for sandbox - only basic env info
    includeFileTree: false, // Not needed for sandbox - only basic env info
    workingDirectory,
  })

  // 6. System prompt manager - SHARED across sessions
  // Calculate path to prompts directory relative to this file's location
  // This file is at dist/agent/core/service-initializer.js
  // Resources are at dist/resources/prompts/
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const promptsBasePath = join(currentDir, '../../resources/prompts')

  const systemPromptManager = new SystemPromptManager({
    basePath: promptsBasePath,
    validateConfig: true,
  })
  // Register default contributors.
  //
  // Note: dateTime is intentionally NOT in the system prompt. Anthropic
  // prompt caching does token-level prefix matching, so a per-iteration
  // refreshed timestamp here would invalidate the cache for everything
  // past it. dateTime is instead injected into the first user message
  // by AgentLLMService, where it lives after the cache breakpoints and
  // does not poison the cached prefix.
  systemPromptManager.registerContributors([
    {enabled: true, filepath: 'system-prompt.yml', id: 'base', priority: 0, type: 'file'},
    {enabled: true, id: 'env', priority: 10, type: 'environment'},
    {enabled: true, id: 'memories', priority: 20, type: 'memory'},
  ])

  // Register context tree structure contributor for query/curate commands
  // This injects the .brv/context-tree structure into the system prompt,
  // giving agents immediate awareness of available curated knowledge.
  // Priority 15 ensures it appears after environment but before memories.
  const contextTreeContributor = new ContextTreeStructureContributor('contextTree', 15, {
    workingDirectory,
  })
  systemPromptManager.registerContributor(contextTreeContributor)

  // Register map selection contributor for curate commands
  // Priority 16 — right after context tree structure, before memories
  const mapSelectionContributor = new MapSelectionContributor('mapSelection', 16)
  systemPromptManager.registerContributor(mapSelectionContributor)

  // 6b. Storage layer — initialised before the swarm block so the swarm
  // SearchKnowledgeService receives `runtimeSignalStore` at construction
  // time. Post-commit-5 the markdown fallback is gone, so a swarm search
  // without the sidecar would silently drop every access-hit bump.
  const keyStorage = new FileKeyStorage({
    storageDir: storageBasePath,
  })
  await keyStorage.initialize()

  const messageStorage = new MessageStorageService(keyStorage)
  const messageStorageService = messageStorage
  const historyStorage = new GranularHistoryStorage(messageStorage)

  // Sidecar store for per-machine ranking signals (importance, recency,
  // maturity, accessCount, updateCount). Kept out of the context-tree
  // markdown so query-time bumps don't dirty version-controlled files.
  const runtimeSignalStore = new RuntimeSignalStore(keyStorage, logger)

  // 6c. Swarm coordinator — try to load config and build providers.
  // Missing config → fail-open (no swarm). Invalid config → warn but continue.
  let swarmCoordinator: SwarmCoordinator | undefined
  try {
    const swarmConfig = await loadSwarmConfig(workingDirectory)

    // Validate enrichment topology — structural errors block swarm init.
    // Provider-specific errors (bad paths, missing API keys) are handled
    // by health checks, preserving degraded-mode semantics.
    const swarmValidation = await validateSwarmProviders(swarmConfig)
    const topologyErrors = swarmValidation.errors.filter((e) => e.provider === 'enrichment')
    if (topologyErrors.length > 0) {
      const messages = topologyErrors.map((e) => e.message)
      throw new Error(`Invalid enrichment topology:\n  ${messages.join('\n  ')}`)
    }

    // Log provider-specific warnings/errors without blocking
    for (const error of swarmValidation.errors.filter((e) => e.provider !== 'enrichment')) {
      logger.warn(`Swarm provider issue: ${error.provider}: ${error.message}`)
    }

    const swarmProviders = buildProvidersFromConfig(swarmConfig, {
      searchService: createSearchKnowledgeService(fileSystemService, {
        baseDirectory: workingDirectory,
        logger,
        runtimeSignalStore,
      }),
    })

    if (swarmProviders.length > 0) {
      swarmCoordinator = new SwarmCoordinator(swarmProviders, swarmConfig)
      // Run initial health checks so unhealthy providers are skipped from first query
      await swarmCoordinator.refreshHealth()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const isConfigMissing = message.includes('not found')
    if (!isConfigMissing) {
      // Config exists but is invalid — warn so the user can diagnose
      logger.warn(`Swarm disabled due to config error: ${message}`)
    }
    // Missing config is expected — silently skip
  }

  // Register swarm state contributor when multi-provider swarm is active
  if (swarmCoordinator) {
    const swarmStateContributor = new SwarmStateContributor('swarmState', 17, swarmCoordinator)
    systemPromptManager.registerContributor(swarmStateContributor)
  }

  // 7. Abstract generation queue (generator injected later via rebindCurateTools)
  const abstractQueue = new AbstractGenerationQueue(workingDirectory)

  // 9. Tool provider (depends on FileSystemService, ProcessService, MemoryManager, SystemPromptManager)
  const verbose = config.llm.verbose ?? false
  const descriptionLoader = new ToolDescriptionLoader()
  const toolProvider: ToolProvider = new ToolProvider(
    {
      abstractQueue,
      environmentContext,
      fileSystemService,
      getToolProvider: (): ToolProvider => toolProvider,
      memoryManager,
      processService,
      runtimeSignalStore,
      sandboxService,
      swarmCoordinator,
    },
    systemPromptManager,
    descriptionLoader,
  )
  await toolProvider.initialize()

  // 10. Policy engine with default rules for autonomous execution
  const policyEngine = new PolicyEngine({defaultDecision: 'ALLOW'})
  policyEngine.addRules(DEFAULT_POLICY_RULES)

  // 11. Tool scheduler (orchestrates policy check → execution)
  const toolScheduler = new CoreToolScheduler(toolProvider, policyEngine, undefined, {
    verbose,
  })

  // 12. Tool manager (with scheduler for policy-based execution)
  const toolManager = new ToolManager(toolProvider, toolScheduler)
  await toolManager.initialize()

  // CompactionService for context overflow management
  const tokenizer = new GeminiTokenizer(config.model ?? 'gemini-3-flash-preview')
  const compactionService = new CompactionService(messageStorage, tokenizer, {
    overflowThreshold: 0.85,    // 85% triggers compaction check
    protectedTurns: 2,          // Protect last 2 user turns from pruning
    pruneKeepPercent: 0.2,      // Keep 20% of context window in tool outputs
    pruneMinimumPercent: 0.1,   // Only prune if 10%+ of context window can be saved
  })

  // 12. Log successful initialization
  logger.info('CipherAgent services initialized successfully', {
    model: config.model,
    verbose: config.llm.verbose,
    workingDirectory,
  })

  return {
    abstractQueue,
    agentEventBus,
    blobStorage,
    compactionService,
    fileSystemService,
    historyStorage,
    memoryManager,
    messageStorageService,
    policyEngine,
    processService,
    runtimeSignalStore,
    sandboxService,
    systemPromptManager,
    toolManager,
    toolProvider,
    toolScheduler,
    workingDirectory,
  }
}

/**
 * Creates session-specific services for a ChatSession.
 * Generator composition order (innermost to outermost):
 * 1. Base generator (created via provider registry)
 * 2. RetryableContentGenerator - handles transient errors with backoff
 * 3. LoggingContentGenerator - debug logging (if verbose enabled)
 *
 * @param sessionId - Unique session identifier
 * @param sharedServices - Shared services from agent
 * @param httpConfig - HTTP configuration
 * @param llmConfig - LLM service configuration
 * @returns Initialized session services
 */
export function createSessionServices(
  sessionId: string,
  sharedServices: CipherAgentServices,
  httpConfig: ByteRoverHttpConfig,
  llmConfig: SessionLLMConfig,
): SessionServices {
  // 1. Create session-specific event bus
  const sessionEventBus = new SessionEventBus()

  // 2. Create session-scoped logger
  const sessionLogger = new EventBasedLogger(sharedServices.agentEventBus, 'LLMService', sessionId)

  // 3. Create LLM service based on provider configuration
  // Routing priority: explicit provider > openRouterApiKey > byterover (default)
  const provider = llmConfig.provider ?? (llmConfig.openRouterApiKey ? 'openrouter' : 'byterover')

  // Helper: wrap a base generator with retry + logging decorators, then create AgentLLMService
  const createServiceWithGenerator = (baseGenerator: IContentGenerator): AgentLLMService => {
    let generator: IContentGenerator = baseGenerator

    // Wrap with retry decorator
    generator = new RetryableContentGenerator(generator, {
      eventBus: sessionEventBus,
      policy: DEFAULT_RETRY_POLICY,
    })

    // Wrap with logging decorator (always, for spinner events)
    generator = new LoggingContentGenerator(generator, sessionEventBus, {
      logChunks: llmConfig.verbose,
      logRequests: llmConfig.verbose,
      logResponses: llmConfig.verbose,
      verbose: llmConfig.verbose,
    })

    // Create escalated compression strategy with retry-only generator (no UI noise).
    // Skip LoggingContentGenerator: avoids llmservice:thinking spinner events.
    // Use a silenced SessionEventBus: RetryableContentGenerator emits
    // llmservice:warning/error via eventBus on retries. Using a detached
    // event bus with no listeners ensures these fire into void.
    const compactionEventBus = new SessionEventBus()
    const compactionGenerator = new RetryableContentGenerator(baseGenerator, {
      eventBus: compactionEventBus,
      policy: DEFAULT_RETRY_POLICY,
    })
    const escalatedStrategy = new EscalatedCompressionStrategy({
      generator: compactionGenerator,
      model: llmConfig.model ?? 'gemini-3-flash-preview',
    })

    return new AgentLLMService(
      sessionId,
      generator,
      {
        maxInputTokens: llmConfig.maxInputTokens,
        maxIterations: llmConfig.maxIterations ?? 50,
        maxTokens: llmConfig.maxTokens ?? 8192,
        model: llmConfig.model ?? 'gemini-3-flash-preview',
        provider,
        temperature: llmConfig.temperature ?? 0.7,
        timeout: llmConfig.timeout,
        verbose: llmConfig.verbose ?? false,
      },
      {
        compactionService: sharedServices.compactionService,
        compressionStrategies: [
          escalatedStrategy,
          new MiddleRemovalStrategy({preserveEnd: 5, preserveStart: 4}),
          new OldestRemovalStrategy({minMessagesToKeep: 4}),
        ],
        historyStorage: sharedServices.historyStorage,
        logger: sessionLogger,
        memoryManager: sharedServices.memoryManager,
        sandboxService: sharedServices.sandboxService,
        sessionEventBus,
        systemPromptManager: sharedServices.systemPromptManager,
        toolManager: sharedServices.toolManager,
      },
    )
  }

  // Create base generator via provider registry
  const baseGenerator = createGeneratorForProvider(provider, {
    apiKey: provider === 'openrouter'
      ? (llmConfig.openRouterApiKey ?? llmConfig.providerApiKey)
      : llmConfig.providerApiKey,
    baseUrl: llmConfig.providerBaseUrl,
    headers: llmConfig.providerHeaders,
    httpConfig: httpConfig as unknown as Record<string, unknown>,
    httpReferer: llmConfig.httpReferer,
    maxTokens: llmConfig.maxTokens ?? 8192,
    model: llmConfig.model,
    requestTimeoutMs: llmConfig.requestTimeoutMs,
    siteName: llmConfig.siteName,
    temperature: llmConfig.temperature ?? 0.7,
  })

  const llmService = createServiceWithGenerator(baseGenerator)

  // Event forwarding is handled by ChatSession.setupEventForwarding()
  // to ensure proper cleanup when sessions are disposed

  return {
    llmService,
    sessionEventBus,
  }
}
