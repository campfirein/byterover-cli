/**
 * Test Mock Factories
 *
 * Centralized factory functions for creating properly-typed test mocks.
 * This approach uses Partial<Type> to explicitly mock only what's needed for tests.
 *
 * Benefits over `as unknown as Type`:
 * - Partial type safety: TypeScript checks stubbed methods exist on the interface
 * - Explicit intent: Clear that we're mocking a subset of the interface
 * - DRY: Reusable across test files
 * - Maintainable: Single source of truth when interfaces change
 * - Compile-time errors: When adding stubs for non-existent methods
 *
 * Trade-offs:
 * - Still requires casting for full type compatibility in test setup
 * - But the cast is centralized and documented, not scattered throughout tests
 */

import type {ConnectionResult, ITransportClient} from '@campfirein/brv-transport-client'
import type {SinonSandbox, SinonStub, SinonStubbedInstance} from 'sinon'

import {stub} from 'sinon'

import type {CipherAgentServices} from '../../src/agent/core/interfaces/cipher-services.js'
import type {IBlobStorage} from '../../src/agent/core/interfaces/i-blob-storage.js'
import type {ICipherAgent} from '../../src/agent/core/interfaces/i-cipher-agent.js'
import type {IHistoryStorage} from '../../src/agent/core/interfaces/i-history-storage.js'
import type {ILLMService} from '../../src/agent/core/interfaces/i-llm-service.js'
import type {PolicyEvaluationResult, PolicyRule} from '../../src/agent/core/interfaces/i-policy-engine.js'
import type {ISandboxService} from '../../src/agent/core/interfaces/i-sandbox-service.js'
import type {ScheduledToolExecution, ToolSchedulerContext} from '../../src/agent/core/interfaces/i-tool-scheduler.js'
import type {AgentEventBus} from '../../src/agent/infra/events/event-emitter.js'
import type {FileSystemService} from '../../src/agent/infra/file-system/file-system-service.js'
import type {CompactionService} from '../../src/agent/infra/llm/context/compaction/compaction-service.js'
import type {ContextManager} from '../../src/agent/infra/llm/context/context-manager.js'
import type {AbstractGenerationQueue} from '../../src/agent/infra/map/abstract-queue.js'
import type {MemoryManager} from '../../src/agent/infra/memory/memory-manager.js'
import type {ProcessService} from '../../src/agent/infra/process/process-service.js'
import type {MessageStorageService} from '../../src/agent/infra/storage/message-storage-service.js'
import type {SystemPromptManager} from '../../src/agent/infra/system-prompt/system-prompt-manager.js'
import type {ToolManager} from '../../src/agent/infra/tools/tool-manager.js'
import type {ToolProvider} from '../../src/agent/infra/tools/tool-provider.js'
import type {IProviderConfigStore} from '../../src/server/core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../src/server/core/interfaces/i-provider-keychain-store.js'
import type {IProviderOAuthTokenStore} from '../../src/server/core/interfaces/i-provider-oauth-token-store.js'
import type {IAuthStateStore} from '../../src/server/core/interfaces/state/i-auth-state-store.js'
import type {IRuntimeSignalStore} from '../../src/server/core/interfaces/storage/i-runtime-signal-store.js'
import type {ITransportServer} from '../../src/server/core/interfaces/transport/i-transport-server.js'

import {AuthToken} from '../../src/server/core/domain/entities/auth-token.js'
import {createDefaultRuntimeSignals} from '../../src/server/core/domain/knowledge/runtime-signals-schema.js'

/**
 * Type aliases for service mocks - balances type safety with readability.
 * These types auto-sync with CipherAgentServices interface changes.
 */
type MockPolicyEngine = CipherAgentServices['policyEngine']
type MockToolScheduler = CipherAgentServices['toolScheduler']

/**
 * Creates a mock ContextManager with commonly-used methods stubbed.
 * Uses Partial<ContextManager> internally for type safety on stubbed methods.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ContextManager (cast to full type for test usage)
 */
export function createMockContextManager<T = unknown>(
  sandbox: SinonSandbox,
  overrides?: Partial<ContextManager<T>>,
): ContextManager<T> {
  const mock: Partial<ContextManager<T>> = {
    clearHistory: sandbox.stub().resolves(),
    flush: sandbox.stub().resolves(),
    getMessages: sandbox.stub().returns([]),
    ...overrides,
  }

  // Cast to full type - test code only calls stubbed methods
  return mock as ContextManager<T>
}

