/**
 * Agent Process - Entry point for forked agent child processes.
 *
 * Each agent runs in its own Node.js process (child_process.fork())
 * to isolate from the daemon's event loop and prevent crash propagation.
 *
 * Lifecycle:
 * 1. Read BRV_AGENT_PORT and BRV_AGENT_PROJECT_PATH from process.env
 * 2. Create TransportClient, connect to daemon at 127.0.0.1:port
 * 3. Request initial project config + provider config from state server
 * 4. Listen for provider:updated events (hot-switch without restart)
 * 5. Create CipherAgent with lazy providers (resolved from local cache)
 * 6. Start agent + create session
 * 7. Send IPC { type: 'ready', clientId } to parent (AgentPool)
 * 8. Listen for task:execute events → execute via CurateExecutor/QueryExecutor
 * 9. Forward task lifecycle events (started, completed, error) via transport
 * 10. Handle SIGTERM for graceful shutdown
 *
 * Consumed by: AgentPool (forks this file via AgentProcessFactory)
 */

import {connectToTransport, type ITransportClient} from '@campfirein/brv-transport-client'
import {randomUUID} from 'node:crypto'
import {appendFileSync, existsSync} from 'node:fs'
import {basename, join, relative, sep} from 'node:path'

import type {ISearchKnowledgeService} from '../../../agent/infra/sandbox/tools-sdk.js'
import type {BrvConfig} from '../../core/domain/entities/brv-config.js'
import type {
  BillingPinChangedPayload,
  BillingStateResponse,
  ProviderConfigResponse,
  TaskExecute,
} from '../../core/domain/transport/schemas.js'
import type {IRuntimeSignalStore} from '../../core/interfaces/storage/i-runtime-signal-store.js'

import {SESSIONS_DIR} from '../../../agent/core/domain/session/session-metadata.js'
import {CipherAgent} from '../../../agent/infra/agent/index.js'
import {FileSystemService} from '../../../agent/infra/file-system/file-system-service.js'
import {FolderPackService} from '../../../agent/infra/folder-pack/folder-pack-service.js'
import {SessionMetadataStore} from '../../../agent/infra/session/session-metadata-store.js'
import {loadAgentSettingsSnapshot} from '../../../agent/infra/settings/agent-settings-snapshot.js'
import {FileKeyStorage} from '../../../agent/infra/storage/file-key-storage.js'
import {runWithReviewDisabled} from '../../../agent/infra/tools/implementations/curate-tool-task-context.js'
import {createSearchKnowledgeService} from '../../../agent/infra/tools/implementations/search-knowledge-service.js'
import {decodeCurateHtmlContent} from '../../../shared/transport/curate-html-content.js'
import {AuthEvents} from '../../../shared/transport/events/auth-events.js'
import {decodeQueryToolModeContent} from '../../../shared/transport/query-tool-mode-content.js'
import {decodeSearchContent} from '../../../shared/transport/search-content.js'
import {getCurrentConfig} from '../../config/environment.js'
import {BRV_DIR, CONTEXT_TREE_DIR, DEFAULT_LLM_MODEL, PROJECT} from '../../constants.js'
import {serializeTaskError, TaskError, TaskErrorCode} from '../../core/domain/errors/task-error.js'
import {loadSources} from '../../core/domain/source/source-schema.js'
import {
  TransportAgentEventNames,
  TransportDaemonEventNames,
  TransportStateEventNames,
  TransportTaskEventNames,
} from '../../core/domain/transport/schemas.js'
import {regenerateContextTreeIndex} from '../context-tree/index-generator.js'
import {RuntimeSignalStore} from '../context-tree/runtime-signal-store.js'
import {bumpSidecarOnCurateWrite} from '../context-tree/tool-mode-sidecar-updaters.js'
import {DreamLogStore} from '../dream/dream-log-store.js'
import {DreamStateService} from '../dream/dream-state-service.js'
import {type DreamKind, finalizeDreamSession, scanDreamCandidates} from '../dream/tool-mode/dream-session.js'
import {CurateExecutor} from '../executor/curate-executor.js'
import {FolderPackExecutor} from '../executor/folder-pack-executor.js'
import {QueryExecutor} from '../executor/query-executor.js'
import {SearchExecutor} from '../executor/search-executor.js'
import {backupContextTreeFile, buildCurateHtmlLogEntry} from '../process/curate-html-log.js'
import {validateHtmlTopic, writeHtmlTopic} from '../render/writer/html-writer.js'
import {FileCurateLogStore} from '../storage/file-curate-log-store.js'
import {FileReviewBackupStore} from '../storage/file-review-backup-store.js'
import {TaskUsageAggregator} from '../telemetry/task-usage-aggregator.js'
import {AgentInstanceDiscovery} from '../transport/agent-instance-discovery.js'
import {createAgentLogger} from './agent-logger.js'
import {PostWorkRegistry} from './post-work-registry.js'
import {resolveSessionId} from './session-resolver.js'
import {validateProviderForTask} from './task-validation.js'

/**
 * Build a per-task `llmservice:usage` listener that filters by `taskId` and
 * folds matching events into `aggregator`. Curate and query handlers both
 * use the same shape — keep them in sync via this helper.
 */
function makeUsageListener(
  taskId: string,
  aggregator: TaskUsageAggregator,
): (payload: {
  cacheCreationTokens?: number
  cachedInputTokens?: number
  durationMs: number
  inputTokens: number
  outputTokens: number
  taskId?: string
}) => void {
  return (payload) => {
    if (payload.taskId !== taskId) return
    aggregator.addUsage(
      {
        ...(payload.cacheCreationTokens !== undefined && {cacheCreationTokens: payload.cacheCreationTokens}),
        ...(payload.cachedInputTokens !== undefined && {cachedInputTokens: payload.cachedInputTokens}),
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
      },
      payload.durationMs,
    )
  }
}

// ============================================================================
// Environment
// ============================================================================

const portEnv = process.env.BRV_AGENT_PORT
const projectPathEnv = process.env.BRV_AGENT_PROJECT_PATH

