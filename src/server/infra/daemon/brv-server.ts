/**
 * Daemon entry point — standalone Node.js process.
 *
 * This file is spawned as a detached child process by any client
 * (TUI, MCP, CLI) via `brv-transport-client`. It does NOT depend
 * on oclif or any CLI framework.
 *
 * Hosts the Socket.IO transport server directly. All clients (TUI, CLI,
 * MCP, agent child processes) connect to this single server.
 *
 * Startup sequence:
 * 1. Setup daemon logging
 * 2. Select port (random batch scan in dynamic range 49152-65535)
 * 3. Acquire global instance lock (atomic temp+rename)
 * 4. Construct Socket.IO transport server (start() is deferred — see step 11)
 * 5. Start heartbeat writer
 * 6. Install daemon resilience handlers
 * 7. Create services (auth, project state, agent pool, handlers)
 * 8. Wire events (idle timeout, auth broadcasts, state server)
 * 9. Create shutdown handler
 * 10. Start idle timer + register signal handlers
 * 11. Start Socket.IO transport server (port opens — clients can connect)
 */

import {GlobalInstanceManager} from '@campfirein/brv-transport-client'
import express from 'express'
import {fork, type StdioOptions} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdirSync, readdirSync, readFileSync, unlinkSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import type {BrvConfig} from '../../core/domain/entities/brv-config.js'

import {ReviewEvents} from '../../../shared/transport/events/review-events.js'
import {TaskEvents, type TaskHeartbeatEvent} from '../../../shared/transport/events/task-events.js'
import {
  WebuiEvents,
  type WebuiGetPortResponse,
  type WebuiSetPortRequest,
  type WebuiSetPortResponse,
} from '../../../shared/transport/events/webui-events.js'
import {
  AGENT_IDLE_CHECK_INTERVAL_MS,
  AGENT_IDLE_TIMEOUT_MS,
  BRV_DIR,
  HEARTBEAT_FILE,
  TASK_HEARTBEAT_INTERVAL_MS,
  WEBUI_DEFAULT_PORT,
} from '../../constants.js'
import {WebUiPortInUseError} from '../../core/domain/errors/webui-error.js'
import {
  type ProviderConfigResponse,
  type TaskQueryResultEvent,
  TransportStateEventNames,
  TransportTaskEventNames,
} from '../../core/domain/transport/schemas.js'
import {buildReviewUrl} from '../../utils/build-review-url.js'
import {getGlobalDataDir} from '../../utils/global-data-path.js'
import {crashLog, processLog} from '../../utils/process-logger.js'
import {createBillingStateHandler} from '../billing/billing-state-endpoint.js'
import {ClientManager} from '../client/client-manager.js'
import {ProjectConfigStore} from '../config/file-config-store.js'
import {readContextTreeRemoteUrl} from '../context-tree/read-context-tree-remote.js'
import {DreamStateService} from '../dream/dream-state-service.js'
import {DreamTrigger} from '../dream/dream-trigger.js'
import {broadcastToProjectRoom} from '../process/broadcast-utils.js'
import {CurateLogHandler} from '../process/curate-log-handler.js'
import {setupFeatureHandlers} from '../process/feature-handlers.js'
import {QueryLogHandler} from '../process/query-log-handler.js'
import {TaskHeartbeatManager} from '../process/task-heartbeat-manager.js'
import {TaskHistoryHook} from '../process/task-history-hook.js'
import {configureTaskHistoryStoreCache, getStore as getTaskHistoryStore} from '../process/task-history-store-cache.js'
import {TransportHandlers} from '../process/transport-handlers.js'
import {ProjectRegistry} from '../project/project-registry.js'
import {createProviderOAuthTokenStore} from '../provider-oauth/provider-oauth-token-store.js'
import {TokenRefreshManager} from '../provider-oauth/token-refresh-manager.js'
import {clearStaleProviderConfig, resolveProviderConfig} from '../provider/provider-config-resolver.js'
import {ProjectRouter} from '../routing/project-router.js'
import {AuthStateStore} from '../state/auth-state-store.js'
import {ProjectStateLoader} from '../state/project-state-loader.js'
import {FileBillingConfigStore} from '../storage/file-billing-config-store.js'
import {FileProviderConfigStore} from '../storage/file-provider-config-store.js'
import {FileSettingsStore} from '../storage/file-settings-store.js'
import {createProviderKeychainStore} from '../storage/provider-keychain-store.js'
import {createTokenStore} from '../storage/token-store.js'
import {SocketIOTransportServer} from '../transport/socket-io-transport-server.js'
import {createWebUiMiddleware} from '../webui/webui-middleware.js'
import {WebUiServer} from '../webui/webui-server.js'
import {
  readWebuiPreferredPort,
  removeWebuiState,
  writeWebuiPreferredPort,
  writeWebuiState,
} from '../webui/webui-state.js'
import {AgentIdleTimeoutPolicy} from './agent-idle-timeout-policy.js'
import {AgentPool} from './agent-pool.js'
import {DaemonResilience} from './daemon-resilience.js'
import {HeartbeatWriter} from './heartbeat.js'
import {IdleTimeoutPolicy} from './idle-timeout-policy.js'
import {selectDaemonPort} from './port-selector.js'
import {bootstrapSettings} from './settings-bootstrap.js'
import {ShutdownHandler} from './shutdown-handler.js'