/**
 * Creates a mock ILLMService with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ILLMService (cast to full type for test usage)
 */
export function createMockLLMService(sandbox: SinonSandbox, overrides?: Partial<ILLMService>): ILLMService {
  const mockContextManager = createMockContextManager(sandbox)

  const mock: Partial<ILLMService> = {
    completeTask: sandbox.stub().resolves('test response'),
    getAllTools: sandbox.stub().resolves({}),
    getConfig: sandbox.stub().returns({
      configuredMaxInputTokens: 1000,
      maxInputTokens: 1000,
      maxOutputTokens: 1000,
      model: 'test-model',
      modelMaxInputTokens: 1000,
      provider: 'test-provider',
      router: 'test-router',
    }),
    getContextManager: sandbox.stub().returns(mockContextManager),
    ...overrides,
  }

  return mock as ILLMService
}

/**
 * Creates a mock IBlobStorage with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock IBlobStorage (cast to full type for test usage)
 */
export function createMockBlobStorage(sandbox: SinonSandbox, overrides?: Partial<IBlobStorage>): IBlobStorage {
  const mock: Partial<IBlobStorage> = {
    clear: sandbox.stub().resolves(),
    delete: sandbox.stub().resolves(),
    exists: sandbox.stub().resolves(false),
    list: sandbox.stub().resolves([]),
    retrieve: sandbox.stub().resolves(),
    store: sandbox.stub().resolves({
      content: Buffer.from(''),
      key: 'test-key',
      metadata: {
        contentType: 'application/octet-stream',
        createdAt: new Date(),
        size: 0,
        updatedAt: new Date(),
      },
    }),
    ...overrides,
  }

  return mock as IBlobStorage
}

/**
 * Creates a mock IHistoryStorage with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock IHistoryStorage (cast to full type for test usage)
 */
export function createMockHistoryStorage(sandbox: SinonSandbox, overrides?: Partial<IHistoryStorage>): IHistoryStorage {
  const mock: Partial<IHistoryStorage> = {
    deleteHistory: sandbox.stub().resolves(),
    exists: sandbox.stub().resolves(false),
    getSessionMetadata: sandbox.stub().resolves(),
    listSessions: sandbox.stub().resolves([]),
    loadHistory: sandbox.stub().resolves([]),
    saveHistory: sandbox.stub().resolves(),
    ...overrides,
  }

  return mock as IHistoryStorage
}

/**
 * Creates a mock FileSystemService with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock FileSystemService (cast to full type for test usage)
 */
export function createMockFileSystemService(
  sandbox: SinonSandbox,
  overrides?: Partial<FileSystemService>,
): FileSystemService {
  const mock: Partial<FileSystemService> = {
    editFile: sandbox.stub().resolves({bytesWritten: 0, replacements: 0}),
    globFiles: sandbox.stub().resolves({files: [], totalMatches: 0}),
    initialize: sandbox.stub().resolves(),
    readFile: sandbox.stub().resolves({content: '', metadata: {lines: 0, size: 0}}),
    searchContent: sandbox.stub().resolves({matches: [], totalMatches: 0}),
    writeFile: sandbox.stub().resolves({bytesWritten: 0, filePath: ''}),
    ...overrides,
  }

  return mock as FileSystemService
}

/**
 * Creates a mock MemoryManager with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock MemoryManager (cast to full type for test usage)
 */
export function createMockMemoryManager(sandbox: SinonSandbox, overrides?: Partial<MemoryManager>): MemoryManager {
  const mock: Partial<MemoryManager> = {
    ...overrides,
  }

  return mock as MemoryManager
}

/**
 * Creates a mock ProcessService with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ProcessService (cast to full type for test usage)
 */
export function createMockProcessService(sandbox: SinonSandbox, overrides?: Partial<ProcessService>): ProcessService {
  const mock: Partial<ProcessService> = {
    ...overrides,
  }

  return mock as ProcessService
}

/**
 * Creates a mock ISandboxService with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ISandboxService (cast to full type for test usage)
 */