if (!portEnv || !projectPathEnv) {
  // Always print to stderr so AgentPool / developers can diagnose boot failures
  // even when BRV_SESSION_LOG is not configured.
  console.error('agent-process: Missing BRV_AGENT_PORT or BRV_AGENT_PROJECT_PATH')

  const logPath = process.env.BRV_SESSION_LOG
  if (logPath) {
    appendFileSync(
      logPath,
      `${new Date().toISOString()} [agent-process] Missing BRV_AGENT_PORT or BRV_AGENT_PROJECT_PATH\n`,
    )
  }

  // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
  process.exit(1)
}

// After validation (unreachable if env vars are missing), safe to use as strings
const port = portEnv
const projectPath = projectPathEnv

const agentLog = createAgentLogger(process.env.BRV_SESSION_LOG, `[agent-process:${projectPath}]`)

/**
 * Holds detached post-curate work so `task:completed` can fire as soon as
 * the agent body finishes. Drained on shutdown to avoid truncated writes.
 */
const postWorkRegistry = new PostWorkRegistry({
  onError(_projectPath, error) {
    agentLog(`post-work error: ${error instanceof Error ? error.message : String(error)}`)
  },
})

/**
 * Persist a brand-new session's metadata and set it as active.
 * Best-effort — failures are logged but never block the caller.
 */
