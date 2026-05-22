/**
 * Feature Handlers Setup
 *
 * Registers all feature handlers (auth, init, status, etc.) on the transport server.
 * These handlers implement the TUI ↔ Server event contract.
 */

import {access} from 'node:fs/promises'
import {join} from 'node:path'

import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {IConnectorManager} from '../../core/interfaces/connectors/i-connector-manager.js'
import type {IProviderConfigStore} from '../../core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../core/interfaces/i-provider-keychain-store.js'
import type {IProviderOAuthTokenStore} from '../../core/interfaces/i-provider-oauth-token-store.js'
import type {IProjectRegistry} from '../../core/interfaces/project/i-project-registry.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'
import type {ITransportServer} from '../../core/interfaces/transport/i-transport-server.js'
import type {AnalyticsFlushScheduler} from '../analytics/analytics-flush-scheduler.js'
import type {ProjectBroadcaster, ProjectPathResolver} from '../transport/handlers/handler-types.js'

import {ReviewEvents} from '../../../shared/transport/events/review-events.js'
import {getAuthConfig} from '../../config/auth.config.js'
import {getCurrentConfig} from '../../config/environment.js'
import {API_V1_PATH, BRV_DIR} from '../../constants.js'
import {getGlobalDataDir} from '../../utils/global-data-path.js'
import {getProjectDataDir} from '../../utils/path-utils.js'
import {readCliVersion} from '../../utils/read-cli-version.js'
import {AnalyticsBackoffPolicy} from '../analytics/analytics-backoff-policy.js'
import {AnalyticsClient} from '../analytics/analytics-client.js'
import {BoundedQueue} from '../analytics/bounded-queue.js'
import {IdentityResolver} from '../analytics/identity-resolver.js'
import {JsonlAnalyticsStore} from '../analytics/jsonl-analytics-store.js'
import {SuperPropertiesResolver} from '../analytics/super-properties-resolver.js'
import {OAuthService} from '../auth/oauth-service.js'
import {OidcDiscoveryService} from '../auth/oidc-discovery-service.js'
import {SystemBrowserLauncher} from '../browser/system-browser-launcher.js'
import {HttpCogitPullService} from '../cogit/http-cogit-pull-service.js'
import {HttpCogitPushService} from '../cogit/http-cogit-push-service.js'
import {ProjectConfigStore} from '../config/file-config-store.js'
import {ConnectorManager} from '../connectors/connector-manager.js'
import {RuleTemplateService} from '../connectors/shared/template-service.js'
import {SkillConnector} from '../connectors/skill/skill-connector.js'
import {FileContextFileReader} from '../context-tree/file-context-file-reader.js'
import {FileContextTreeMerger} from '../context-tree/file-context-tree-merger.js'
import {FileContextTreeService} from '../context-tree/file-context-tree-service.js'
import {FileContextTreeSnapshotService} from '../context-tree/file-context-tree-snapshot-service.js'
import {FileContextTreeWriterService} from '../context-tree/file-context-tree-writer-service.js'
import {FsFileService} from '../file/fs-file-service.js'
import {IsomorphicGitService} from '../git/isomorphic-git-service.js'
import {CallbackHandler} from '../http/callback-handler.js'
import {HubInstallService} from '../hub/hub-install-service.js'
import {createHubKeychainStore} from '../hub/hub-keychain-store.js'
import {HubRegistryConfigStore} from '../hub/hub-registry-config-store.js'
import {HttpSpaceService} from '../space/http-space-service.js'
import {FileCurateLogStore} from '../storage/file-curate-log-store.js'
import {FileGlobalConfigStore} from '../storage/file-global-config-store.js'
import {FileReviewBackupStore} from '../storage/file-review-backup-store.js'
import {createTokenStore} from '../storage/token-store.js'
import {HttpTeamService} from '../team/http-team-service.js'
import {FsTemplateLoader} from '../template/fs-template-loader.js'
import {
  AnalyticsHandler,
  AnalyticsListHandler,
  AuthHandler,
  ConfigHandler,
  ConnectorsHandler,
  ContextTreeHandler,
  GlobalConfigHandler,
  HubHandler,
  InitHandler,
  LocationsHandler,
  ModelHandler,
  ProviderHandler,
  PullHandler,
  PushHandler,
  ResetHandler,
  ReviewHandler,
  SourceHandler,
  SpaceHandler,
  StatusHandler,
  VcHandler,
  WorktreeHandler,
} from '../transport/handlers/index.js'
import {HttpUserService} from '../user/http-user-service.js'
import {FileVcGitConfigStore} from '../vc/file-vc-git-config-store.js'
import {wireAnalyticsAuthPreTransition} from './wire-analytics-auth-pre-transition.js'
import {wireAnalyticsAuthTransition} from './wire-analytics-auth-transition.js'
import {wireAnalyticsFlushScheduler} from './wire-analytics-flush-scheduler.js'
import {wireAnalyticsHttpSender} from './wire-analytics-http-sender.js'