export function createMockSandboxService(sandbox: SinonSandbox, overrides?: Partial<ISandboxService>): ISandboxService {
  const mock: Partial<ISandboxService> = {
    cleanup: sandbox.stub().resolves(),
    clearSession: sandbox.stub().resolves(),
    executeCode: sandbox.stub().resolves({
      executionTime: 0,
      locals: {},
      returnValue: undefined,
      stderr: '',
      stdout: '',
    }),
    ...overrides,
  }

  return mock as ISandboxService
}

/**
 * Creates a mock SystemPromptManager with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock SystemPromptManager (cast to full type for test usage)
 */
export function createMockSystemPromptManager(
  sandbox: SinonSandbox,
  overrides?: Partial<SystemPromptManager>,
): SystemPromptManager {
  const mock: Partial<SystemPromptManager> = {
    build: sandbox.stub().resolves('mock system prompt'),
    ...overrides,
  }

  return mock as SystemPromptManager
}

/**
 * Creates a mock ToolManager with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ToolManager (cast to full type for test usage)
 */
export function createMockToolManager(sandbox: SinonSandbox, overrides?: Partial<ToolManager>): ToolManager {
  const mock: Partial<ToolManager> = {
    ...overrides,
  }

  return mock as ToolManager
}

/**
 * Creates a mock ToolProvider with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ToolProvider (cast to full type for test usage)
 */
export function createMockToolProvider(sandbox: SinonSandbox, overrides?: Partial<ToolProvider>): ToolProvider {
  const mock: Partial<ToolProvider> = {
    ...overrides,
  }

  return mock as ToolProvider
}

/**
 * Creates a mock ICipherAgent with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ICipherAgent (cast to full type for test usage)
 */
export function createMockCipherAgent(sandbox: SinonSandbox, overrides?: Partial<ICipherAgent>): ICipherAgent {
  const mock: Partial<ICipherAgent> = {
    deleteSession: sandbox.stub().resolves(true),
    execute: sandbox.stub().resolves('test response'),
    getSessionMetadata: sandbox.stub().resolves(),
    getState: sandbox.stub().returns({
      currentIteration: 0,
      executionHistory: [],
    }),
    listPersistedSessions: sandbox.stub().resolves([]),
    reset: sandbox.stub(),
    start: sandbox.stub().resolves(),
    ...overrides,
  }

  return mock as ICipherAgent
}

/**
 * Creates a mock IPolicyEngine with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock IPolicyEngine (cast to full type for test usage)
 */
export function createMockPolicyEngine(sandbox: SinonSandbox, overrides?: Partial<MockPolicyEngine>): MockPolicyEngine {
  const mock: Partial<MockPolicyEngine> = {
    addRule: sandbox.stub<[PolicyRule], void>(),
    evaluate: sandbox
      .stub<[string, Record<string, unknown>], PolicyEvaluationResult>()
      .returns({decision: 'ALLOW', reason: 'mock allow'}),
    getRules: sandbox.stub<[], readonly PolicyRule[]>().returns([]),
    removeRule: sandbox.stub<[string], void>(),
    ...overrides,
  }

  return mock as MockPolicyEngine
}

/**
 * Creates a mock IToolScheduler with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock IToolScheduler (cast to full type for test usage)
 */
export function createMockToolScheduler(
  sandbox: SinonSandbox,
  overrides?: Partial<MockToolScheduler>,
): MockToolScheduler {
  const mock: Partial<MockToolScheduler> = {
    clearHistory: sandbox.stub<[], void>(),
    execute: sandbox.stub<[string, Record<string, unknown>, ToolSchedulerContext], Promise<unknown>>().resolves(),
    getHistory: sandbox.stub<[], readonly ScheduledToolExecution[]>().returns([]),
    ...overrides,
  }

  return mock as MockToolScheduler
}

/**
 * Creates an in-memory IRuntimeSignalStore backed by a Map.
 *
 * Behaviour mirrors RuntimeSignalStore: get returns defaults for unknown
 * paths, update runs the updater against the current (or default) record.
 * No atomicity guarantees are needed at the mock level — tests using this
 * mock don't exercise concurrent writes.
 */