async function persistNewSession(sessionId: string, providerId: string): Promise<void> {
  try {
    const metadata = metadataStore.createSessionMetadata(sessionId, providerId)
    await metadataStore.saveSession(metadata)
    await metadataStore.setActiveSession(sessionId)
  } catch (error) {
    agentLog(`Session metadata persist failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Activate an existing session: load its metadata, update status + providerId, and set as active.
 * Preserves original createdAt, messageCount, summary, and other fields.
 * Best-effort — failures are logged but never block the caller.
 */
async function activateExistingSession(sessionId: string, providerId: string): Promise<void> {
  try {
    const existing = await metadataStore.getSession(sessionId)
    if (existing) {
      existing.status = 'active'
      existing.lastUpdated = new Date().toISOString()
      if (providerId) existing.providerId = providerId
      await metadataStore.saveSession(existing)
    } else {
      // Metadata file missing — fall back to creating new metadata
      const metadata = metadataStore.createSessionMetadata(sessionId, providerId)
      await metadataStore.saveSession(metadata)
    }

    await metadataStore.setActiveSession(sessionId)
  } catch (error) {
    agentLog(`Session metadata activate failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ============================================================================
// Local Config Cache
// ============================================================================

/**
 * Local cache for auth and project config, populated via transport events.
 * Lazy providers on CipherAgent resolve from this cache per HTTP request.
 */
let cachedSessionKey = ''
let cachedBrvConfig: BrvConfig | undefined
let cachedPinnedOrgId: string | undefined
let cachedSpaceId = ''
let cachedActiveProvider = ''
let cachedActiveModel = ''
let cachedProviderApiKey: string | undefined
let cachedProviderHeaders: string | undefined

// ============================================================================
// Provider Config (resolved by daemon via state:getProviderConfig)
// ============================================================================

let providerConfigDirty = false
let providerFetchRetries = 0
const MAX_PROVIDER_FETCH_RETRIES = 3

// Concurrent task tracking — guards config refresh and provider hot-swap
let activeTaskCount = 0

// ============================================================================
// Main
// ============================================================================

let agent: CipherAgent | undefined
let metadataStore: SessionMetadataStore
let transport: ITransportClient | undefined

async function start(): Promise<void> {
  // 1. Connect to daemon using standard connectToTransport API
  // Note: autoRegister=false because agents use agent:register (not client:register)
  // for special handling (agentClients map, pool notification on disconnect)
  const {client} = await connectToTransport(projectPath, {
    autoRegister: false,
    discovery: new AgentInstanceDiscovery({
      port: Number.parseInt(port, 10),
      projectPath,
    }),
  })
  transport = client
  const clientId = transport.getClientId()
  if (!clientId) {
    throw new Error('Transport connected but no clientId assigned')
  }

  agentLog(`Connected to daemon (clientId=${clientId})`)

  // Log socket disconnect — critical for diagnosing ping-timeout crashes
  transport.on('disconnect', (reason?: string) => {
    agentLog(`Transport socket DISCONNECTED reason=${reason ?? 'unknown'} activeTaskCount=${activeTaskCount}`)
  })
  transport.on('connect_error', (err?: Error) => {
    agentLog(`Transport connect_error: ${err?.message ?? 'unknown'}`)
  })

  // 2. Request initial project config from state server
  type ProjectConfigResponse = {
    brvConfig?: BrvConfig
    spaceId?: string
    storagePath: string
    teamId?: string
  }

  type AuthResponse = {
    isValid?: boolean
    sessionKey?: string
  }

  const [configResult, authResult, providerResult, billingResult] = await Promise.all([
    transport.requestWithAck<ProjectConfigResponse>(TransportStateEventNames.GET_PROJECT_CONFIG, {projectPath}),
    transport.requestWithAck<AuthResponse>(TransportStateEventNames.GET_AUTH),
    transport.requestWithAck<ProviderConfigResponse>(TransportStateEventNames.GET_PROVIDER_CONFIG),
    transport.requestWithAck<BillingStateResponse>(TransportStateEventNames.GET_BILLING_CONFIG, {projectPath}),
    loadAgentSettingsSnapshot(transport),
  ])

  cachedBrvConfig = configResult.brvConfig
  cachedSpaceId = configResult.spaceId ?? ''
  cachedSessionKey = authResult.sessionKey ?? ''
  cachedPinnedOrgId = billingResult.pinnedTeamId

  agentLog('Initial config loaded from state server')

  // 3. Listen for config/auth/provider updates from daemon
  transport.on<{brvConfig?: BrvConfig; projectPath: string; spaceId?: string; teamId?: string}>(
    'config:updated',
    (data) => {
      if (data.projectPath !== projectPath) return
      if (data.brvConfig) cachedBrvConfig = data.brvConfig
      if (data.spaceId !== undefined) cachedSpaceId = data.spaceId
    },
  )

  transport.on<{sessionKey?: string}>(AuthEvents.UPDATED, (data) => {
    if (data.sessionKey !== undefined) cachedSessionKey = data.sessionKey
  })

  transport.on(TransportDaemonEventNames.PROVIDER_UPDATED, () => {
    providerConfigDirty = true
    providerFetchRetries = 0
  })

  transport.on<BillingPinChangedPayload>(TransportDaemonEventNames.BILLING_PIN_CHANGED, (data) => {
    if (data.projectPath !== projectPath) return
    cachedPinnedOrgId = data.teamId
  })

  // 4. Provider config resolved by daemon (API key, base URL, headers, etc.)
  const {activeModel, activeProvider} = providerResult
  cachedActiveProvider = activeProvider
  cachedActiveModel = activeModel ?? DEFAULT_LLM_MODEL
  cachedProviderApiKey = providerResult.providerApiKey
  cachedProviderHeaders = providerResult.providerHeaders ? JSON.stringify(providerResult.providerHeaders) : undefined

  agentLog(`Provider: ${activeProvider}, Model: ${activeModel ?? 'default'}`)

  // 5. Create CipherAgent with lazy providers + transport client
  // Load knowledge sources early so shared context tree roots can be shared with both
  // the agent's FileSystemService (via config) and the executor's FileSystemService
  const sourcesData = loadSources(projectPath)
  const sharedAllowedPaths = (sourcesData?.origins ?? []).map((o) => o.contextTreeRoot)

  const envConfig = getCurrentConfig()
  const agentConfig = {
    apiBaseUrl: envConfig.llmBaseUrl,
    fileSystem: {allowedPaths: ['.', ...sharedAllowedPaths], workingDirectory: projectPath},
    llm: {
      maxIterations: 10,
      maxTokens: 4096,
      temperature: 0.7,
      topK: 10,
      topP: 0.95,
      verbose: false,
    },
    maxInputTokens: providerResult.maxInputTokens,
    model: activeModel ?? DEFAULT_LLM_MODEL,
    openRouterApiKey: providerResult.openRouterApiKey,
    projectId: PROJECT,
    provider: providerResult.provider,
    providerApiKey: providerResult.providerApiKey,
    providerBaseUrl: providerResult.providerBaseUrl,
    providerHeaders: providerResult.providerHeaders,
    storagePath: configResult.storagePath,
  }

  agent = new CipherAgent(agentConfig, cachedBrvConfig, {
    projectIdProvider: () => PROJECT,
    sessionKeyProvider: () => cachedSessionKey,
    spaceIdProvider: () => cachedSpaceId,
    teamIdProvider: () => cachedPinnedOrgId ?? '',
    transportClient: transport,
  })

  await agent.start()

  // 5b. Resolve session: resume last active or create new
  const sessionsDir = `${configResult.storagePath}/${SESSIONS_DIR}`
  metadataStore = new SessionMetadataStore({sessionsDir, workingDirectory: projectPath})

  const newId = `agent-session-${randomUUID()}`
  const {isResume, sessionId} = await resolveSessionId({
    currentProviderId: activeProvider,
    log: agentLog,
    metadataStore,
    newSessionId: newId,
  })

  await agent.createSession(sessionId)
  agent.switchDefaultSession(sessionId)

  await (isResume ? activateExistingSession(sessionId, activeProvider) : persistNewSession(sessionId, activeProvider))

  agentLog(`CipherAgent started (session=${sessionId}, resume=${isResume})`)

  // 6. Handle agent:newSession from /new command (via ConnectionCoordinator)
  const transportRef = transport
  transport.on<{reason?: string}>(TransportAgentEventNames.NEW_SESSION, async (data) => {
    agentLog(`New session requested: ${data.reason ?? 'no reason'}`)

    if (!agent) {
      await transportRef.requestWithAck(TransportAgentEventNames.NEW_SESSION_CREATED, {
        error: 'Agent not initialized',
        success: false,
      })
      return
    }

    try {
      // Mark current session as ended (best-effort)
      if (agent.sessionId) {
        try {
          const current = await metadataStore.getSession(agent.sessionId)
          if (current) {
            current.status = 'ended'
            current.lastUpdated = new Date().toISOString()
            await metadataStore.saveSession(current)
          }
        } catch {
          /* best-effort */
        }
      }

      const newSessionId = `agent-session-${randomUUID()}`
      await agent.createSession(newSessionId)
      agent.switchDefaultSession(newSessionId)

      await persistNewSession(newSessionId, cachedActiveProvider)

      agentLog(`New session created: ${newSessionId}`)

      await transportRef.requestWithAck(TransportAgentEventNames.NEW_SESSION_CREATED, {
        sessionId: newSessionId,
        success: true,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      agentLog(`New session creation error: ${message}`)
      await transportRef.requestWithAck(TransportAgentEventNames.NEW_SESSION_CREATED, {
        error: message,
        success: false,
      })
    }
  })

  // 6. Create FileSystemService + SearchKnowledgeService for smart query routing
  const fileSystemService = new FileSystemService({
    allowedPaths: ['.', ...sharedAllowedPaths],
    workingDirectory: projectPath,
  })
  await fileSystemService.initialize()

  // Runtime-signal sidecar for this daemon. FileKeyStorage is file-backed
  // under configResult.storagePath, so the daemon and any other process for
  // the same project write to the same on-disk store. `brv search`, curate,
  // and archive in this daemon all mirror scoring writes through it.
  const daemonKeyStorage = new FileKeyStorage({
    storageDir: configResult.storagePath,
  })
  await daemonKeyStorage.initialize()
  const daemonLogger = {
    debug: (msg: string): void => agentLog(msg),
    error: (msg: string): void => agentLog(msg),
    info: (msg: string): void => agentLog(msg),
    warn: (msg: string): void => agentLog(msg),
  }
  const daemonRuntimeSignalStore = new RuntimeSignalStore(daemonKeyStorage, daemonLogger)

  const searchService = createSearchKnowledgeService(fileSystemService, {
    baseDirectory: projectPath,
    runtimeSignalStore: daemonRuntimeSignalStore,
  })

  // 7. Create executors and listen for task:execute from pool
  const curateExecutor = new CurateExecutor()
  const folderPackService = new FolderPackService(fileSystemService)
  await folderPackService.initialize()
  const folderPackExecutor = new FolderPackExecutor(folderPackService)
  const queryExecutor = new QueryExecutor({
    baseDirectory: projectPath,
    enableCache: true,
    fileSystem: fileSystemService,
    searchService,
  })
  const searchExecutor = new SearchExecutor(searchService)

  transport.on<TaskExecute>(TransportTaskEventNames.EXECUTE, (task) => {
    agentLog(`task:execute received taskId=${task.taskId} type=${task.type} activeTaskCount=${activeTaskCount + 1}`)
    // eslint-disable-next-line no-void
    void executeTask(
      task,
      curateExecutor,
      folderPackExecutor,
      queryExecutor,
      searchExecutor,
      searchService,
      configResult.storagePath,
      daemonRuntimeSignalStore,
    )
  })

  // 8. Register with transport server (for TransportHandlers tracking)
  await transport.requestWithAck('agent:register', {projectPath})

  // 9. Notify parent that we're ready (IPC — AgentPool captures clientId)
  process.send?.({clientId, type: 'ready'})
  agentLog('Ready — listening for tasks')
}

async function executeTask(
  task: TaskExecute,
  curateExecutor: CurateExecutor,
  folderPackExecutor: FolderPackExecutor,
  queryExecutor: QueryExecutor,
  searchExecutor: SearchExecutor,
  searchKnowledgeService: ISearchKnowledgeService,
  storagePath: string,
  runtimeSignalStore: IRuntimeSignalStore,
): Promise<void> {
  const {clientCwd, clientId, content, files, folderPath, reviewDisabled, taskId, trigger, type, worktreeRoot} = task
  if (!transport || !agent) return

  // Search + tool-mode query + tool-mode curate are pure deterministic
  // paths — no LLM, no provider needed. Skip provider validation so they
  // work even without a configured provider (the headline promise of
  // tool mode).
  if (
    type !== 'search' &&
    type !== 'query-tool-mode' &&
    type !== 'curate-html-direct' &&
    type !== 'dream-scan' &&
    type !== 'dream-finalize'
  ) {
    const freshProviderConfig = await transport.requestWithAck<ProviderConfigResponse>(
      TransportStateEventNames.GET_PROVIDER_CONFIG,
    )
    const validationError = validateProviderForTask(freshProviderConfig)
    if (validationError) {
      transport.request(TransportTaskEventNames.ERROR, {clientId, error: validationError, taskId})
      return
    }
  }

  activeTaskCount++

  // Body of the task — extracted so the daemon-stamped reviewDisabled snapshot can be
  // opened as an AsyncLocalStorage scope around it. Tools that run inside this task
  // (curate-tool.executeCurate, including the sandbox `tools.curate(...)` path via
  // CurateService where _context.taskId is not threaded through) read the snapshot
  // from the ALS scope instead of re-reading .brv/config.json — that read can race
  // with mid-task user toggles, which is exactly the inconsistency we are eliminating.
  // We only open the scope when the daemon stamped a value; otherwise consumers fall
  // back to the file read, preserving behavior for legacy clients without a stamp.
  const runTaskBody = async (): Promise<void> => {
    // Re-narrow inside the closure: TypeScript loses the function-scope narrowing
    // from the early-return guard above once we hand control to a callback.
    if (!transport || !agent) return

    // Only refresh config and hot-swap provider when this is the first concurrent task.
    // Subsequent concurrent tasks reuse cached config to avoid race conditions
    // on provider hot-swap (which replaces SessionManager).
    if (activeTaskCount === 1) {
      // Refresh config from state server to pick up changes from init/space-switch
      // (they write directly to disk, bypassing the agent's cached state)
      try {
        const configResult = await transport.requestWithAck<{brvConfig?: BrvConfig; spaceId?: string}>(
          TransportStateEventNames.GET_PROJECT_CONFIG,
          {projectPath},
        )
        if (configResult.brvConfig) cachedBrvConfig = configResult.brvConfig
        if (configResult.spaceId !== undefined) cachedSpaceId = configResult.spaceId
      } catch {
        agentLog('Failed to refresh config before task execution')
      }

      // Refresh provider config if changed (provider:updated event sets dirty flag)
      if (providerConfigDirty && agent) {
        const result = await hotSwapProvider(agent, transport)
        if (result.error) {
          try {
            transport.request(TransportTaskEventNames.ERROR, {clientId, error: result.error, taskId})
          } catch (error) {
            agentLog(
              `task:error send failed (hotSwap) taskId=${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }

          return
        }
      }
    }

    // Auth refresh always runs — auth can expire between any two tasks
    try {
      const authResult = await transport.requestWithAck<{isValid?: boolean; sessionKey?: string}>(
        TransportStateEventNames.GET_AUTH,
      )
      if (authResult.sessionKey !== undefined) cachedSessionKey = authResult.sessionKey
    } catch {
      agentLog('Failed to refresh auth before task execution')
    }

    // Setup per-task event forwarding — forwards llmservice:* events to daemon
    const cleanupForwarding = agent.setupTaskForwarding(taskId)

    // Emit task:started
    agentLog(`task:started taskId=${taskId} type=${type}`)
    try {
      transport.request(TransportTaskEventNames.STARTED, {taskId})
    } catch (error) {
      agentLog(`task:started send failed taskId=${taskId}: ${error instanceof Error ? error.message : String(error)}`)
      // Socket dropped — continue executing so we can still emit task:completed/error when socket reconnects
    }

    // Block new tree-writers until any detached Phase 4 from a prior task
    // on this project drains. `query` / `search` are intentionally NOT
    // gated — they read the manifest and tolerate a stale snapshot via
    // `readManifestIfFresh` + rebuild fallback, so blocking them would
    // be a needless latency hit. `dream-finalize` renames topic files
    // and so MUST gate (otherwise an in-flight Phase 4 `_index.md`
    // rebuild can reference files we just archived). `dream-scan` is
    // read-only but we gate it too so a scan never observes a tree
    // mid-rebuild and returns inconsistent candidates.
    if (
      type === 'curate' ||
      type === 'curate-folder' ||
      type === 'dream-finalize' ||
      type === 'dream-scan'
    ) {
      await postWorkRegistry.awaitProject(projectPath)
    }

    try {
      let result: string = ''
      let logId: string | undefined
      // Captured during curate / curate-folder; submitted to the registry
      // after `task:completed` so the user does not wait on Phase 4.
      let postWork: (() => Promise<void>) | undefined
      switch (type) {
        case 'curate': {
          // Subscribe a per-task usage aggregator to llmservice:usage events
          // (forwarded from session bus to agentEventBus via session-event-forwarder).
          // The executor's `onTelemetry` callback fires once at runAgentBody return —
          // happy path before the response, error path before throwing — and forwards
          // the rolled-up payload to the daemon via task:curateResult ahead of
          // task:completed/task:error. Phase 4 (detached post-work) runs after
          // task:completed, so its LLM calls intentionally don't roll into THIS
          // curate-log entry — same boundary as the rest of the daemon's
          // "completed" semantics.
          const curateAggregator = new TaskUsageAggregator(taskId)
          const curateUsageListener = makeUsageListener(taskId, curateAggregator)
          const curateAgentBus = agent.agentEventBus
          curateAgentBus?.on('llmservice:usage', curateUsageListener)
          try {
            const curateResult = await curateExecutor.runAgentBody(agent, {
              clientCwd,
              content,
              files,
              onTelemetry(record) {
                try {
                  // `transport` is hoisted as `let ... | undefined`; closure capture
                  // forces an explicit guard despite the outer-scope assignment.
                  transport?.request(TransportTaskEventNames.CURATE_RESULT, {
                    ...(record.format !== undefined && {format: record.format}),
                    taskId,
                    ...(record.timing !== undefined && {timing: record.timing}),
                    ...(record.usage !== undefined && {usage: record.usage}),
                  })
                } catch {
                  agentLog(`task:curateResult send failed taskId=${taskId}`)
                }
              },
              projectRoot: projectPath,
              taskId,
              usageAggregator: curateAggregator,
              worktreeRoot,
            })
            result = curateResult.response
            postWork = curateResult.finalize
          } finally {
            curateAgentBus?.off('llmservice:usage', curateUsageListener)
          }

          break
        }

        case 'curate-folder': {
          const folderResult = await folderPackExecutor.runAgentBody(agent, {
            clientCwd,
            content,
            folderPath: folderPath!,
            projectRoot: projectPath,
            taskId,
            worktreeRoot,
          })
          result = folderResult.response
          postWork = folderResult.finalize

          break
        }

        case 'curate-html-direct': {
          // Tool-mode curate: no LLM dispatch, no provider gate, no
          // usage aggregator. Calling agent (typically over MCP) has
          // already authored the <bv-topic> HTML; daemon validates +
          // writes the topic file. Single-shot, single round-trip.
          // Mirrors the post-ENG-2815 oclif `brv curate` writer-direct
          // flow but exposed as a daemon task type so MCP clients can
          // hit it the same way they hit `query-tool-mode`.
          const {confirmOverwrite, html, meta} = decodeCurateHtmlContent(content)
          const contextTreeRoot = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)

          // Pre-resolve the target path so we can report whether the
          // write replaced an existing file. validateHtmlTopic is
          // idempotent + cheap (parse5 only); writeHtmlTopic re-runs
          // it internally so we don't risk drift between checks.
          const preValidation = validateHtmlTopic(html)
          const absoluteTopicFilePath = preValidation.ok
            ? join(contextTreeRoot, `${preValidation.topicPath}.html`)
            : undefined
          const existedBefore = absoluteTopicFilePath !== undefined && existsSync(absoluteTopicFilePath)

          // Seed the review-backup BEFORE the destructive write. Without this,
          // a curate over an existing topic (confirmOverwrite=true, meta.impact=high)
          // creates a `reviewStatus: pending` log entry but leaves nothing for
          // `brv review reject` to restore from — review-handler.ts:152 treats
          // a missing backup as ADD and unlinks the file, destroying the user's
          // prior knowledge. Honors task.reviewDisabled and ENOENT gracefully.
          if (existedBefore && absoluteTopicFilePath !== undefined) {
            await backupContextTreeFile({
              absoluteFilePath: absoluteTopicFilePath,
              contextTreeRoot,
              reviewBackupStore: new FileReviewBackupStore(join(projectPath, BRV_DIR)),
              reviewDisabled: reviewDisabled ?? false,
            })
          }

          const startedAt = Date.now()
          const writeResult = await writeHtmlTopic({confirmOverwrite, contextTreeRoot, rawHtml: html})
          const completedAt = Date.now()

          // HITL log entry — restores `brv review pending` surfacing for
          // tool-mode curates. Pre-allocate the id via getNextId() so it
          // matches FileCurateLogStore's `cur-<timestamp>` ID_PATTERN; a
          // random UUID would silently be invisible to list()/getById().
          // Failed writes also get an entry (status: error) so the TUI
          // doesn't lie about what was attempted.
          let relativeFilePath: string | undefined
          let topicPathResolved: string | undefined
          if (writeResult.ok) {
            relativeFilePath = relative(contextTreeRoot, writeResult.filePath).replaceAll(sep, '/')
            topicPathResolved = preValidation.ok
              ? preValidation.topicPath
              : relativeFilePath.replace(/\.html$/, '')

            // Mirror the curate into the runtime-signal sidecar so prune (and
            // any future signal-driven ranking) has real data to work with.
            // Best-effort: never blocks the write that already succeeded;
            // pass an agentLog-backed logger so swallowed sidecar failures
            // (corrupt key store, permission denied) leave a breadcrumb in
            // the daemon session log instead of being silently invisible.
            await bumpSidecarOnCurateWrite({
              existedBefore,
              logger: {
                debug: (msg: string): void => agentLog(msg),
                error: (msg: string): void => agentLog(msg),
                info: (msg: string): void => agentLog(msg),
                warn: (msg: string): void => agentLog(msg),
              },
              relPath: relativeFilePath,
              store: runtimeSignalStore,
            })
          } else if (preValidation.ok) {
            topicPathResolved = preValidation.topicPath
          }

          try {
            const curateLogStore = new FileCurateLogStore({baseDir: storagePath})
            const entryId = await curateLogStore.getNextId()
            const logEntry = buildCurateHtmlLogEntry({
              completedAt,
              confirmOverwrite: Boolean(confirmOverwrite),
              existedBefore,
              // Absolute path — the review-handler treats `op.filePath` as
              // absolute and calls `relative(contextTreeDir, ...)` to derive
              // a display key. Storing a relative path here makes the entry
              // unmatchable in `brv review approve`.
              filePath: writeResult.ok ? writeResult.filePath : undefined,
              id: entryId,
              meta,
              reviewDisabled: reviewDisabled ?? false,
              startedAt,
              taskId,
              topicPath: topicPathResolved,
              writeResult,
            })
            await curateLogStore.save(logEntry)
            logId = entryId
          } catch (error) {
            // Logging must never block curate execution. Swallow + log
            // so a transient FS error doesn't fail an otherwise-successful
            // curate.
            agentLog(
              `curate-html-direct: failed to persist log entry for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }

          // Regenerate the context-tree index so the new topic appears in
          // index.html. Deferred to postWorkRegistry (drained below): it
          // runs after task:completed — off the user-facing latency path —
          // and is per-project serialized, so concurrent curate-html-direct
          // tasks cannot race on index.html.
          if (writeResult.ok) {
            postWork = () =>
              regenerateContextTreeIndex({
                contextTreeRoot,
                log: (msg) => agentLog(`curate-html-direct ${taskId}: ${msg}`),
                projectName: basename(projectPath),
              })
          }

          // Validation failures emit task:completed (NOT task:error) so
          // the calling agent sees the structured errors via the normal
          // result payload and can retry with corrected HTML. task:error
          // would force MCP clients into an isError path that some host
          // renderers collapse or truncate.
          result = writeResult.ok
            ? JSON.stringify({
                filePath: relativeFilePath,
                overwrote: existedBefore && Boolean(confirmOverwrite),
                status: 'ok',
                topicPath: topicPathResolved,
                // Omit `warnings` from the wire envelope when empty so
                // existing consumers (CI logs, MCP host renderers) do
                // not see a noisy `"warnings": []` on every clean write.
                ...(writeResult.warnings.length > 0 ? {warnings: writeResult.warnings} : {}),
              })
            : JSON.stringify({errors: writeResult.errors, status: 'validation-failed'})

          break
        }

        case 'dream-finalize': {
          // Archive the loser topics the agent picked. Stateless on
          // daemon side — `sessionId` is opaque; we don't track sessions
          // in v1. Writes a DreamLogEntry so `brv dream undo` can restore.
          const brvDir = join(projectPath, BRV_DIR)
          const contextTreeRoot = join(brvDir, CONTEXT_TREE_DIR)
          let parsed: {archive?: string[]; sessionId?: string}
          try {
            parsed = content ? JSON.parse(content) : {}
          } catch {
            result = JSON.stringify({error: 'dream-finalize: invalid JSON content', status: 'error'})
            break
          }

          const startedAt = Date.now()
          try {
            const finalizeResult = await finalizeDreamSession({
              archive: parsed.archive ?? [],
              brvDir,
              contextTreeRoot,
              runtimeSignalStore,
              sessionId: parsed.sessionId ?? '',
            })

            // Write a dream-log entry so `brv dream undo` can revert. Skipped
            // when nothing was actually archived — no-op finalizes shouldn't
            // pollute the undo history.
            if (finalizeResult.archived.length > 0) {
              const dreamLogStore = new DreamLogStore({baseDir: brvDir})
              const dreamStateService = new DreamStateService({baseDir: brvDir})
              const logId = await dreamLogStore.getNextId()
              const completedAt = Date.now()
              await dreamLogStore.save({
                completedAt,
                id: logId,
                operations: finalizeResult.archived.map((path) => ({
                  action: 'ARCHIVE',
                  file: path,
                  needsReview: false,
                  // Pre-archive metadata captured by finalizeDreamSession so
                  // undo can restore not just the file body but the mtime
                  // and runtime signals that drove the prune decision (e.g.
                  // importance < 35, stale-mtime > 60d). Without this,
                  // undo restores the file but resets observable state and
                  // the topic stops re-surfacing on the next prune scan.
                  previousMtimes: {[path]: finalizeResult.previousMtimes[path]},
                  previousSignals: {[path]: finalizeResult.previousSignals[path]},
                  previousTexts: {[path]: finalizeResult.previousTexts[path]},
                  reason: 'tool-mode dream finalize',
                  type: 'PRUNE',
                })),
                startedAt,
                status: 'completed',
                summary: {
                  consolidated: 0,
                  errors: 0,
                  flaggedForReview: 0,
                  pruned: finalizeResult.archived.length,
                  synthesized: 0,
                },
                taskId,
                trigger: trigger ?? 'cli',
              })
              await dreamStateService.update((state) => ({
                ...state,
                lastDreamAt: new Date().toISOString(),
                lastDreamLogId: logId,
                totalDreams: state.totalDreams + 1,
              }))

              // Archiving removed topics — refresh index.html so they
              // drop out of the navigation index. Deferred to
              // postWorkRegistry (per-project serialized, runs after
              // task:completed) — same rationale as curate-html-direct.
              postWork = () =>
                regenerateContextTreeIndex({
                  contextTreeRoot,
                  log: (msg) => agentLog(`dream-finalize ${taskId}: ${msg}`),
                  projectName: basename(projectPath),
                })

              result = JSON.stringify({
                archived: finalizeResult.archived,
                logId,
                skipped: finalizeResult.skipped,
                status: 'ok',
              })
            } else {
              result = JSON.stringify({
                archived: finalizeResult.archived,
                skipped: finalizeResult.skipped,
                status: 'ok',
              })
            }
          } catch (error) {
            result = JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              status: 'error',
            })
          }

          break
        }

        case 'dream-scan': {
          // Tool-mode dream — no LLM, no provider. The daemon enumerates
          // candidates and returns them; the calling agent does all
          // semantic judgment via brv-curate UPDATE/MERGE/ADD writes
          // before invoking dream-finalize to archive losers.
          const contextTreeRoot = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)
          let parsed: {kinds?: DreamKind[]; maxCandidates?: number; scope?: string}
          try {
            parsed = content ? JSON.parse(content) : {}
          } catch {
            result = JSON.stringify({error: 'dream-scan: invalid JSON content', status: 'error'})
            break
          }

          try {
            const scanResult = await scanDreamCandidates({
              contextTreeRoot,
              options: parsed,
              runtimeSignalStore,
              searchService: searchKnowledgeService,
            })
            result = JSON.stringify({...scanResult, status: 'ok'})
          } catch (error) {
            result = JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              status: 'error',
            })
          }

          break
        }

        case 'query': {
          // subscribe a per-task usage aggregator to llmservice:usage
          // events forwarded from the session bus. QueryExecutor reads the
          // rolled-up totals at completion and writes them to the result.
          const queryAggregator = new TaskUsageAggregator(taskId)
          const queryUsageListener = makeUsageListener(taskId, queryAggregator)
          const queryAgentBus = agent.agentEventBus
          queryAgentBus?.on('llmservice:usage', queryUsageListener)
          let queryResult
          try {
            queryResult = await queryExecutor.executeWithAgent(agent, {
              query: content,
              taskId,
              usageAggregator: queryAggregator,
              worktreeRoot,
            })
          } finally {
            queryAgentBus?.off('llmservice:usage', queryUsageListener)
          }

          result = queryResult.response

          // Send query metadata to daemon for QueryLogHandler (crosses process boundary via transport).
          // Must arrive BEFORE task:completed so setQueryResult runs before onTaskCompleted.
          try {
            transport.request(TransportTaskEventNames.QUERY_RESULT, {
              ...(queryResult.format !== undefined && {format: queryResult.format}),
              matchedDocs: queryResult.matchedDocs,
              searchMetadata: queryResult.searchMetadata,
              taskId,
              tier: queryResult.tier,
              timing: queryResult.timing,
              ...(queryResult.usage !== undefined && {usage: queryResult.usage}),
            })
          } catch {
            agentLog(`task:queryResult send failed taskId=${taskId}`)
          }

          break
        }

        case 'query-tool-mode': {
          // Tool-mode query: no LLM dispatch, no provider gate, no
          // usage aggregator. Daemon runs Tier 0/1 cache + Tier-2-style
          // retrieval (without the canRespondDirectly threshold) and
          // returns the wire envelope. Wire contract: bundled SKILL.md
          // (section 1, "Tool mode — run query without an LLM provider").
          const toolModeOptions = decodeQueryToolModeContent(content)
          const toolModeResult = await queryExecutor.executeToolMode({
            limit: toolModeOptions.limit,
            query: toolModeOptions.query,
            worktreeRoot,
          })
          result = JSON.stringify(toolModeResult)

          break
        }

        case 'search': {
          const searchOptions = decodeSearchContent(content)
          const searchResult = await searchExecutor.execute(searchOptions)
          result = JSON.stringify(searchResult)

          break
        }
      }

      // Emit task:completed BEFORE the detached Phase 4 so the user sees
      // the response as soon as the agent body finishes.
      agentLog(`task:completed taskId=${taskId}`)
      try {
        transport.request(TransportTaskEventNames.COMPLETED, {
          clientId,
          ...(logId ? {logId} : {}),
          projectPath,
          result,
          taskId,
        })
      } catch (error) {
        agentLog(
          `task:completed send failed taskId=${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }

      // Submit detached post-curate work to the registry. Mutex'd per project
      // and drained on shutdown so SIGTERM mid-work cannot truncate `_index.md`.
      if (postWork) {
        agentLog(`post-work queued taskId=${taskId}`)
        postWorkRegistry.submit(projectPath, postWork)
      }
    } catch (error) {
      // Emit task:error
      const errorData = serializeTaskError(error)
      agentLog(`task:error taskId=${taskId} error=${errorData.message}`)
      try {
        transport.request(TransportTaskEventNames.ERROR, {clientId, error: errorData, projectPath, taskId})
      } catch (error_) {
        agentLog(
          `task:error send failed taskId=${taskId}: ${error_ instanceof Error ? error_.message : String(error_)}`,
        )
      }
    } finally {
      cleanupForwarding?.()
    }
  }

  try {
    await (reviewDisabled === undefined ? runTaskBody() : runWithReviewDisabled(reviewDisabled, runTaskBody))
  } finally {
    activeTaskCount--

    // Deferred hot-swap when provider changed mid-task. Wait on detached
    // Phase 4 first — rebuilding SessionManager during an in-flight
    // `propagateStaleness` LLM call would silently corrupt Phase 4.
    // Reserve the swap slot synchronously by clearing the dirty flag now;
    // a task arriving during the awaitAll wait then sees a clean flag and
    // skips its inline swap, so only the deferred chain runs hotSwap.
    if (activeTaskCount === 0 && providerConfigDirty && agent && transport) {
      providerConfigDirty = false
      const swapAgent = agent
      const swapTransport = transport
      postWorkRegistry
        .awaitAll()
        .then(() => hotSwapProvider(swapAgent, swapTransport))
        .catch((error: unknown) => {
          providerConfigDirty = true
          agentLog(`deferred hotSwapProvider failed: ${error instanceof Error ? error.message : String(error)}`)
        })
    }
  }
}

// ============================================================================
// Provider Hot-Swap
// ============================================================================

/**
 * Hot-swap provider: fetch new config, replace SessionManager, create session.
 * Returns error payload if swap fails fatally (caller must abort task).
 *
 * If only the model changed (same provider), the session ID is reused on the
 * fresh SessionManager for metadata continuity (in-memory history is not preserved).
 * If only credentials changed (same provider and model), the session ID is reused
 * and the SessionManager is rebuilt with the new credentials. This covers token refresh,
 * auth method switches (API Key ↔ OAuth), and API key re-entry.
 * If the provider changed, a new session is created (history format is incompatible).
 */
async function hotSwapProvider(
  currentAgent: CipherAgent,
  transportClient: NonNullable<typeof transport>,
): Promise<{error?: ReturnType<typeof serializeTaskError>}> {
  // Phase 1: Fetch config (safe to fail — old provider still intact)
  let freshProvider: ProviderConfigResponse | undefined
  try {
    freshProvider = await transportClient.requestWithAck<ProviderConfigResponse>(
      TransportStateEventNames.GET_PROVIDER_CONFIG,
    )
  } catch (error) {
    agentLog(`Failed to fetch provider config: ${error instanceof Error ? error.message : String(error)}`)
    providerFetchRetries++
    if (providerFetchRetries >= MAX_PROVIDER_FETCH_RETRIES) {
      agentLog(`Provider config fetch failed ${providerFetchRetries} times, giving up`)
      providerConfigDirty = false
      providerFetchRetries = 0
    }

    // Leave providerConfigDirty=true so the next task retries
    return {}
  }

  if (!freshProvider) {
    providerConfigDirty = false
    providerFetchRetries = 0
    return {}
  }

  providerFetchRetries = 0
  const ap = freshProvider.activeProvider
  const newModel = freshProvider.activeModel ?? DEFAULT_LLM_MODEL
  const isProviderChange = ap !== cachedActiveProvider
  const isModelChange = newModel !== cachedActiveModel
  const isCredentialChange =
    freshProvider.providerApiKey !== cachedProviderApiKey ||
    (freshProvider.providerHeaders ? JSON.stringify(freshProvider.providerHeaders) : undefined) !==
      cachedProviderHeaders

  // Nothing actually changed (duplicate event) — skip
  if (!isProviderChange && !isModelChange && !isCredentialChange) {
    providerConfigDirty = false
    return {}
  }

  // TODO: Credential-only changes (e.g., OAuth token refresh) currently rebuild the entire
  // SessionManager, which destroys in-memory conversation history. A future
  // SessionManager.updateCredentials() method could swap LLM config in-place,
  // preserving sessions and avoiding history loss on hourly token refreshes.

  // Phase 2a: Replace SessionManager (if this throws, old SM remains intact)
  const previousSessionId = currentAgent.sessionId
  try {
    // Map fields explicitly to prevent accidental field leakage from ProviderConfigResponse
    currentAgent.refreshProviderConfig({
      maxInputTokens: freshProvider.maxInputTokens,
      model: newModel,
      openRouterApiKey: freshProvider.openRouterApiKey,
      provider: freshProvider.provider,
      providerApiKey: freshProvider.providerApiKey,
      providerBaseUrl: freshProvider.providerBaseUrl,
      providerHeaders: freshProvider.providerHeaders,
    })
  } catch (error) {
    // Old SM still intact — no recovery needed.
    // Clear dirty flag to prevent repeated failures with the same broken config.
    // A new provider:updated event (from any UI action) will re-trigger the swap.
    providerConfigDirty = false
    return {
      error: serializeTaskError(
        new TaskError(
          `Provider switch failed (SessionManager rebuild): ${error instanceof Error ? error.message : String(error)}`,
          TaskErrorCode.TASK_EXECUTION,
        ),
      ),
    }
  }

  // Phase 2b: Create session on the new SM (old SM is disposed at this point)
  try {
    if (isProviderChange || !previousSessionId) {
      // Provider changed: new session (history format incompatible across providers)
      const newSessionId = `agent-session-${randomUUID()}`
      await currentAgent.createSession(newSessionId)
      currentAgent.switchDefaultSession(newSessionId)
      await persistNewSession(newSessionId, ap)
    } else {
      // Model-only or credential-only change: reuse session ID for metadata continuity.
      // Note: in-memory conversation history is lost (new SessionManager has no sessions).
      // Only the session ID and persisted metadata are preserved.
      await currentAgent.createSession(previousSessionId)
      currentAgent.switchDefaultSession(previousSessionId)
      await activateExistingSession(previousSessionId, ap)
    }
  } catch (sessionError) {
    // SM was swapped but preferred session failed — attempt recovery with a fresh session
    agentLog(
      `Session creation failed after SM swap: ${sessionError instanceof Error ? sessionError.message : String(sessionError)}`,
    )
    try {
      const recoveryId = `agent-session-${randomUUID()}`
      await currentAgent.createSession(recoveryId)
      currentAgent.switchDefaultSession(recoveryId)
      await persistNewSession(recoveryId, ap)
      agentLog(`Recovery session created: ${recoveryId}`)
    } catch (error) {
      providerConfigDirty = false
      return {
        error: serializeTaskError(
          new TaskError(
            `Provider switch failed (session recovery): ${error instanceof Error ? error.message : String(error)}`,
            TaskErrorCode.TASK_EXECUTION,
          ),
        ),
      }
    }
  }

  providerConfigDirty = false
  cachedActiveProvider = ap
  cachedActiveModel = newModel
  cachedProviderApiKey = freshProvider.providerApiKey
  cachedProviderHeaders = freshProvider.providerHeaders ? JSON.stringify(freshProvider.providerHeaders) : undefined

  const changeType = isProviderChange ? 'provider' : isModelChange ? 'model' : 'credentials'
  agentLog(`Provider hot-swapped (${changeType}): ${ap}, Model: ${newModel}`)
  return {}
}

// ============================================================================
// Shutdown
// ============================================================================

async function shutdown(): Promise<void> {
  agentLog('Shutting down...')

  // Drain detached Phase 4 BEFORE stopping the agent — `propagateStaleness`
  // mid-write would otherwise leave `_index.md` truncated on SIGTERM.
  try {
    const drainStart = Date.now()
    const drainResult = await postWorkRegistry.drain(30_000)
    agentLog(
      `post-work drain (${Date.now() - drainStart}ms): drained=${drainResult.drained} abandoned=${drainResult.abandoned}`,
    )
  } catch (error) {
    agentLog(`post-work drain failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    if (agent) {
      await agent.stop()
      agent = undefined
    }
  } catch {
    // Best-effort
  }

  try {
    if (transport) {
      await transport.disconnect()
      transport = undefined
    }
  } catch {
    // Best-effort
  }

  agentLog('Shutdown complete')
}

// ============================================================================
// Signal Handlers
// ============================================================================

const cleanup = async (): Promise<void> => {
  await shutdown()
  // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
  process.exit(0)
}

process.once('SIGTERM', cleanup)
process.once('SIGINT', cleanup)
process.once('disconnect', cleanup)

process.on('uncaughtException', async (error) => {
  // appendFileSync is synchronous — guaranteed to write before process.exit(1)
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error)
  agentLog(`CRASH uncaughtException: ${stack}`)
  await shutdown().catch(() => {})
  // eslint-disable-next-line n/no-process-exit
  process.exit(1)
})

process.on('unhandledRejection', async (reason) => {
  const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  agentLog(`CRASH unhandledRejection: ${stack}`)
  await shutdown().catch(() => {})
  // eslint-disable-next-line n/no-process-exit
  process.exit(1)
})

// ============================================================================
// Run
// ============================================================================

try {
  await start()
} catch (error) {
  agentLog(`Fatal error during startup: ${error}`)
  await shutdown().catch(() => {})
  // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
  process.exit(1)
}