export interface FeatureHandlersOptions {
  authStateStore: IAuthStateStore
  broadcastToProject: ProjectBroadcaster
  getActiveProjectPaths: () => string[]
  log: (msg: string) => void
  projectRegistry: IProjectRegistry
  providerConfigStore: IProviderConfigStore
  providerKeychainStore: IProviderKeychainStore
  providerOAuthTokenStore: IProviderOAuthTokenStore
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
  webuiPort?: number
}

/**
 * Result of setting up feature handlers. The daemon-scoped analytics
 * client is returned so the caller (brv-server.ts) can fire `daemon_start`
 * AFTER auth state is loaded — emitting it inside this function would
 * stamp the event with anonymous identity even for logged-in users,
 * because authStateStore.loadToken() runs after setupFeatureHandlers.
 */
export interface SetupFeatureHandlersResult {
  readonly analyticsClient: IAnalyticsClient
  /**
   * M4.3: scheduler that owns the 30s interval + 20-event threshold
   * triggers. The composition root (`brv-server.ts`) starts it after
   * auth state has loaded so the first tick has a real identity, and
   * stops it during shutdown before invoking `flushFinal()` so no new
   * ticks fire mid-shutdown.
   */
  readonly analyticsFlushScheduler: AnalyticsFlushScheduler
  /**
   * Returns the daemon's cached analytics-enabled flag. M12.3 consumers
   * (e.g. AnalyticsHook) use this to short-circuit disk I/O when analytics
   * is off — complements `AnalyticsClient.track` no-op gate.
   */
  readonly isAnalyticsEnabled: () => boolean
}

/**
 * Setup all feature handlers on the transport server.
 * These handlers implement the TUI ↔ Server event contract (auth:*, config:*, status:*, etc.).
 */