export function createMockRuntimeSignalStore(): IRuntimeSignalStore {
  const store = new Map<string, ReturnType<typeof createDefaultRuntimeSignals>>()

  const get = async (relPath: string) => store.get(relPath) ?? createDefaultRuntimeSignals()

  return {
    async batchUpdate(updates) {
      await Promise.all(
        [...updates.entries()].map(async ([relPath, updater]) => {
          const current = await get(relPath)
          store.set(relPath, updater(current))
        }),
      )
    },
    async delete(relPath) {
      store.delete(relPath)
    },
    get,
    async getMany(relPaths) {
      // Mirror the real store: only return entries for paths that have a
      // stored record. Callers distinguish missing via `.has(path)`.
      const entries: Array<readonly [string, ReturnType<typeof createDefaultRuntimeSignals>]> = []
      for (const relPath of relPaths) {
        const value = store.get(relPath)
        if (value !== undefined) entries.push([relPath, value])
      }

      return new Map(entries)
    },
    async list() {
      return new Map(store)
    },
    async set(relPath, signals) {
      store.set(relPath, signals)
    },
    async update(relPath, updater) {
      const next = updater(await get(relPath))
      store.set(relPath, next)
      return next
    },
  }
}

/**
 * Creates a properly-typed mock CipherAgentServices
 *
 * @param agentEventBus - Real or mock AgentEventBus instance
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific services
 * @returns Fully-typed mock CipherAgentServices
 */
export function createMockCipherAgentServices(
  agentEventBus: AgentEventBus,
  sandbox: SinonSandbox,
  overrides?: Partial<CipherAgentServices>,
): CipherAgentServices {
  return {
    abstractQueue: {} as unknown as AbstractGenerationQueue,
    agentEventBus,
    blobStorage: createMockBlobStorage(sandbox),
    compactionService: {} as unknown as CompactionService,
    fileSystemService: createMockFileSystemService(sandbox),
    historyStorage: createMockHistoryStorage(sandbox),
    memoryManager: createMockMemoryManager(sandbox),
    messageStorageService: {} as unknown as MessageStorageService,
    policyEngine: createMockPolicyEngine(sandbox),
    processService: createMockProcessService(sandbox),
    runtimeSignalStore: createMockRuntimeSignalStore(),
    sandboxService: createMockSandboxService(sandbox),
    systemPromptManager: createMockSystemPromptManager(sandbox),
    toolManager: createMockToolManager(sandbox),
    toolProvider: createMockToolProvider(sandbox),
    toolScheduler: createMockToolScheduler(sandbox),
    workingDirectory: process.cwd(),
    ...overrides,
  }
}

// ============================================================================
// Provider Store Mocks (for handler tests)
// ============================================================================

/**
 * Creates a mock IProviderConfigStore with commonly-used methods stubbed.
 *
 * @param overrides - Optional overrides for specific methods
 * @returns Mock IProviderConfigStore (cast to full type for test usage)
 */
export function createMockProviderConfigStore(
  overrides?: Partial<SinonStubbedInstance<IProviderConfigStore>>,
): SinonStubbedInstance<IProviderConfigStore> {
  const mock = {
    connectProvider: stub().resolves(),
    disconnectProvider: stub().resolves(),
    getActiveModel: stub().resolves(),
    getActiveProvider: stub().resolves('byterover'),
    getFavoriteModels: stub().resolves([]),
    getRecentModels: stub().resolves([]),
    isProviderConnected: stub().resolves(false),
    read: stub().resolves(),
    setActiveModel: stub().resolves(),
    setActiveProvider: stub().resolves(),
    toggleFavorite: stub().resolves(),
    write: stub().resolves(),
    ...overrides,
  }

  return mock as unknown as SinonStubbedInstance<IProviderConfigStore>
}

/**
 * Creates a mock IProviderKeychainStore with commonly-used methods stubbed.
 *
 * @param overrides - Optional overrides for specific methods
 * @returns Mock IProviderKeychainStore (cast to full type for test usage)
 */
export function createMockProviderKeychainStore(
  overrides?: Partial<SinonStubbedInstance<IProviderKeychainStore>>,
): SinonStubbedInstance<IProviderKeychainStore> {
  const mock = {
    deleteApiKey: stub().resolves(),
    getApiKey: stub().resolves(),
    hasApiKey: stub().resolves(false),
    setApiKey: stub().resolves(),
    ...overrides,
  }

  return mock as unknown as SinonStubbedInstance<IProviderKeychainStore>
}

