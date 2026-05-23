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
import {nanoid} from 'nanoid'
import {fork, type StdioOptions} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {mkdirSync, readdirSync, readFileSync, unlinkSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import type {BrvConfig} from '../../core/domain/entities/brv-config.js'
import type {IChannelBroadcaster} from '../../core/interfaces/channel/i-channel-broadcaster.js'

import {InstallIdentityService} from '../../../agent/core/trust/install-identity-service.js'
import {PeerTreeIdentityService} from '../../../agent/core/trust/peer-tree-identity-service.js'
import {TofuStore} from '../../../agent/core/trust/tofu-store.js'
import {BridgeEvents, type BridgeWhoamiResponse} from '../../../shared/transport/events/bridge-events.js'
import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {ReviewEvents} from '../../../shared/transport/events/review-events.js'
import {TaskEvents, type TaskHeartbeatEvent} from '../../../shared/transport/events/task-events.js'
import {
  AGENT_IDLE_CHECK_INTERVAL_MS,
  AGENT_IDLE_TIMEOUT_MS,
  BRV_DIR,
  HEARTBEAT_FILE,
  TASK_HEARTBEAT_INTERVAL_MS,
  WEBUI_DEFAULT_PORT,
} from '../../constants.js'
import {
  type ProviderConfigResponse,
  type TaskCurateResultEvent,
  type TaskQueryResultEvent,
  TransportStateEventNames,
  TransportTaskEventNames,
} from '../../core/domain/transport/schemas.js'
import {buildReviewUrl} from '../../utils/build-review-url.js'
import {getGlobalDataDir} from '../../utils/global-data-path.js'
import {crashLog, processLog} from '../../utils/process-logger.js'
import {DaemonTokenProvider} from '../auth/daemon-token-provider.js'
import {allowlistFromEnv, makeOriginAllowlist} from '../auth/origin-allowlist.js'
import {createBillingStateHandler} from '../billing/billing-state-endpoint.js'
import {type AutoCreateQuota, createAutoCreateQuota} from '../channel/bridge/auto-create-quota.js'
import {BridgeConfigStore, resolveBridgeRuntimeConfig} from '../channel/bridge/bridge-config-store.js'
import {DEFAULT_BRIDGE_CONFIG} from '../channel/bridge/bridge-config.js'
import {BridgeDriverPool} from '../channel/bridge/bridge-driver-pool.js'
import {BridgeTranscriptService} from '../channel/bridge/bridge-transcript-service.js'
import {fetchAndPin, isL2CertExpired} from '../channel/bridge/identity-client.js'
import {registerIdentityServer} from '../channel/bridge/identity-server.js'
import {Libp2pHost} from '../channel/bridge/libp2p-host.js'
import {
  createDefaultRegistry as createDefaultParleyRegistry,
  ParleyAdapterNotFoundError,
} from '../channel/bridge/parley-adapter-registry.js'
import {createFileBackedSessionStore} from '../channel/bridge/parley-adapter-session-store.js'
import {registerParleyServer} from '../channel/bridge/parley-server.js'
import {createProfileConcurrencyGate} from '../channel/bridge/profile-concurrency-gate.js'
import {RemoteMemberDriver} from '../channel/bridge/remote-member-driver.js'
import {runChannelRecovery} from '../channel/channel-recovery.js'
import {ChannelStore} from '../channel/channel-store.js'
import {ChannelDoctorService} from '../channel/doctor-service.js'
import {FileDriverProfileStore} from '../channel/driver-profile-store.js'
import {AcpDriverPool} from '../channel/drivers/acp-driver-pool.js'
import {AcpDriver} from '../channel/drivers/acp-driver.js'
import {FileBrokerPersistence} from '../channel/drivers/broker-persistence.js'
import {CancelCoordinator} from '../channel/drivers/cancel-coordinator.js'
import {PermissionBroker} from '../channel/drivers/permission-broker.js'
import {ChannelOnboardService} from '../channel/onboard-service.js'
import {ChannelOrchestrator} from '../channel/orchestrator.js'
import {FileProfileMetadataStore} from '../channel/profile-metadata-store.js'
import {ChannelEventsWriter} from '../channel/storage/events-writer.js'
import {ChannelTurnIndexStore} from '../channel/storage/index-store.js'
import {ChannelSnapshotWriter} from '../channel/storage/snapshot-writer.js'
import {ChannelTranscriptGc} from '../channel/storage/transcript-gc.js'
import {ChannelTreeReader} from '../channel/storage/tree-reader.js'
import {TurnSequenceAllocator} from '../channel/storage/turn-sequence-allocator.js'
import {ChannelWriteSerializer} from '../channel/storage/write-serializer.js'
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
import {channelsEnabled, registerDisabledStubs} from '../transport/handlers/channel-disabled-handler.js'
import {ChannelHandler} from '../transport/handlers/channel-handler.js'
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
import {hasBridgePersistedState} from './bridge-startup-rebind.js'
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
 * Slice 9.4 — parse `BRV_CHANNEL_TRANSCRIPT_RETENTION_DAYS` env var.
 * Default 30 days (matches `FileQueryLogStore`'s retention pattern in
 * the broader codebase). 0 disables the GC sweep entirely. Negative or
 * unparseable values fall back to the default with a warning log line.
 */
// Bridge runtime config (auto-provision policy, parley profile, project
// root, max-concurrent-per-profile, delegate policy) used to be parsed
// directly from `BRV_BRIDGE_*` env vars inside this file. They are now
// resolved by `resolveBridgeRuntimeConfig()` in
// `channel/bridge/bridge-config-store.ts`, which merges env + the
// persisted `<dataDir>/state/bridge-config.json` file and writes
// env-supplied values back to that file. This fixes the silent
// degradation that hit operators when a daemon auto-respawned (without
// the env vars in scope) and fell back to mock-echo + pinned-only.
//
// `resolveBridgeRuntimeConfig` is called ONCE during bridge bootstrap
// below; the returned object replaces the legacy `parseAutoProvisionPolicy
// / parseBridgeProjectRoot / parseBridgeMaxConcurrent` helpers that
// previously lived here.

function parseChannelRetentionDays(): number {
  const raw = process.env.BRV_CHANNEL_TRANSCRIPT_RETENTION_DAYS
  if (raw === undefined || raw.trim() === '') return 30
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed < 0) {
    log(`invalid BRV_CHANNEL_TRANSCRIPT_RETENTION_DAYS=${raw}; defaulting to 30`)
    return 30
  }

  return parsed
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

  // Create the daemon-auth-token file EARLY in bootstrap so clients that
  // discover the daemon via `ensureDaemonRunning` always find a valid token
  // on disk by the time they're cleared to connect. The channel handler
  // bootstrap later in this file consumes this same token; the read is
  // idempotent so re-reading is safe.
  const daemonTokenProvider = await DaemonTokenProvider.boot()

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

  try {
    // 4a. Construct transport server. start() is deferred to step 11 so all handlers register before sockets connect.
    // Slice 3.5b: install the Phase-3 Origin allowlist as a handshake
    // middleware. Loopback origins are accepted by default; the env
    // `BRV_ALLOWED_ORIGINS` (comma-separated) extends the list for the
    // dev web UI / cloud-bridge cases.
    const channelOriginAllowlist = makeOriginAllowlist(allowlistFromEnv())
    transportServer = new SocketIOTransportServer({
      handshakeMiddleware: channelOriginAllowlist.socketioMiddleware,
    })

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
      log(
        `Web UI port ${webuiPort} is already in use. Web UI will not be available. Set BRV_WEBUI_PORT=<port> to use a different port.`,
      )
      log(`Web UI start error: ${webuiError instanceof Error ? webuiError.message : String(webuiError)}`)
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
    // payload now also carries `format` + `usage` for telemetry.
    transportServer.onRequest<TaskQueryResultEvent, void>(TransportTaskEventNames.QUERY_RESULT, (data) => {
      queryLogHandler.setQueryResult(data.taskId, {
        ...(data.format !== undefined && {format: data.format}),
        matchedDocs: data.matchedDocs,
        searchMetadata: data.searchMetadata,
        tier: data.tier,
        timing: data.timing,
        ...(data.usage !== undefined && {usage: data.usage}),
      })
    })

    // wire curate telemetry from agent process → CurateLogHandler.
    // Agent sends task:curateResult BEFORE task:completed (Socket.IO preserves
    // order), so setCurateUsage runs before onTaskCompleted merges the entry.
    transportServer.onRequest<TaskCurateResultEvent, void>(TransportTaskEventNames.CURATE_RESULT, (data) => {
      curateLogHandler.setCurateUsage(data.taskId, {
        ...(data.format !== undefined && {format: data.format}),
        ...(data.timing !== undefined && {timing: data.timing}),
        ...(data.usage !== undefined && {usage: data.usage}),
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
    transportServer.onRequest<void, {port?: number}>('webui:getPort', () => ({
      port: webuiServer?.getPort(),
    }))

    // Web UI set port — restarts webui server on new port and persists preference
    transportServer.onRequest<{port: number}, {port: number; success: boolean}>('webui:setPort', async (data) => {
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
      await webuiServer.start(newPort)
      writeWebuiState(newPort)
      writeWebuiPreferredPort(newPort)
      log(`Web UI server restarted on port ${newPort} (persisted)`)

      return {port: newPort, success: true}
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

    // Register channel-protocol handlers (Phase 1 — passive turns only).
    // CHANNEL_PROTOCOL.md §2 requires every channel:* request carry a daemon-
    // local auth token; that token was created early in bootstrap (above)
    // so it's on disk before any client could discover the daemon and try to
    // connect over socket.io.
    const channelWriteSerializer = new ChannelWriteSerializer()
    // Hoist these so Phase-3 recovery (below) can seed the writer's
    // lastSeqByTurn and walk events.jsonl via the tree reader.
    const channelEventsWriter = new ChannelEventsWriter({serializer: channelWriteSerializer})
    const channelTreeReader = new ChannelTreeReader()
    // Slice 9.3 — per-channel materialised index for fast list-turns +
    // lookback. Shares the serializer so concurrent index appends from
    // multiple terminal turns on the same channel don't tear the JSONL.
    const channelIndexStore = new ChannelTurnIndexStore({serializer: channelWriteSerializer})
    // Slice 9.4 — periodic transcript GC. Default retention 30 days,
    // configurable via BRV_CHANNEL_TRANSCRIPT_RETENTION_DAYS. Setting
    // to 0 disables sweep. Triggered fire-and-forget from the
    // orchestrator's terminal path so an active channel naturally
    // catches up on retention as it sees new finished turns.
    const channelRetentionDays = parseChannelRetentionDays()
    const channelTranscriptGc = new ChannelTranscriptGc({
      indexStore: channelIndexStore,
      retentionDays: channelRetentionDays,
      serializer: channelWriteSerializer,
    })
    const channelStore = new ChannelStore({
      eventsWriter: channelEventsWriter,
      indexStore: channelIndexStore,
      // Slice 9.2: snapshot-writer routes structural lines through the
      // events-writer's held per-turn stream + per-turn lock so terminal
      // writes never tear concurrent in-flight event appends and we
      // don't pay the open/close syscall pair per terminal record.
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: channelEventsWriter}),
      transcriptGc: channelTranscriptGc,
      treeReader: channelTreeReader,
      writeSerializer: channelWriteSerializer,
    })

    const channelTransport = transportServer
    const channelPool = new AcpDriverPool()
    // Phase-3 (Slice 3.5c): persisted permission state. The broker
    // appends `track`/`resolve` lines so daemon restart can re-emit
    // `delivery_state_change → errored` for any orphaned permission.
    const channelBrokerPersistence = new FileBrokerPersistence({dataDir: getGlobalDataDir()})
    const channelBroker = new PermissionBroker({persistence: channelBrokerPersistence})
    const channelSeqAllocator = new TurnSequenceAllocator()
    const channelBroadcaster: IChannelBroadcaster = {
      broadcastToChannel(channelId, event, data) {
        channelTransport.broadcastTo(`channel:${channelId}`, event, data)
      },
    }
    const channelCancelCoordinator = new CancelCoordinator({
      broker: channelBroker,
      pool: channelPool,
      seqAllocator: channelSeqAllocator,
      async writeEvent(event, ctx) {
        await channelStore.appendTurnEvent({channelId: ctx.channelId, event, projectRoot: ctx.projectRoot, turnId: ctx.turnId})
        channelBroadcaster.broadcastToChannel(ctx.channelId, ChannelEvents.TURN_EVENT, {channelId: ctx.channelId, event})
      },
    })
    const channelProfileStore = new FileDriverProfileStore({dataDir: getGlobalDataDir()})
    const channelProfileMetadataStore = new FileProfileMetadataStore({dataDir: getGlobalDataDir()})
    const channelDriverFactory = (invocation: import('../channel/onboard-service.js').OnboardArgs['invocation'], handle: string) =>
      new AcpDriver({handle, invocation})

    // Phase 9 / Slice 9.4 — lazy-instantiated bridge primitives.
    // The libp2p host + L1/L2 identity services are only created when
    // the first remote-peer invite arrives OR when the daemon detects
    // a persisted remote-peer member on restart, so installs that
    // never use cross-host channels don't pay the libp2p startup cost.
    //
    // Slice 9.4b — the daemon ALSO registers the inbound identity +
    // parley servers on the same host, so Alice's daemon can dial
    // Bob's daemon directly (no separate `brv bridge listen` needed
    // for production). The `brv bridge listen` CLI remains as a
    // debugging surface.
    const bridgeIdentityDir = join(getGlobalDataDir(), 'identity')
    const bridgeInstall = new InstallIdentityService({installDir: bridgeIdentityDir})
    const bridgeL2 = new PeerTreeIdentityService({install: bridgeInstall})
    const bridgeTofu = new TofuStore({storePath: join(bridgeIdentityDir, 'known-peers.jsonl')})
    let bridgeHostPromise: Promise<Libp2pHost> | undefined
    // Slice 9.4f — closed-over so the shutdown hook can stop every
    // warm parley driver. Assigned inside ensureBridgeHost when a
    // BRV_BRIDGE_PARLEY_PROFILE is set; remains undefined for the
    // mock-echo path.
    let bridgeDriverPool: BridgeDriverPool | undefined
    // Phase 9.5.4 deferral (§6) — shared quota instance used by BOTH
    // BridgeTranscriptService (tryConsume on auto-create) and
    // ChannelOrchestrator (reset on uninvite). Created once here so both
    // share the same in-memory counter.
    const bridgeAutoCreateQuota: AutoCreateQuota = createAutoCreateQuota({log})
    const ensureBridgeHost = async (): Promise<Libp2pHost> => {
      if (bridgeHostPromise === undefined) {
        bridgeHostPromise = (async () => {
          await bridgeInstall.loadOrGenerate()
          await bridgeL2.loadOrGenerate()

          // Resolve persisted bridge runtime config (env > file > default)
          // BEFORE constructing the libp2p host — cross-machine deployments
          // set `BRV_BRIDGE_LISTEN_ADDRS` so the daemon binds on a routable
          // interface (e.g. `/ip4/0.0.0.0/tcp/60001` or a Tailscale-IP'd
          // multiaddr) instead of the loopback-only default. Other resolved
          // values (parley profile, auto-provision policy, etc.) are read
          // again below for the parley-server wiring.
          const bridgeConfigStore = new BridgeConfigStore({stateDir: join(getGlobalDataDir(), 'state')})
          const bridgeRuntime = resolveBridgeRuntimeConfig({log, store: bridgeConfigStore})
          // `listen_addrs` is the on-disk snake_case field per
          // `BridgeConfig` (mirrors §6.5 on-disk JSON shape per the
          // file-level comment in bridge-config.ts).
          const bridgeListenConfig: typeof DEFAULT_BRIDGE_CONFIG =
            bridgeRuntime.listenAddrs === undefined
              ? DEFAULT_BRIDGE_CONFIG
              // eslint-disable-next-line camelcase
              : {...DEFAULT_BRIDGE_CONFIG, listen_addrs: [...bridgeRuntime.listenAddrs]}
          if (bridgeRuntime.listenAddrs !== undefined) {
            log(`Bridge listen_addrs: ${bridgeRuntime.listenAddrs.join(', ')}`)
          }

          const host = new Libp2pHost({config: bridgeListenConfig, identity: bridgeInstall})
          await host.start()
          // Register inbound handlers BEFORE returning so the host is
          // dial-ready in both directions by the time any caller uses it.
          //
          // TODO(9.4c): read acceptModes + tofuPolicy from a daemon-level
          // BridgeConfig instead of hardcoding (kimi round-1 LOW). Org
          // deployments that want `accept_modes: ['ca-issued-tree']` or
          // `tofu_policy: 'deny'` are currently ignored by the daemon
          // listener.
          // Slice 9.4d — pass `l2Identity` so the identity-server also
          // publishes the L2 tree cert via `/brv/identity/tree-cert/v1`
          // for in-band L2 discovery (operators no longer paste
          // `--l2-pub-key` on every invite).
          await registerIdentityServer({host, identity: bridgeInstall, l2Identity: bridgeL2})

          // `bridgeRuntime` was already resolved above (before host
          // construction so that `BRV_BRIDGE_LISTEN_ADDRS` could
          // override the loopback-only default).

          // Slice 9.4c — opt-in real ACP dispatch via the
          // `BRV_BRIDGE_PARLEY_PROFILE` env var (now via the
          // resolved runtime config). When unset, the parley-server
          // falls back to mock-echo (existing 9.4a/b behaviour).
          //
          // Slice 9.4f — when a profile is set, also wire a profile-
          // keyed warm driver pool so inbound parleys reuse one ACP
          // subprocess per profile (instead of spawning per query).
          // The cap from `BRV_BRIDGE_MAX_CONCURRENT_PER_PROFILE`
          // bounds concurrent in-flight prompts; excess queries
          // surface as signed `PARLEY_LOCAL_AGENT_BUSY` errors.
          const {parleyProfile} = bridgeRuntime
          const bridgeMaxConcurrent = bridgeRuntime.maxConcurrentPerProfile
          // Assigned to the outer-scoped variable so the shutdown
          // hook can call closeAll().
          bridgeDriverPool =
            parleyProfile === undefined ? undefined : new BridgeDriverPool({maxPerProfile: bridgeMaxConcurrent})

          // Phase 9.5.2 / 9.5.3 — build the adapter registry and pass it as
          // a registry+profile pair so the parley-server can resolve the
          // active adapter by name. Behaviour is identical to pre-refactor:
          // ACP profile → local-agent adapter; unset → mock-echo.
          //
          // Phase 9.5.3: wire in session store + concurrency gate for the
          // ClaudeCodeHeadlessAdapter (registered only when
          // BRV_BRIDGE_CLAUDE_UNSAFE=1).
          const parleyConcurrencyGate = createProfileConcurrencyGate({
            maxConcurrent: bridgeMaxConcurrent,
          })
          const parleySessionStore = createFileBackedSessionStore({
            filePath: `${join(getGlobalDataDir(), 'state')}/parley-adapter-sessions.json`,
            log,
          })
          const parleyAdapterRegistry = createDefaultParleyRegistry({
            bridgeDriverPool,
            concurrencyGate: parleyConcurrencyGate,
            driverFactory: channelDriverFactory,
            env: process.env,
            log,
            profileName: parleyProfile,
            profileStore: channelProfileStore,
            sessionStore: parleySessionStore,
          })

          // Strict resolution (plan §2.3 / codex round-2 MUST-FIX):
          //   - Unset profile → mock-echo (safe default for unattended hosts).
          //   - Explicit profile that resolves → use it + log at INFO.
          //   - Explicit profile that does NOT resolve → fail-fast at
          //     startup so the operator sees a clear error immediately
          //     rather than silently running an echo endpoint on a live
          //     bridge. Missing profile = misconfiguration, not a
          //     fall-back-to-mock-echo case.
          if (parleyProfile === undefined) {
            log('[Daemon] Parley adapter: mock-echo (kind=mock) — no BRV_BRIDGE_PARLEY_PROFILE set')
          } else {
            const resolvedAdapter = parleyAdapterRegistry.resolve(parleyProfile)
            if (resolvedAdapter === undefined) {
              throw new ParleyAdapterNotFoundError(parleyProfile, parleyAdapterRegistry.list())
            }

            log(
              `[Daemon] Parley adapter: ${resolvedAdapter.profile} (kind=${resolvedAdapter.kind}) ` +
                `(pool cap=${bridgeMaxConcurrent} per profile)`,
            )

            // Fix 9.5.3 (codex K79P0sTCkPTOaaZefPoh1 Fix 2a): call warm() at
            // startup so the daemon fails fast when the required binary is
            // missing, rather than surfacing the error on the first request.
            // For the 'claude-code' profile (explicitly operator-configured):
            //   warm() returns {available: false} → throw so the operator
            //   learns immediately about the misconfiguration.
            // For all other profiles: log a warning but continue.
            if (resolvedAdapter.warm !== undefined) {
              const warmResult = await resolvedAdapter.warm({log})
              if (warmResult.available) {
                log(`[Daemon] Parley adapter '${resolvedAdapter.profile}' warm() OK`)
              } else {
                if (resolvedAdapter.profile === 'claude-code') {
                  throw new Error(
                    `[Daemon] Parley adapter '${resolvedAdapter.profile}' is not available at startup: ` +
                      `${warmResult.reason}. ` +
                      `Ensure the 'claude' binary is on PATH before starting the daemon with BRV_BRIDGE_PARLEY_PROFILE=claude-code.`,
                  )
                }

                log(
                  `[Daemon] Warning: parley adapter '${resolvedAdapter.profile}' warm() returned ` +
                    `available=false: ${warmResult.reason}`,
                )
              }
            }
          }

          // Slice 9.4e — Bob-side transcript persistence + auto-
          // provision matrix.
          //   - `auto` — accept all authenticated peers
          //   - `pinned-only` (default) — only user-confirmed/ca-bound
          //   - `deny` — Bob is read-only
          const autoProvisionPolicy = bridgeRuntime.autoProvision
          const bridgeProjectRoot = bridgeRuntime.projectRoot
          const transcriptService = new BridgeTranscriptService({
            autoCreateQuota: bridgeAutoCreateQuota,
            autoProvisionPolicy,
            channelStore,
            clock: () => new Date(),
            eventsWriter: channelEventsWriter,
            idGenerator: () => nanoid(),
            projectRoot: bridgeProjectRoot,
          })
          // kimi round-1 HIGH-1 / NIT-12 / round-2 MED — log the
          // policy at INFO so operators see the resolved posture,
          // and surface the env-var override hint when the default
          // `pinned-only` would block first-contact peers (since the
          // `brv trust verify` promotion CLI ships in a later slice).
          // The resolved path is gated behind `BRV_BRIDGE_DEBUG=1`
          // so info logs don't routinely echo cwd.
          if (autoProvisionPolicy === 'auto') {
            log(
              'Bridge auto-provision policy: OPEN (auto) — every authenticated peer can ' +
                'auto-create a mirror channel.',
            )
          } else if (autoProvisionPolicy === 'pinned-only') {
            log(
              'Bridge auto-provision policy: pinned-only (default) — only `user-confirmed` or ' +
                '`ca-bound` senders accepted. First-contact peers will be declined until they ' +
                'are promoted (or set BRV_BRIDGE_AUTO_PROVISION=auto for unattended hosts).',
            )
          } else {
            log(`Bridge auto-provision policy: ${autoProvisionPolicy} (Bob is read-only)`)
          }

          if (process.env.BRV_BRIDGE_DEBUG === '1') {
            log(`bridge project root: ${bridgeProjectRoot}`)
          }

          // Slice 9.9 — surface the configured delegate policy at
          // startup. kimi round-1 MED-2 + MED-3:
          //   - `auto` is a real security-relaxing setting (any
          //     authenticated remote peer can execute mutating
          //     tools); operators need to see they've opted in
          //   - the policy gate is parsed but NOT yet enforced by
          //     parley-server (the `/brv/parley/delegate/v1`
          //     protocol handler ships in a later slice), so
          //     operators who set `deny` must NOT assume protection
          //     until that slice lands. The log makes the unwired
          //     state visible.
          const {delegatePolicy} = bridgeRuntime
          if (delegatePolicy === 'auto') {
            log(
              'Bridge delegate policy: AUTO — authenticated remote peers can request mutating tool ' +
                'calls without operator approval per invocation. Set BRV_BRIDGE_DELEGATE_POLICY=prompt ' +
                'to require explicit approval.',
            )
          } else {
            log(`Bridge delegate policy: ${delegatePolicy} (not yet enforced by parley-server — deferred to a later slice)`)
          }

          await registerParleyServer({
            acceptModes: ['peer-tree'],
            host,
            l2Identity: bridgeL2,
            projectRoot: bridgeProjectRoot,
            responseGenerator: {profile: parleyProfile, registry: parleyAdapterRegistry},
            tofuPolicy: 'auto',
            tofuStore: bridgeTofu,
            transcriptService,
          })
          log(`Bridge host started — peer_id=${bridgeInstall ? (await bridgeInstall.loadOrGenerate()).peerId : '?'}`)
          for (const ma of host.getMultiaddrs()) {
            log(`  bridge multiaddr: ${ma}`)
          }

          return host
        })().catch((error) => {
          bridgeHostPromise = undefined
          throw error
        })
      }

      return bridgeHostPromise
    }

    // Phase 9 / Slice 9.4b — bridge:whoami transport endpoint. Returns
    // peer_id / current multiaddrs / l2_pub_key / tree_id for operators
    // who need to paste these into a remote `brv channel invite`.
    // Forces the bridge host to come up if it hasn't yet (lazy init).
    transportServer.onRequest<void, BridgeWhoamiResponse>(BridgeEvents.WHOAMI, async () => {
      const host = await ensureBridgeHost()
      const installIdentity = await bridgeInstall.loadOrGenerate()
      const l2Identity = await bridgeL2.loadOrGenerate()
      // libp2p can briefly report no advertised addresses immediately
      // after host.start() — retry once after 100ms so the CLI doesn't
      // surface an empty list (kimi round-1 LOW).
      let multiaddrs = host.getMultiaddrs()
      if (multiaddrs.length === 0) {
        await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
        multiaddrs = host.getMultiaddrs()
      }

      return {
        l2PubKey: l2Identity.cert.public_key.key,
        multiaddrs,
        peerId: installIdentity.peerId,
        treeId: l2Identity.treeId,
      }
    })

    const remotePeerDriverFactory = async (args: {
      channelId: string
      handle: string
      multiaddr: string
      peerId: string
      remoteL2PubKey: string
    }) => {
      // Reuse the shared bridge host across all remote-peer drivers in
      // the daemon — one libp2p host per daemon process, NOT per
      // member. The host is lazy-initialized on first invite so installs
      // that never use cross-host channels skip the libp2p startup cost.
      const host = await ensureBridgeHost()
      return new RemoteMemberDriver({
        channelId: args.channelId,
        handle: args.handle,
        host,
        install: bridgeInstall,
        l2Identity: bridgeL2,
        multiaddr: args.multiaddr,
        peerId: args.peerId,
        remoteL2PubKey: args.remoteL2PubKey,
      })
    }

    // Slice 9.4d — in-band L2 cert discovery for remote-peer invites.
    // `fetchAndPin({fetchTreeCert: true})` dials the remote's
    // `/brv/identity/cert/v1` AND `/brv/identity/tree-cert/v1`,
    // verifies both chains, and pins the L2 pubkey to the TOFU store.
    // Slice 9.4h — clock captured at startup so the daemon's
    // expiry check is deterministic under fake-timers in tests
    // (kimi round-1 LOW; matches the clock-threading pattern used by
    // other 9.4* services like BridgeTranscriptService).
    const bridgeClock = (): Date => new Date()

    const resolveRemotePeerL2PubKey = async (args: {multiaddr: string; peerId: string}): Promise<string> => {
      // Fast-path: re-use a cached L2 pubkey when we've already pinned
      // this peer with full identity (kimi round-1 LOW). Inviting the
      // same peer to N channels otherwise re-dials the cert protocols
      // N times.
      //
      // Slice 9.4h — skip the fast-path when the cached L2 cert has
      // expired (or when the cache predates 9.4h and therefore has no
      // recorded expiry — treat as stale-unknown). Falling through to
      // `fetchAndPin({fetchTreeCert: true})` re-validates the chain
      // against `now`, refreshing both pubkey and expires_at.
      //
      // Note (kimi round-1 NIT): two concurrent invites for the same
      // peer with a stale cache BOTH fall through here before the
      // TOFU lock serialises their writes. The flock prevents storage
      // races but does NOT coalesce the network dials, so the same
      // tree cert may be fetched twice in rapid succession. Acceptable
      // for now; a request-coalescer would be a future optimisation.
      const cached = await bridgeTofu.get(args.peerId)
      if (cached?.l2_pub_key !== undefined && !isL2CertExpired(cached, bridgeClock())) {
        return cached.l2_pub_key
      }

      if (cached?.l2_pub_key !== undefined) {
        // kimi round-1 LOW — give operators a single observable
        // signal when a previously-snappy invite suddenly does a
        // network dial because the cached L2 cert has aged out.
        log(`L2 cache stale for peer ${args.peerId}; re-fetching tree cert`)
      }

      const host = await ensureBridgeHost()
      const pinned = await fetchAndPin({
        expectedPeerId: args.peerId,
        fetchTreeCert: true,
        host,
        multiaddr: args.multiaddr,
        tofuStore: bridgeTofu,
      })
      if (pinned.l2_pub_key === undefined) {
        throw new Error('remote did not publish an L2 tree cert on /brv/identity/tree-cert/v1')
      }

      return pinned.l2_pub_key
    }

    const channelOrchestrator = new ChannelOrchestrator({
      // Phase 9.5.4 deferral (§6) — same quota instance shared with
      // BridgeTranscriptService so uninvite resets the peer's counter.
      autoCreateQuota: bridgeAutoCreateQuota,
      broadcaster: channelBroadcaster,
      cancelCoordinator: channelCancelCoordinator,
      clock: () => new Date(),
      driverFactory: channelDriverFactory,
      idGenerator: () => nanoid(),
      permissionBroker: channelBroker,
      pool: channelPool,
      // Phase 10 Tier C #4 — record per-agent wall-clock duration into
      // profile metadata so `channel profile show` surfaces variance.
      profileMetadataStore: channelProfileMetadataStore,
      profileStore: channelProfileStore,
      remotePeerDriverFactory,
      resolveRemotePeerL2PubKey,
      seqAllocator: channelSeqAllocator,
      store: channelStore,
    })

    const channelOnboardService = new ChannelOnboardService({
      clock: () => new Date(),
      driverFactory: channelDriverFactory,
      metadataStore: channelProfileMetadataStore,
      store: channelProfileStore,
    })

    const channelDoctorService = new ChannelDoctorService({
      broker: channelBroker,
      clock: () => new Date(),
      pool: channelPool,
      profileMetadataStore: channelProfileMetadataStore,
      profileStore: channelProfileStore,
      store: channelStore,
      // Slice 9.11 — give the doctor access to the bridge TOFU store
      // so it can diagnose remote-peer channel members (pin state, L2
      // cert freshness, etc.).
      tofu: bridgeTofu,
    })

    // Slice 3.5c: run recovery BEFORE any client can connect. Seeds the
    // sequence allocator + events-writer from on-disk events.jsonl,
    // emits `delivery_state_change → errored` for any permission that
    // was in-flight when the previous daemon went down, and finalises
    // turns whose deliveries are now all terminal. Best-effort: a
    // failure here logs but does not block bootstrap.
    if (channelsEnabled()) {
      try {
        const recoverySummary = await runChannelRecovery({
          broadcaster: channelBroadcaster,
          brokerPersistence: channelBrokerPersistence,
          clock: () => new Date(),
          eventsWriter: channelEventsWriter,
          seqAllocator: channelSeqAllocator,
          store: channelStore,
          treeReader: channelTreeReader,
        })
        // Slice 8.10: seed the orphan-permission registry so
        // `permissionDecision()` surfaces CHANNEL_PERMISSION_LOST_ON_RESTART
        // instead of the misleading CHANNEL_TURN_NOT_FOUND when the user
        // approves a permission whose ACP subprocess died with the daemon.
        // V3 super-mario reproducer (2026-05-16). Empty list is a no-op so
        // we don't gate on length — keeps main()'s cyclomatic budget intact.
        channelOrchestrator.seedRestartLosses(recoverySummary.restartLosses)
      } catch (error) {
        log(`channel-recovery error (continuing): ${error instanceof Error ? error.message : String(error)}`)
      }
      // Note: Slice 9.3 index 2PC-gap recovery is triggered lazily from
      // `ChannelStore.listTurns` on first access per channel, not at
      // daemon startup. Eager startup recovery requires a list of
      // project roots that have ever used channels — discovery is
      // bigger than Phase 9; lazy recovery covers correctness with no
      // bootstrap-time cost.

      // Slice 8.11 Layer 2: warm ACP drivers for a project's channels on the
      // first Socket.IO connection from that cwd. Set is in-memory, rebuilt
      // each daemon lifetime so a restart triggers fresh warm on first request.
      // Fire-and-forget — Layer 1 (CHANNEL_DRIVER_NOT_REGISTERED) catches the
      // race window where a mention arrives before spawn completes.
      // V3 super-mario reproducer (2026-05-16 §"Driver reinvite needed").
      const warmedProjects = new Set<string>()
      transportServer.onConnection((_clientId, metadata) => {
        const rawCwd = metadata.cwd
        if (rawCwd === undefined || rawCwd === '') return
        // Codex Q3: canonicalize via path.resolve so trailing slashes,
        // `.`, `..`, and equivalent forms don't trigger duplicate warms
        // for the same project from the same daemon lifetime.
        const cwd = resolve(rawCwd)
        if (warmedProjects.has(cwd)) return
        warmedProjects.add(cwd)
        channelOrchestrator.warmDriversForProject(cwd).catch((error: unknown) => {
          log(`channel-warm error for ${cwd} (continuing): ${error instanceof Error ? error.message : String(error)}`)
        })
      })
    }

    // Slice 3.5b: gate the FULL handler registration on
    // `BRV_CHANNELS_ENABLED`. When unset/off, register stubs that return
    // CHANNEL_DISABLED for every channel:* event so the CLI ack callback
    // fires (never hangs).
    if (channelsEnabled()) {
      new ChannelHandler({
        // Slice 3.5a: pass a provider callback so token rotation takes
        // effect immediately. Middleware reads getCurrent() per request.
        authToken: () => daemonTokenProvider.getCurrent(),
        doctorService: channelDoctorService,
        onboardService: channelOnboardService,
        orchestrator: channelOrchestrator,
        // Phase 10 Tier B3 — wire the metadata store for drift telemetry.
        profileMetadataStore: channelProfileMetadataStore,
        profileStore: channelProfileStore,
        rotateToken: () => daemonTokenProvider.rotate(),
      }).registerOn(channelTransport)
    } else {
      registerDisabledStubs(channelTransport)
    }

    // Best-effort: release every channel driver on SIGTERM/SIGINT so
    // subprocess agents do not leak. Phase 3 wires a first-class
    // shutdown-handler hook; for Phase 2 we hook the existing signal
    // listeners that already drive `shutdownHandler.shutdown()` below.
    // Slice 9.2 — also drain every held-open per-turn write stream so
    // any buffered transcript bytes flush to disk before exit. Without
    // this, an abrupt SIGTERM mid-streaming-turn would truncate the
    // last few chunks at the OS layer.
    const releaseChannelResourcesOnExit = (): void => {
      channelPool.releaseAll().catch(() => {})
      channelEventsWriter.closeAll().catch(() => {})
      // Slice 9.4f — stop every warm parley ACP subprocess so they
      // don't outlive the daemon. closeAll swallows individual driver
      // errors so a single misbehaving subprocess can't block exit.
      bridgeDriverPool?.closeAll().catch(() => {})
    }

    process.once('beforeExit', releaseChannelResourcesOnExit)

    // Phase 9.5.1 §3.1 — rebind bridge listener on daemon respawn.
    // If the operator has ever configured a bridge (persisted listenAddrs,
    // parleyProfile, etc.), eagerly call ensureBridgeHost() so the libp2p
    // listener is bound before any client connects. Without this, a
    // CLI-triggered auto-respawn would drop the bridge listener until the
    // first `brv bridge whoami` / `brv channel invite`.
    const bridgeConfigStore = new BridgeConfigStore({stateDir: join(getGlobalDataDir(), 'state')})
    if (hasBridgePersistedState(bridgeConfigStore.load())) {
      log('[Daemon] Persisted bridge state detected — starting bridge host eagerly (§3.1 rebind)')
      ensureBridgeHost().catch((error: unknown) => {
        log(`[Daemon] Bridge startup error (continuing): ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    // Load auth token AFTER feature handlers are registered.
    // AuthHandler's onAuthChanged/onAuthExpired callbacks must be wired first
    // so that loadToken() triggers proper broadcasts to TUI and agents.
    // Agents also request auth on-demand via state:getAuth, so this ordering is safe.
    await authStateStore.loadToken()
    authStateStore.startPolling()

    // 11. Start idle timer + register signal handlers
    idleTimeoutPolicy.start()

    // Slice 9.6 (codex D2): fire `releaseChannelResourcesOnExit` from the
    // signal handlers too, not just `beforeExit`. Live channel ACP children
    // can keep the event loop busy long enough that `shutdownHandler.shutdown()`
    // proceeds to `process.exit()` — which SKIPS `beforeExit` — before our
    // streams flush. The release hook is idempotent (`releaseAll` no-ops on
    // an empty pool; `closeAll` clears its own Map), so duplicate invocation
    // from beforeExit later is harmless.
    const handleShutdownSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
      log(`${signal} received`)
      releaseChannelResourcesOnExit()
      shutdownHandler.shutdown().catch((error: unknown) => {
        log(`Shutdown error: ${error instanceof Error ? error.message : String(error)}`)
      })
    }

    process.once('SIGTERM', () => handleShutdownSignal('SIGTERM'))
    process.once('SIGINT', () => handleShutdownSignal('SIGINT'))

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