export async function setupFeatureHandlers({
  authStateStore,
  broadcastToProject,
  getActiveProjectPaths,
  log,
  projectRegistry,
  providerConfigStore,
  providerKeychainStore,
  providerOAuthTokenStore,
  resolveProjectPath,
  transport,
  webuiPort,
}: FeatureHandlersOptions): Promise<SetupFeatureHandlersResult> {
  const envConfig = getCurrentConfig()
  const tokenStore = createTokenStore()
  const projectConfigStore = new ProjectConfigStore()

  // API version paths appended at point of use.
  // Note: IAM and Cogit currently share this version path, but may version independently in the future.
  const iamApiV1 = `${envConfig.iamBaseUrl}${API_V1_PATH}`
  const userService = new HttpUserService({apiBaseUrl: iamApiV1})
  const teamService = new HttpTeamService({apiBaseUrl: iamApiV1})
  const spaceService = new HttpSpaceService({apiBaseUrl: iamApiV1})

  // Auth handler requires async OIDC discovery
  const discoveryService = new OidcDiscoveryService()
  const authConfig = await getAuthConfig(discoveryService)

  // Global handlers (no project context needed)
  new ConfigHandler({transport}).setup()

  // GlobalConfig: handler retains a sync-cached `analytics` flag so M2.5's
  // AnalyticsClient.isEnabled can be a sync getter (file reads are async).
  // refreshCache() must complete BEFORE AnalyticsClient is constructed so
  // the very first track() call (daemon_start) sees the correct flag.
  const globalConfigStore = new FileGlobalConfigStore()
  const globalConfigHandler = new GlobalConfigHandler({globalConfigStore, transport})
  globalConfigHandler.setup()
  await globalConfigHandler.refreshCache()

  // M2.5: assemble the daemon-scoped analytics client. Construction happens
  // here because the resolvers and queue share the same `globalConfigStore`
  // instance already in scope. The `daemon_start` event is NOT fired here —
  // it is fired by the caller (brv-server.ts) after authStateStore.loadToken()
  // resolves so the event reflects the real identity instead of anonymous.
  //
  // M9.3: a single JsonlAnalyticsStore instance is constructed here and
  // injected into the AnalyticsClient. The same instance will be shared with
  // M11.2's analytics-list-handler when it lands so both read/write the same
  // file. Storage path: `<global-data-dir>/analytics-queue.jsonl`.
  const jsonlAnalyticsStore = new JsonlAnalyticsStore({baseDir: getGlobalDataDir()})
  // M4.2: real HTTP sender. See `wireAnalyticsHttpSender` for the
  // axios + sender composition. Headers are computed per send so
  // device-id and session-id reflect the current GlobalConfig +
  // AuthStateStore state at flush time. The per-event identity inside
  // each record (M4.1) remains authoritative for the wire body; the
  // request-level session header is a backwards-compat hint only.
  const analyticsSender = wireAnalyticsHttpSender({
    analyticsBaseUrl: envConfig.analyticsBaseUrl,
    authStateReader: authStateStore,
    globalConfigStore,
    version: readCliVersion(),
  })
  // M4.3: scheduler is built AFTER the client but needs to be referenced
  // by it (`onAfterTrack: () => scheduler.notifyPushed()`). Resolve the
  // cycle with a mutable holder: the client closure reads the latest
  // assigned value at call-time, so the scheduler is in place by the
  // time the first track lands. Queue is hoisted to a shared instance so
  // both client (push) and scheduler (queueSize) observe the same state.
  const analyticsQueue = new BoundedQueue()
  // M4.5: backoff policy shared between the client (mutates via
  // onSuccess/onFailure inside runFlush) and the scheduler (reads
  // nextDelayMs at each arm). Pure in-memory state, no persistence —
  // a daemon restart starts from the base 30s interval.
  const analyticsBackoffPolicy = new AnalyticsBackoffPolicy()
  // Holder for the scheduler reference shared with `onAfterTrack`. Using
  // a plain object instead of `let` so the lint rule sees a const binding
  // (the closure reads `.value` on every call). The scheduler instance is
  // assigned immediately after AnalyticsClient construction below.
  const schedulerHolder: {value: AnalyticsFlushScheduler | undefined} = {value: undefined}
  const analyticsClient: IAnalyticsClient = new AnalyticsClient({
    backoffPolicy: analyticsBackoffPolicy,
    identityResolver: new IdentityResolver(authStateStore, globalConfigStore),
    isEnabled: () => globalConfigHandler.getCachedAnalytics(),
    jsonlStore: jsonlAnalyticsStore,
    onAfterTrack() {
      schedulerHolder.value?.notifyPushed()
    },
    queue: analyticsQueue,
    sender: analyticsSender,
    superPropsResolver: new SuperPropertiesResolver(globalConfigStore),
  })

  const analyticsFlushScheduler = wireAnalyticsFlushScheduler({
    analyticsClient,
    backoffPolicy: analyticsBackoffPolicy,
    isEnabled: () => globalConfigHandler.getCachedAnalytics(),
    jsonlStore: jsonlAnalyticsStore,
    queue: analyticsQueue,
  })
  schedulerHolder.value = analyticsFlushScheduler

  // M4.1: subscribe the analytics client to identity-changing auth
  // transitions. See `wireAnalyticsAuthTransition` for the
  // login/logout/refresh decision logic.
  wireAnalyticsAuthTransition(authStateStore, analyticsClient)

  // M4.4: subscribe the pre-transition hook so the client flushes
  // surviving events under the OLD session header BEFORE the new
  // token replaces the cache. Paired with the M4.1 post-hook above
  // (drops anything the flush couldn't deliver in time).
  wireAnalyticsAuthPreTransition(authStateStore, analyticsClient)

  // M4.4: close the global-config-handler ↔ analyticsClient cycle.
  // The handler was constructed earlier (so its sync cache was
  // populated before the client read it); now that the client
  // exists, register it so `brv analytics disable` can call
  // `abort()` to cancel any in-flight HTTP.
  globalConfigHandler.setAnalyticsClient(analyticsClient)

  // M2.6: route incoming analytics:track events from non-forked clients
  // (TUI, oclif, MCP, webui) to the same singleton.
  new AnalyticsHandler({analyticsClient, transport}).setup()

  // M11.2: webui-facing read API. Shares the same JsonlAnalyticsStore instance
  // as the AnalyticsClient so reads see exactly what trackAsync persisted.
  new AnalyticsListHandler({jsonlStore: jsonlAnalyticsStore, transport}).setup()

  new AuthHandler({
    authService: new OAuthService(authConfig),
    authStateStore,
    browserLauncher: new SystemBrowserLauncher(),
    callbackHandler: new CallbackHandler(),
    projectConfigStore,
    resolveProjectPath,
    tokenStore,
    transport,
    userService,
  }).setup()

  new ProviderHandler({
    authStateStore,
    browserLauncher: new SystemBrowserLauncher(),
    providerConfigStore,
    providerKeychainStore,
    providerOAuthTokenStore,
    transport,
  }).setup()

  new ModelHandler({
    providerConfigStore,
    providerKeychainStore,
    transport,
  }).setup()

  // Shared services for project-scoped handlers
  const contextTreeService = new FileContextTreeService()
  const contextTreeSnapshotService = new FileContextTreeSnapshotService()
  const contextTreeWriterService = new FileContextTreeWriterService({snapshotService: contextTreeSnapshotService})
  const contextTreeMerger = new FileContextTreeMerger({snapshotService: contextTreeSnapshotService})
  const contextFileReader = new FileContextFileReader()
  const cogitApiV1 = `${envConfig.cogitBaseUrl}${API_V1_PATH}`
  const cogitPushService = new HttpCogitPushService({apiBaseUrl: cogitApiV1})
  const cogitPullService = new HttpCogitPullService({apiBaseUrl: cogitApiV1})

  // ConnectorManager factory — creates per-project instances since constructor binds to projectRoot
  const fileService = new FsFileService()
  const templateLoader = new FsTemplateLoader(fileService)
  const templateService = new RuleTemplateService(templateLoader)
  const connectorManagerFactory = (projectRoot: string): IConnectorManager =>
    new ConnectorManager({fileService, projectRoot, templateService})

  // Project-scoped handlers (receive resolveProjectPath for client → project resolution)
  const gitService = new IsomorphicGitService(authStateStore)

  new StatusHandler({
    contextTreeService,
    contextTreeSnapshotService,
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({ baseDir: getProjectDataDir(projectPath) }),
    projectConfigStore,
    resolveProjectPath,
    tokenStore,
    transport,
    webuiPort,
  }).setup()

  new LocationsHandler({
    contextTreeService,
    getActiveProjectPaths,
    async pathExists(path: string) {
      try {
        await access(path)
        return true
      } catch (error) {
        if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          return false
        }

        throw error
      }
    },
    projectRegistry,
    resolveProjectPath,
    transport,
  }).setup()

  new PushHandler({
    broadcastToProject,
    cogitPushService,
    contextFileReader,
    contextTreeService,
    contextTreeSnapshotService,
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({ baseDir: getProjectDataDir(projectPath) }),
    projectConfigStore,
    resolveProjectPath,
    reviewBackupStoreFactory: (projectPath) => new FileReviewBackupStore(join(projectPath, BRV_DIR)),
    tokenStore,
    transport,
    webAppUrl: envConfig.webAppUrl,
    webuiPort,
  }).setup()

  new PullHandler({
    broadcastToProject,
    cogitPullService,
    contextTreeService,
    contextTreeSnapshotService,
    contextTreeWriterService,
    projectConfigStore,
    resolveProjectPath,
    tokenStore,
    transport,
  }).setup()

  new ResetHandler({
    contextTreeService,
    contextTreeSnapshotService,
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({ baseDir: getProjectDataDir(projectPath) }),
    resolveProjectPath,
    reviewBackupStoreFactory: (projectPath) => new FileReviewBackupStore(join(projectPath, BRV_DIR)),
    transport,
  }).setup()

  new ReviewHandler({
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({ baseDir: getProjectDataDir(projectPath) }),
    onResolved({ projectPath, taskId }) {
      broadcastToProject(projectPath, ReviewEvents.NOTIFY, { pendingCount: 0, reviewUrl: '', taskId })
    },
    projectConfigStore,
    resolveProjectPath,
    reviewBackupStoreFactory: (projectPath) => new FileReviewBackupStore(join(projectPath, BRV_DIR)),
    transport,
  }).setup()

  new SpaceHandler({
    broadcastToProject,
    cogitPullService,
    contextTreeMerger,
    contextTreeService,
    contextTreeSnapshotService,
    contextTreeWriterService,
    projectConfigStore,
    resolveProjectPath,
    spaceService,
    teamService,
    tokenStore,
    transport,
  }).setup()

  new ConnectorsHandler({
    connectorManagerFactory,
    resolveProjectPath,
    transport,
  }).setup()

  const skillConnectorFactory = (projectRoot: string): SkillConnector => new SkillConnector({ fileService, projectRoot })
  const hubInstallService = new HubInstallService({ fileService, skillConnectorFactory })
  const hubRegistryConfigStore = new HubRegistryConfigStore()
  const hubKeychainStore = createHubKeychainStore()

  await new HubHandler({
    hubInstallService,
    hubKeychainStore,
    hubRegistryConfigStore,
    officialRegistryUrl: envConfig.hubRegistryUrl,
    resolveProjectPath,
    transport,
  }).setup()

  new InitHandler({
    broadcastToProject,
    cogitPullService,
    connectorManagerFactory,
    contextTreeService,
    contextTreeSnapshotService,
    contextTreeWriterService,
    projectConfigStore,
    resolveProjectPath,
    spaceService,
    teamService,
    tokenStore,
    transport,
  }).setup()

  new VcHandler({
    broadcastToProject,
    contextTreeService,
    gitRemoteBaseUrl: envConfig.gitRemoteBaseUrl,
    gitService,
    projectConfigStore,
    resolveProjectPath,
    spaceService,
    teamService,
    tokenStore,
    transport,
    vcGitConfigStore: new FileVcGitConfigStore(),
    webAppUrl: envConfig.webAppUrl,
  }).setup()

  new ContextTreeHandler({
    contextFileReader,
    contextTreeService,
    gitService,
    resolveProjectPath,
    transport,
  }).setup()

  // Worktree & source handlers
  new WorktreeHandler({ resolveProjectPath, transport }).setup()
  new SourceHandler({ resolveProjectPath, transport }).setup()

  log('Feature handlers registered')

  // M12.3: expose the cached-analytics check so daemon-side consumers
  // (e.g. AnalyticsHook) can short-circuit disk I/O when analytics is off.
  // Same callback shape used internally by AnalyticsClient at line 171.
  return {
    analyticsClient,
    analyticsFlushScheduler,
    isAnalyticsEnabled: (): boolean => globalConfigHandler.getCachedAnalytics(),
  }
}