/**
 * Creates a mock IProviderOAuthTokenStore with commonly-used methods stubbed.
 *
 * @param overrides - Optional overrides for specific methods
 * @returns Mock IProviderOAuthTokenStore (cast to full type for test usage)
 */
export function createMockProviderOAuthTokenStore(
  overrides?: Partial<SinonStubbedInstance<IProviderOAuthTokenStore>>,
): SinonStubbedInstance<IProviderOAuthTokenStore> {
  const mock = {
    delete: stub().resolves(),
    get: stub().resolves(),
    has: stub().resolves(false),
    set: stub().resolves(),
    ...overrides,
  }

  return mock as unknown as SinonStubbedInstance<IProviderOAuthTokenStore>
}

// ============================================================================
// Auth State Store Mock
// ============================================================================

/**
 * Creates a mock IAuthStateStore with commonly-used methods stubbed.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param options - Optional configuration
 * @param options.isAuthenticated - Whether the mock should return a valid auth token (default: true)
 * @returns Mock IAuthStateStore (cast to full type for test usage)
 */
export function createMockAuthStateStore(
  sandbox: SinonSandbox,
  options?: {isAuthenticated?: boolean},
): IAuthStateStore {
  const isAuthenticated = options?.isAuthenticated ?? true
  const token = isAuthenticated
    ? new AuthToken({
        accessToken: 'test-token',
        expiresAt: new Date(Date.now() + 3_600_000),
        refreshToken: 'refresh',
        sessionKey: 'session',
        userEmail: 'test@test.com',
        userId: 'user-id',
      })
    : undefined

  return {
    getToken: sandbox.stub().returns(token),
    loadToken: sandbox.stub().resolves(token),
    onAuthChanged: sandbox.stub(),
    onAuthExpired: sandbox.stub(),
    onBeforeAuthChange: sandbox.stub(),
    startPolling: sandbox.stub(),
    stopPolling: sandbox.stub(),
  }
}

// ============================================================================
// Transport Server Mock (for handler tests)
// ============================================================================

/**
 * Handler type for transport server request handlers.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRequestHandler = (data: any, clientId: string) => any

/**
 * Handler type for transport server disconnection handlers.
 */
type DisconnectionHandler = (clientId: string, metadata?: Record<string, unknown>) => void

/**
 * Extended mock transport server with handler introspection.
 */
export type MockTransportServer = SinonStubbedInstance<ITransportServer> & {
  _disconnectionHandlers: DisconnectionHandler[]
  _handlers: Map<string, AnyRequestHandler>
  _simulateDisconnect: (clientId: string) => void
}

/**
 * Creates a mock ITransportServer with commonly-used methods stubbed.
 * Captures registered request handlers for test introspection.
 *
 * @returns Mock ITransportServer with _handlers map
 *
 * @example
 * ```ts
 * const transport = createMockTransportServer()
 * handler.setup() // registers handlers via transport.onRequest
 * const listHandler = transport._handlers.get('model:list')
 * const result = await listHandler!({providerId: 'openrouter'}, 'client-1')
 * ```
 */
export function createMockTransportServer(): MockTransportServer {
  const handlers = new Map<string, AnyRequestHandler>()
  const disconnectionHandlers: DisconnectionHandler[] = []
  return {
    _disconnectionHandlers: disconnectionHandlers,
    _handlers: handlers,
    _simulateDisconnect(clientId: string) {
      for (const handler of disconnectionHandlers) {
        handler(clientId)
      }
    },
    addToRoom: stub(),
    broadcast: stub(),
    broadcastTo: stub(),
    getPort: stub(),
    isRunning: stub(),
    onConnection: stub(),
    onDisconnection: stub().callsFake((handler: DisconnectionHandler) => {
      disconnectionHandlers.push(handler)
    }),
    onRequest: stub().callsFake((event: string, handler: AnyRequestHandler) => {
      handlers.set(event, handler)
    }),
    removeFromRoom: stub(),
    sendTo: stub(),
    start: stub(),
    stop: stub(),
  } as unknown as MockTransportServer
}