function log(msg: string): void {
  processLog(`[Daemon] ${msg}`)
}

/**
 * Reads the CLI version from package.json.
 * Walks up from the compiled file location to find the project root.
 */
function readCliVersion(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    // Both src/ and dist/ are 4 levels deep: server/infra/daemon/brv-server
    const pkgPath = join(currentDir, '..', '..', '..', '..', 'package.json')
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
      return pkg.version
    }
  } catch {
    // Best-effort — return fallback
  }

  return 'unknown'
}

/**
 * Removes old daemon log files, keeping the most recent ones.
 * Filenames are timestamp-based (`server-YYYY-MM-DDTHH-MM-SS.log`),
 * so alphabetical sort = chronological order.
 */
function cleanupOldLogs(logsDir: string, keep: number): void {
  try {
    const files = readdirSync(logsDir)
      .filter((f) => f.startsWith('server-') && f.endsWith('.log'))
      .sort()

    if (files.length <= keep) return

    const toDelete = files.slice(0, files.length - keep)
    for (const file of toDelete) {
      try {
        unlinkSync(join(logsDir, file))
      } catch {
        // Best-effort per file
      }
    }
  } catch {
    // Best-effort — don't block daemon startup
  }
}

async function main(): Promise<void> {
  // 1. Setup daemon logging at <global-data-dir>/logs/server-<timestamp>.log
  const daemonLogsDir = join(getGlobalDataDir(), 'logs')
  mkdirSync(daemonLogsDir, {recursive: true})
  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-').slice(0, 19)
  process.env.BRV_SESSION_LOG = join(daemonLogsDir, `server-${timestamp}.log`)

  // Best-effort cleanup of old daemon log files (keep last 10)
  cleanupOldLogs(daemonLogsDir, 10)

  log('Starting daemon...')

  // 2. Select port (random batch scan in dynamic range 49152-65535)
  const portResult = await selectDaemonPort()
  if (!portResult.success) {
    log('Failed to find available port for daemon (dynamic port range 49152-65535 exhausted)')
    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
    process.exit(1)
  }

  const {port} = portResult
  log(`Selected port ${port}`)

  // 3. Acquire global instance lock (atomic temp+rename)
  const version = readCliVersion()
  const instanceManager = new GlobalInstanceManager()
  const acquireResult = instanceManager.acquire(port, version)
  if (!acquireResult.acquired) {
    if (acquireResult.reason === 'already_running') {
      log(
        `Another daemon already running (PID: ${acquireResult.existingInstance.pid}, port: ${acquireResult.existingInstance.port})`,
      )
    } else {
      log(`Failed to acquire instance lock: ${acquireResult.reason}`)
    }

    // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
    process.exit(1)
  }

  log(`Instance acquired (PID: ${process.pid}, port: ${port})`)
  const daemonStartedAt = Date.now()

  // Steps 4-10 are wrapped so that partial startup is cleaned up.
  // Without this, a partial startup leaves daemon.json pointing to
  // a dead PID and may leak the port until stale-detection kicks in.
  //
  // Hoisted so the catch block can stop whatever was started.
  let transportServer: SocketIOTransportServer | undefined
  let heartbeatWriter: HeartbeatWriter | undefined
  let authStateStore: AuthStateStore | undefined
  let agentPool: AgentPool | undefined
  let webuiServer: undefined | WebUiServer
  let webuiBootFailure: undefined | {conflictPort: number; reason: 'port_in_use'}

  try {
    // 4a. Construct transport server. start() is deferred to step 11 so all handlers register before sockets connect.
    transportServer = new SocketIOTransportServer()

    // 4b. Start Web UI server on stable port (separate from transport)
    const daemonDir = dirname(fileURLToPath(import.meta.url))
    const projectRoot = join(daemonDir, '..', '..', '..', '..')
    const webuiDistDir = join(projectRoot, 'dist', 'webui')
    // Port priority: env var > persisted preference > default
    const webuiPortEnv = process.env.BRV_WEBUI_PORT
    const webuiPort = webuiPortEnv
      ? Number.parseInt(webuiPortEnv, 10)
      : (readWebuiPreferredPort() ?? WEBUI_DEFAULT_PORT)

    const webuiApp = createWebUiMiddleware({
      getConfig: () => ({daemonPort: port, port: webuiPort, projectCwd: process.cwd(), version}),
      webuiDistDir,
    })

    const app = express()
    app.use(webuiApp)

    webuiServer = new WebUiServer(app)
    try {
      await webuiServer.start(webuiPort)
      writeWebuiState(webuiPort)
      log(`Web UI server started on port ${webuiPort}`)
    } catch (webuiError) {
      if (webuiError instanceof WebUiPortInUseError) {
        webuiBootFailure = {conflictPort: webuiError.port, reason: 'port_in_use'}
        log(`Web UI port ${webuiError.port} is already in use — Web UI unavailable`)
      } else {
        log(`Web UI start error: ${webuiError instanceof Error ? webuiError.message : String(webuiError)}`)
      }

      webuiServer = undefined
    }

    // 5. Start heartbeat writer. Must run before transport.start(): pollForDaemon SIGTERMs daemons with stale heartbeat.
    const heartbeatPath = join(getGlobalDataDir(), HEARTBEAT_FILE)
    heartbeatWriter = new HeartbeatWriter({
      filePath: heartbeatPath,
      log,
    })
    heartbeatWriter.start()

    // 6. Install daemon resilience (crash/signal/sleep handlers)
    const daemonResilience = new DaemonResilience({
      crashLog,
      log,
      onWake() {
        log('Wake from sleep detected — refreshing heartbeat')
        heartbeatWriter?.refresh()
      },
    })
    daemonResilience.install()

    // 7. Create services (auth, project state, agent pool, handlers)
    // Settings bootstrap: read settings.json once, apply user overrides to
    // AgentPool and task-history cache. Missing or invalid entries fall
    // back to defaults; parseErrors and rejected entries are logged here.
    const settingsStore = new FileSettingsStore()
    const resolvedSettings = await bootstrapSettings({log, store: settingsStore})
    configureTaskHistoryStoreCache({maxEntries: resolvedSettings.taskHistoryMaxEntries})

    const projectRegistry = new ProjectRegistry({log})
    const projectRouter = new ProjectRouter({transport: transportServer})
    const clientManager = new ClientManager()

    authStateStore = new AuthStateStore({log, tokenStore: createTokenStore()})
    const projectStateLoader = new ProjectStateLoader({
      configStore: new ProjectConfigStore(),
      log,
      projectRegistry,
    })

    // Shared queue-length resolver — used by both idle timeout policy and dream trigger
    const getQueueLength = (projectPath: string): number =>
      agentPool?.getQueueState().find((q) => q.projectPath === projectPath)?.queueLength ?? 0

    // Shared project-config resolver — used by the idle-dream dispatch and the
    // task-router resolver wired into TransportHandlers below. Both paths must
    // stamp the same reviewDisabled value so review semantics are consistent
    // regardless of dispatch source (CLI task:create vs idle trigger).
    const curateConfigStore = new ProjectConfigStore()
    const resolveReviewDisabled = async (projectPath: string): Promise<boolean> => {
      const config = await curateConfigStore.read(projectPath)
      return config?.reviewDisabled === true
    }

    // Shared dream pre-check trigger factory.
    // The lock service explicitly throws if invoked — gate 4 (lock) is the agent's job;
    // the daemon must only ever evaluate gates 1-3 via checkEligibility().
    const makeDreamPreCheckTrigger = (projectPath: string): DreamTrigger =>
      new DreamTrigger({
        dreamLockService: {
          tryAcquire() {
            throw new Error('Lock must not be acquired during daemon eligibility pre-check')
          },
        },
        dreamStateService: new DreamStateService({baseDir: join(projectPath, BRV_DIR)}),
        getQueueLength,
      })

    // Agent idle timeout policy — kills agents after period of inactivity
    const agentIdleTimeoutPolicy = new AgentIdleTimeoutPolicy({
      checkIntervalMs: AGENT_IDLE_CHECK_INTERVAL_MS,
      getQueueLength,
      log,
      async onAgentIdle(projectPath: string, queueLength: number) {
        // Don't kill agents that have queued tasks waiting
        if (queueLength > 0) {
          log(`Skipping idle cleanup: ${projectPath} has ${queueLength} queued tasks`)
          return
        }

        // Don't kill agents that are actively processing a task
        const entry = agentPool?.getEntries().find((e) => e.projectPath === projectPath)
        if (entry?.hasActiveTask) {
          log(`Skipping idle cleanup: ${projectPath} has active task`)
          return
        }

        // Check dream eligibility before killing (gates 1-3 only, no lock).
        // Lock acquisition happens in the agent process when the dream task executes.
        try {
          const result = await makeDreamPreCheckTrigger(projectPath).checkEligibility(projectPath)
          if (result.eligible) {
            log(`Dream eligible, dispatching dream task: ${projectPath}`)
            // Idle dispatch bypasses TaskRouter.handleTaskCreate, so the
            // reviewDisabled snapshot that the task-router stamps for the CLI
            // path must be reproduced inline here. Without it, idle dreams
            // would always default to review-enabled regardless of project
            // setting (see resolveReviewDisabled above).
            const reviewDisabled = await resolveReviewDisabled(projectPath)
            agentPool?.submitTask({
              clientId: 'daemon',
              content: 'Memory consolidation (idle trigger)',
              force: false,
              projectPath,
              reviewDisabled,
              taskId: randomUUID(),
              trigger: 'agent-idle',
              type: 'dream',
            })
            return
          }

          log(`Dream not eligible (${result.reason}), killing idle agent: ${projectPath}`)
        } catch {
          log(`Dream eligibility check failed, killing idle agent: ${projectPath}`)
        }

        agentPool?.handleAgentDisconnected(projectPath)
      },
      timeoutMs: AGENT_IDLE_TIMEOUT_MS,
    })

    // Agent pool with fork-based factory — each agent runs in its own process
    const currentDir = dirname(fileURLToPath(import.meta.url))
    const agentProcessPath = process.env.BRV_AGENT_PROCESS_PATH ?? join(currentDir, 'agent-process.js')

    agentPool = new AgentPool({
      agentIdleTimeoutPolicy,
      agentProcessFactory(projectPath) {
        // Prevent console window flash on Windows when forking agent processes.
        // windowsHide is supported at runtime (fork delegates to spawn) but not in ForkOptions types,
        // so we extract the options to a variable to bypass excess property checking.
        const e2eStdio: StdioOptions = ['ignore', 'inherit', 'inherit', 'ipc']
        const forkOptions = {
          cwd: projectPath,
          env: {
            ...process.env,
            BRV_AGENT_PORT: String(port),
            BRV_AGENT_PROJECT_PATH: projectPath,
          },
          // In E2E mode, inherit stderr to see agent errors
          stdio: process.env.BRV_E2E_MODE === 'true' ? e2eStdio : undefined,
          windowsHide: true,
        }
        return fork(agentProcessPath, [], forkOptions)
      },
      log,
      maxConcurrentTasks: resolvedSettings.agentMaxConcurrentTasks,
      maxSize: resolvedSettings.agentPoolMaxSize,
      transportServer,
    })

    // Start agent idle timeout policy
    agentIdleTimeoutPolicy.start()

    const curateLogHandler = new CurateLogHandler(undefined, (info) => {
      const webuiPort = webuiServer?.getPort()
      const payload = webuiPort
        ? {pendingCount: info.pendingCount, reviewUrl: buildReviewUrl(webuiPort, info.projectPath), taskId: info.taskId}
        : {pendingCount: info.pendingCount, taskId: info.taskId}
      // Send directly to the task originator (covers CLI clients not in the project room)
      transportServer!.sendTo(info.clientId, ReviewEvents.NOTIFY, payload)
      // Also broadcast to the project room so TUI and other connected clients are notified
      broadcastToProjectRoom(
        projectRegistry,
        projectRouter,
        info.projectPath,
        ReviewEvents.NOTIFY,
        payload,
        info.clientId,
      )
    })

    const queryLogHandler = new QueryLogHandler()

    // Task-history hook — persists every lifecycle transition + accumulated
    // llmservice events to a per-project FileTaskHistoryStore. The store
    // factory is module-scoped so M2.09 wire handlers can read from the
    // same instances this hook writes to.
    const taskHistoryHook = new TaskHistoryHook({getStore: getTaskHistoryStore})

    // Provider config/keychain stores — shared between feature handlers and state endpoint.
    // Hoisted ahead of `new TransportHandlers` so the resolveActiveProvider callback below
    // can close over them and call resolveProviderConfig synchronously at task-create time.
    const providerConfigStore = new FileProviderConfigStore()
    const providerKeychainStore = createProviderKeychainStore()
    const providerOAuthTokenStore = createProviderOAuthTokenStore()

    // Token refresh manager — transparently refreshes OAuth tokens before they expire
    const tokenRefreshManager = new TokenRefreshManager({
      providerConfigStore,
      providerKeychainStore,
      providerOAuthTokenStore,
      transport: transportServer,
    })

    // Clear stale provider config on startup (e.g. migration from v1 system keychain to v2 file keystore).
    // If a provider is configured but its API key is no longer accessible, disconnect it so the user
    // is returned to the onboarding flow rather than hitting a cryptic API key error mid-task.
    await clearStaleProviderConfig(providerConfigStore, providerKeychainStore, providerOAuthTokenStore)

    // State endpoint: provider config — agents request this on startup and after provider:updated
    transportServer.onRequest<void, ProviderConfigResponse>(TransportStateEventNames.GET_PROVIDER_CONFIG, async () =>
      resolveProviderConfig({authStateStore, providerConfigStore, providerKeychainStore, tokenRefreshManager}),
    )

    // Per-task liveness ticker (M6 T1). Fires `TaskEvents.HEARTBEAT` to the
    // CLI during quiet periods so clients can distinguish "task still
    // progressing" from "daemon is stuck". Reset by every other task-scoped
    // emission inside the task router; cleared on the three terminal events.
    const taskHeartbeatManager = new TaskHeartbeatManager({
      emit(taskId, clientId, projectPath) {
        const payload: TaskHeartbeatEvent = {lastActivityAt: Date.now(), taskId}
        transportServer!.sendTo(clientId, TaskEvents.HEARTBEAT, payload)
        broadcastToProjectRoom(projectRegistry, projectRouter, projectPath, TaskEvents.HEARTBEAT, payload, clientId)
      },
      intervalMs: TASK_HEARTBEAT_INTERVAL_MS,
    })
    const billingConfigStoreFactory = (projectPath: string) =>
      new FileBillingConfigStore({baseDir: join(projectPath, BRV_DIR)})
    transportServer.onRequest(
      TransportStateEventNames.GET_BILLING_CONFIG,
      createBillingStateHandler(billingConfigStoreFactory),
    )

    const transportHandlers = new TransportHandlers({
      agentPool,
      clientManager,
      // The version we read at startup gets relayed in the client:register ack
      // so peer clients (TUI / MCP) can render drift indicators without an
      // extra round-trip.
      daemonVersion: version,
      getTaskHistoryStore,
      // Resolves the project's review-disabled flag once at task-create. The result
      // is stamped onto TaskInfo + TaskExecute so daemon hooks (CurateLogHandler) and
      // the agent process (curate-tool backups, dream review entries) all observe a
      // single value across the daemon→agent process boundary. Shared with the
      // idle-dream dispatch above so review semantics are identical regardless of
      // dispatch source (CLI task:create vs agent-idle trigger).
      isReviewDisabled: resolveReviewDisabled,
      lifecycleHooks: [curateLogHandler, queryLogHandler, taskHistoryHook],
      // Daemon-side gate for dream task:create — mirrors the idle-trigger pre-check
      // in this file so the CLI path (brv dream without --force) actually honors
      // gate 3 (queue). The agent-side check kept gate 3 hardcoded to skip,
      // which made the CLI ignore the spec when other tasks were queued.
      async preDispatchCheck(task, projectPath) {
        if (task.type !== 'dream' || task.force) return {eligible: true}
        if (!projectPath) return {eligible: true}

        try {
          const result = await makeDreamPreCheckTrigger(projectPath).checkEligibility(projectPath)
          return result.eligible ? {eligible: true} : {eligible: false, skipResult: `Dream skipped: ${result.reason}`}
        } catch {
          // Fail-open on pre-check errors: let the agent's own gate check be the fallback.
          return {eligible: true}
        }
      },
      projectRegistry,
      projectRouter,
      // Stamp the active provider/model snapshot onto every created task so the
      // Web UI can display which provider handled which task. Failures are
      // swallowed by TaskRouter's safeResolveActiveProvider — never blocks dispatch.
      async resolveActiveProvider() {
        const config = await resolveProviderConfig({
          authStateStore,
          providerConfigStore,
          providerKeychainStore,
          tokenRefreshManager,
        })
        return {
          ...(config.activeModel ? {model: config.activeModel} : {}),
          ...(config.activeProvider ? {provider: config.activeProvider} : {}),
        }
      },
      taskHeartbeatManager,
      transport: transportServer,
    })
    transportHandlers.setup()

    // Wire query metadata from agent process → QueryLogHandler.
    // Agent sends task:queryResult BEFORE task:completed (Socket.IO preserves order),
    // so setQueryResult runs before onTaskCompleted merges the metadata.
    transportServer.onRequest<TaskQueryResultEvent, void>(TransportTaskEventNames.QUERY_RESULT, (data) => {
      queryLogHandler.setQueryResult(data.taskId, {
        matchedDocs: data.matchedDocs,
        searchMetadata: data.searchMetadata,
        tier: data.tier,
        timing: data.timing,
      })
    })

    // 8. Create idle timeout policy + shutdown handler
    //    (must be created before wiring closures that reference them)

    // onIdle captures shutdownHandler via closure; safe because
    // the callback only fires after start() + timeout, by which
    // point shutdownHandler is fully assigned below.
    // eslint-disable-next-line prefer-const
    let shutdownHandler: ShutdownHandler

    const idleTimeoutPolicy = new IdleTimeoutPolicy({
      log,
      onIdle() {
        log('Idle timeout reached — initiating shutdown')
        shutdownHandler.shutdown().catch((error: unknown) => {
          log(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`)
        })
      },
    })

    // 9. Create shutdown handler (agent pool shut down before transport)
    shutdownHandler = new ShutdownHandler({
      agentIdleTimeoutPolicy,
      agentPool,
      daemonResilience,
      heartbeatWriter,
      idleTimeoutPolicy,
      instanceManager,
      log,
      transportServer,
      webuiServer,
    })

    // 10. Wire events (state server, idle timeout)
    // Note: auth change broadcasting (onAuthChanged/onAuthExpired) is handled by AuthHandler
    // in setupFeatureHandlers(). loadToken() + startPolling() are called after feature handlers
    // are registered so AuthHandler's callbacks are in place.

    // Wire project empty → mark agent idle for cleanup
    clientManager.onProjectEmpty((projectPath) => {
      agentPool!.markIdle(projectPath)
    })

    // Wire clientManager to idleTimeoutPolicy for daemon shutdown
    clientManager.onClientConnected(() => {
      idleTimeoutPolicy.onClientConnected()
    })
    clientManager.onClientDisconnected(() => {
      idleTimeoutPolicy.onClientDisconnected()
    })

    // State server endpoints — agent child processes request config on startup
    transportServer.onRequest<
      {projectPath: string},
      {brvConfig?: BrvConfig; remoteUrl?: string; spaceId: string; storagePath: string; teamId: string}
    >(TransportStateEventNames.GET_PROJECT_CONFIG, async (data) => {
      // Smart invalidation: only invalidate if config file was modified since last load
      // This prevents unnecessary disk I/O while still catching changes from
      // init/space-switch commands that write directly to disk
      const needsInvalidation = await projectStateLoader.shouldInvalidate(data.projectPath)
      if (needsInvalidation) {
        projectStateLoader.invalidate(data.projectPath)
        log(`Config invalidated due to file modification: ${data.projectPath}`)
      }

      const [config, remoteUrl] = await Promise.all([
        projectStateLoader.getProjectConfig(data.projectPath),
        readContextTreeRemoteUrl(data.projectPath),
      ])
      // Register project (idempotent) to ensure XDG storage directories exist
      const projectInfo = projectRegistry.register(data.projectPath)
      return {
        brvConfig: config,
        remoteUrl,
        spaceId: config?.spaceId ?? '',
        storagePath: projectInfo.storagePath,
        teamId: config?.teamId ?? '',
      }
    })

    transportServer.onRequest<void, {isValid: boolean; sessionKey: string}>(
      TransportStateEventNames.GET_AUTH,
      async () => {
        const token = await authStateStore!.loadToken()
        return {
          isValid: token?.isValid() ?? false,
          sessionKey: token?.sessionKey ?? '',
        }
      },
    )

    // Auth reload trigger — clients signal after login/logout for immediate propagation.
    // loadToken() reads from keychain, updates cache, and fires onAuthChanged → broadcast.
    transportServer.onRequest<void, {success: boolean}>('auth:reload', async () => {
      await authStateStore!.loadToken()
      return {success: true}
    })

    // Web UI port endpoint — used by `brv webui` to discover the stable port
    transportServer.onRequest<void, WebuiGetPortResponse>(WebuiEvents.GET_PORT, () => {
      const port = webuiServer?.getPort()
      if (port !== undefined) return {port}
      return webuiBootFailure ?? {reason: 'not_started'}
    })

    // Web UI set port — restarts webui server on new port and persists preference
    transportServer.onRequest<WebuiSetPortRequest, WebuiSetPortResponse>(WebuiEvents.SET_PORT, async (data) => {
      const newPort = data.port

      // Stop existing webui server if running
      if (webuiServer?.isRunning()) {
        await webuiServer.stop()
        log(`Stopped web UI server on port ${webuiServer.getPort() ?? '?'}`)
      }

      // Create fresh Express app for the new server
      const newWebuiApp = createWebUiMiddleware({
        getConfig: () => ({daemonPort: port, port: newPort, projectCwd: process.cwd(), version}),
        webuiDistDir,
      })
      const newApp = express()
      newApp.use(newWebuiApp)

      // Start on new port
      webuiServer = new WebUiServer(newApp)
      try {
        await webuiServer.start(newPort)
      } catch (error) {
        webuiServer = undefined
        if (error instanceof WebUiPortInUseError) {
          webuiBootFailure = {conflictPort: error.port, reason: 'port_in_use'}
          log(`Web UI port ${error.port} is already in use — keeping previous configuration`)
          return {conflictPort: error.port, reason: 'port_in_use'}
        }

        throw error
      }

      webuiBootFailure = undefined
      writeWebuiState(newPort)
      writeWebuiPreferredPort(newPort)
      log(`Web UI server restarted on port ${newPort} (persisted)`)

      return {port: newPort}
    })

    // Debug endpoint — exposes daemon internal state for `brv debug` command
    transportServer.onRequest<void, unknown>('daemon:getState', () => ({
      agentIdleStatus: agentIdleTimeoutPolicy.getIdleStatus(),
      agentPool: {
        entries: agentPool!.getEntries(),
        maxSize: resolvedSettings.agentPoolMaxSize,
        queue: agentPool!.getQueueState(),
        size: agentPool!.getSize(),
      },
      clients: clientManager.getAllClients().map((c) => ({
        agentName: c.agentName,
        connectedAt: c.connectedAt,
        id: c.id,
        projectPath: c.projectPath,
        type: c.type,
      })),
      daemon: {
        logPath: process.env.BRV_SESSION_LOG,
        pid: process.pid,
        port,
        startedAt: daemonStartedAt,
        uptime: Date.now() - daemonStartedAt,
        version,
      },
      daemonIdleStatus: idleTimeoutPolicy.getIdleStatus(),
      tasks: transportHandlers.getDebugState(),
      transport: {
        connectedSockets: transportServer!.getConnectedSocketCount(),
        port: transportServer!.getPort() ?? port,
        running: transportServer!.isRunning(),
      },
    }))

    // Feature handlers (auth, init, status, push, pull, etc.) require async OIDC discovery.
    // Placed after daemon:getState so the debug endpoint is available immediately,
    // without waiting for OIDC discovery (~400ms).
    await setupFeatureHandlers({
      authStateStore,
      billingConfigStoreFactory,
      broadcastToProject(projectPath, event, data) {
        broadcastToProjectRoom(projectRegistry, projectRouter, projectPath, event, data)
      },
      getActiveProjectPaths: () => clientManager.getActiveProjects(),
      log,
      projectRegistry,
      providerConfigStore,
      providerKeychainStore,
      providerOAuthTokenStore,
      resolveProjectPath: (clientId) => clientManager.getClient(clientId)?.projectPath,
      settingsStore,
      transport: transportServer,
      webuiPort: webuiServer?.getPort(),
    })

    // Load auth token AFTER feature handlers are registered.
    // AuthHandler's onAuthChanged/onAuthExpired callbacks must be wired first
    // so that loadToken() triggers proper broadcasts to TUI and agents.
    // Agents also request auth on-demand via state:getAuth, so this ordering is safe.
    await authStateStore.loadToken()
    authStateStore.startPolling()

    // 11. Start idle timer + register signal handlers
    idleTimeoutPolicy.start()

    process.once('SIGTERM', () => {
      log('SIGTERM received')
      shutdownHandler.shutdown().catch((error: unknown) => {
        log(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    process.once('SIGINT', () => {
      log('SIGINT received')
      shutdownHandler.shutdown().catch((error: unknown) => {
        log(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    // 11. All handlers registered — open the socket port now.
    await transportServer.start(port)
    log(`Transport server started on port ${port}`)

    log(`Daemon fully started (PID: ${process.pid}, port: ${port})`)
  } catch (error: unknown) {
    // Best-effort cleanup of anything started before the failure.
    // Each step is independent — continue cleanup even if one throws.
    if (agentPool) {
      await agentPool.shutdown().catch(() => {})
    }

    authStateStore?.stopPolling()
    heartbeatWriter?.stop()
    await webuiServer?.stop().catch(() => {})
    removeWebuiState()
    await transportServer?.stop().catch(() => {})
    instanceManager.release()
    throw error
  }
}

// Run the daemon
try {
  await main()
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  processLog(`[Daemon] Fatal startup error: ${message}`)
  // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
  process.exit(1)
}