// ============================================================================
// Transport Client Mock
// ============================================================================

/**
 * Event handler storage for mock transport client.
 * Allows tests to simulate server events by calling registered handlers.
 */
export type MockEventHandlers = Map<string, Array<(data: unknown) => void>>

/**
 * Extended mock transport client with event simulation capabilities.
 */
export type MockTransportClient = ITransportClient & {
  /**
   * Access to registered event handlers for simulating server events.
   */
  _handlers: MockEventHandlers
  /**
   * Simulates a server event by calling all registered handlers for the event.
   * @param event - The event name
   * @param data - The event payload
   */
  _simulateEvent: <T>(event: string, data: T) => void
}

/**
 * Creates a mock ITransportClient with commonly-used methods stubbed.
 * Includes event simulation capabilities for testing event handlers.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param overrides - Optional overrides for specific methods
 * @returns Mock ITransportClient with event simulation
 *
 * @example
 * ```ts
 * const mockClient = createMockTransportClient(sandbox)
 *
 * // Simulate server events
 * mockClient._simulateEvent('task:completed', { taskId: 'test-id' })
 *
 * // Override specific methods
 * const mockClient = createMockTransportClient(sandbox, {
 *   request: sandbox.stub().rejects(new Error('Connection failed')),
 * })
 * ```
 */
export function createMockTransportClient(
  sandbox: SinonSandbox,
  overrides?: Partial<ITransportClient>,
): MockTransportClient {
  const handlers: MockEventHandlers = new Map()

  // Create on() stub that registers handlers and returns unsubscribe function
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const onImpl = (event: string, handler: (data: any) => void): (() => void) => {
    if (!handlers.has(event)) {
      handlers.set(event, [])
    }

    handlers.get(event)!.push(handler)

    // Return unsubscribe function
    return () => {
      const eventHandlers = handlers.get(event)
      if (eventHandlers) {
        const index = eventHandlers.indexOf(handler)
        if (index !== -1) {
          eventHandlers.splice(index, 1)
        }
      }
    }
  }

  const mock: MockTransportClient = {
    _handlers: handlers,
    _simulateEvent<T>(event: string, data: T) {
      const eventHandlers = handlers.get(event)
      if (eventHandlers) {
        for (const handler of eventHandlers) {
          handler(data)
        }
      }
    },
    connect: sandbox.stub().resolves(),
    disconnect: sandbox.stub().resolves(),
    getClientId: sandbox.stub().returns('mock-client-id'),
    getDaemonVersion: sandbox.stub(),
    getState: sandbox.stub().returns('connected'),
    isConnected: sandbox.stub().resolves(true),
    joinRoom: sandbox.stub().resolves(),
    leaveRoom: sandbox.stub().resolves(),
    on: onImpl,
    once: sandbox.stub(),
    onStateChange: sandbox.stub().returns(() => {}),
    request: sandbox.stub() as unknown as ITransportClient['request'],
    requestWithAck: sandbox.stub().resolves({taskId: 'mock-task-id'}),
    ...overrides,
  }

  return mock
}

/**
 * Mock transport factory interface matching TransportClientFactory.
 */
export type MockTransportFactory = {
  connect: SinonStub<[fromDir?: string], Promise<ConnectionResult>>
}

/**
 * Creates a mock TransportClientFactory for testing use cases.
 *
 * @param sandbox - Sinon sandbox for creating stubs
 * @param mockClient - The mock transport client to return from connect()
 * @param projectRoot - Optional project root to return (default: '/mock/project')
 * @returns Mock factory with connect() stub
 *
 * @example
 * ```ts
 * const mockClient = createMockTransportClient(sandbox)
 * const mockFactory = createMockTransportFactory(sandbox, mockClient)
 *
 * // Override to throw error
 * mockFactory.connect.rejects(new NoInstanceRunningError())
 * ```
 */
export function createMockTransportFactory(
  sandbox: SinonSandbox,
  mockClient: ITransportClient,
  projectRoot = '/mock/project',
): MockTransportFactory {
  return {
    connect: sandbox.stub<[fromDir?: string], Promise<ConnectionResult>>().resolves({
      client: mockClient,
      projectRoot,
    }),
  }
}
