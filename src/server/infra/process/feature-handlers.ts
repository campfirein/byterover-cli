/**
 * Feature Handlers Setup
 *
 * Registers all feature handlers (auth, init, status, etc.) on the transport server.
 * These handlers implement the TUI ↔ Server event contract.
 */

import {randomUUID} from 'node:crypto'
import {access} from 'node:fs/promises'
import {join} from 'node:path'

import type {IChannelOrchestrator} from '../../core/interfaces/channel/i-channel-orchestrator.js'
import type {IConnectorManager} from '../../core/interfaces/connectors/i-connector-manager.js'
import type {IProviderConfigStore} from '../../core/interfaces/i-provider-config-store.js'
import type {IProviderKeychainStore} from '../../core/interfaces/i-provider-keychain-store.js'
import type {IProviderOAuthTokenStore} from '../../core/interfaces/i-provider-oauth-token-store.js'
import type {IProjectRegistry} from '../../core/interfaces/project/i-project-registry.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'
import type {IBillingConfigStore} from '../../core/interfaces/storage/i-billing-config-store.js'
import type {ISettingsStore} from '../../core/interfaces/storage/i-settings-store.js'
import type {ITransportServer} from '../../core/interfaces/transport/i-transport-server.js'
import type {ProjectBroadcaster, ProjectPathResolver} from '../transport/handlers/handler-types.js'

import {ReviewEvents} from '../../../shared/transport/events/review-events.js'
import {getAuthConfig} from '../../config/auth.config.js'
import {getCurrentConfig} from '../../config/environment.js'
import {API_V1_PATH, BRV_DIR} from '../../constants.js'
import {TransportStateEventNames} from '../../core/domain/transport/schemas.js'
import {getGlobalDataDir} from '../../utils/global-data-path.js'
import {getProjectDataDir} from '../../utils/path-utils.js'
import {OAuthService} from '../auth/oauth-service.js'
import {OidcDiscoveryService} from '../auth/oidc-discovery-service.js'
import {HttpBillingService} from '../billing/http-billing-service.js'
import {createPaidOrganizationsHandler} from '../billing/paid-organizations-endpoint.js'
import {SystemBrowserLauncher} from '../browser/system-browser-launcher.js'
import {TransportChannelBroadcaster} from '../channel/channel-broadcaster.js'
import {FileChannelStore} from '../channel/channel-store.js'
import {FileDriverProfileStore} from '../channel/driver-profile-store.js'
import {AcpDriver} from '../channel/drivers/acp-driver.js'
import {DriverPool} from '../channel/drivers/driver-pool.js'
import {ChannelOnboardService} from '../channel/onboard-service.js'
import {ChannelOrchestrator} from '../channel/orchestrator.js'
import {FileTranscriptStore} from '../channel/storage/file-transcript-store.js'
import {TurnSequenceAllocator} from '../channel/turn-sequence-allocator.js'
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
import {FileReviewBackupStore} from '../storage/file-review-backup-store.js'
import {createTokenStore} from '../storage/token-store.js'
import {HttpTeamService} from '../team/http-team-service.js'
import {FsTemplateLoader} from '../template/fs-template-loader.js'
import {channelsEnabled, registerDisabledStubs} from '../transport/handlers/channel-disabled-handler.js'
import {ChannelCancelHandler} from '../transport/handlers/channel/channel-cancel-handler.js'
import {ChannelCreateHandler} from '../transport/handlers/channel/channel-create-handler.js'
import {ChannelGetHandler} from '../transport/handlers/channel/channel-get-handler.js'
import {ChannelInviteHandler} from '../transport/handlers/channel/channel-invite-handler.js'
import {ChannelListHandler} from '../transport/handlers/channel/channel-list-handler.js'
import {ChannelListTurnsHandler} from '../transport/handlers/channel/channel-list-turns-handler.js'
import {ChannelMentionHandler} from '../transport/handlers/channel/channel-mention-handler.js'
import {ChannelOnboardHandler} from '../transport/handlers/channel/channel-onboard-handler.js'
import {ChannelShowHandler} from '../transport/handlers/channel/channel-show-handler.js'
import {ChannelSubscribeHandler} from '../transport/handlers/channel/channel-subscribe-handler.js'
import {
  AuthHandler,
  BillingHandler,
  ConfigHandler,
  ConnectorsHandler,
  ContextTreeHandler,
  HubHandler,
  InitHandler,
  LocationsHandler,
  MigrateHandler,
  ModelHandler,
  ProviderHandler,
  PullHandler,
  PushHandler,
  ResetHandler,
  ReviewHandler,
  SettingsHandler,
  SourceHandler,
  SpaceHandler,
  StatusHandler,
  TeamHandler,
  VcHandler,
  WorktreeHandler,
} from '../transport/handlers/index.js'
import {HttpUserService} from '../user/http-user-service.js'
import {FileVcGitConfigStore} from '../vc/file-vc-git-config-store.js'

export interface FeatureHandlersOptions {
  authStateStore: IAuthStateStore
  billingConfigStoreFactory: (projectPath: string) => IBillingConfigStore
  broadcastToProject: ProjectBroadcaster
  getActiveProjectPaths: () => string[]
  log: (msg: string) => void
  projectRegistry: IProjectRegistry
  providerConfigStore: IProviderConfigStore
  providerKeychainStore: IProviderKeychainStore
  providerOAuthTokenStore: IProviderOAuthTokenStore
  resolveProjectPath: ProjectPathResolver
  settingsStore: ISettingsStore
  transport: ITransportServer
  webuiPort?: number
}

/**
 * Setup all feature handlers on the transport server.
 * These handlers implement the TUI ↔ Server event contract (auth:*, config:*, status:*, etc.).
 */
export async function setupFeatureHandlers({
  authStateStore,
  billingConfigStoreFactory,
  broadcastToProject,
  getActiveProjectPaths,
  log,
  projectRegistry,
  providerConfigStore,
  providerKeychainStore,
  providerOAuthTokenStore,
  resolveProjectPath,
  settingsStore,
  transport,
  webuiPort,
}: FeatureHandlersOptions): Promise<void> {
  const envConfig = getCurrentConfig()
  const tokenStore = createTokenStore()
  const projectConfigStore = new ProjectConfigStore()

  // API version paths appended at point of use.
  // Note: IAM and Cogit currently share this version path, but may version independently in the future.
  const iamApiV1 = `${envConfig.iamBaseUrl}${API_V1_PATH}`
  const billingApiV1 = `${envConfig.billingBaseUrl}${API_V1_PATH}`
  const userService = new HttpUserService({apiBaseUrl: iamApiV1})
  const teamService = new HttpTeamService({apiBaseUrl: iamApiV1})
  const spaceService = new HttpSpaceService({apiBaseUrl: iamApiV1})
  const billingService = new HttpBillingService({apiBaseUrl: billingApiV1})

  // Auth handler requires async OIDC discovery
  const discoveryService = new OidcDiscoveryService()
  const authConfig = await getAuthConfig(discoveryService)

  // Global handlers (no project context needed)
  new ConfigHandler({transport}).setup()
  new SettingsHandler({store: settingsStore, transport}).setup()

  // Channel handlers are gated behind BRV_CHANNELS_ENABLED (opt-out). When the
  // surface is disabled, register stubs so `channel:*` requests still ack.
  if (channelsEnabled()) {
    // Profiles are global (reusable across projects); the onboard service is
    // project-independent.
    const driverProfileStore = new FileDriverProfileStore({dataDir: getGlobalDataDir()})
    const driverFactory = (invocation: ConstructorParameters<typeof AcpDriver>[0]['invocation'], handle: string) =>
      new AcpDriver({handle, invocation})
    const onboardService = new ChannelOnboardService({clock: () => new Date(), driverFactory, store: driverProfileStore})

    // One orchestrator per project: a driver registered at invite time must
    // survive (in the same pool) to the subsequent mention request.
    const orchestrators = new Map<string, IChannelOrchestrator>()
    const getOrchestrator = (projectRoot: string): IChannelOrchestrator => {
      const existing = orchestrators.get(projectRoot)
      if (existing !== undefined) return existing
      const orchestrator = new ChannelOrchestrator({
        broadcaster: new TransportChannelBroadcaster(transport),
        clock: () => new Date(),
        driverFactory,
        idGenerator: randomUUID,
        pool: new DriverPool(),
        profileStore: driverProfileStore,
        projectRoot,
        seqAllocator: new TurnSequenceAllocator(),
        store: new FileChannelStore({projectRoot}),
        transcriptStore: new FileTranscriptStore(),
      })
      orchestrators.set(projectRoot, orchestrator)
      return orchestrator
    }

    new ChannelCreateHandler({getOrchestrator, resolveProjectPath, transport}).setup()
    new ChannelInviteHandler({getOrchestrator, resolveProjectPath, transport}).setup()
    new ChannelOnboardHandler({onboardService, transport}).setup()
    new ChannelMentionHandler({getOrchestrator, resolveProjectPath, transport}).setup()
    // Remaining read/lifecycle handlers stay stubbed until their milestones.
    new ChannelListHandler(transport).setup()
    new ChannelGetHandler(transport).setup()
    new ChannelShowHandler(transport).setup()
    new ChannelListTurnsHandler(transport).setup()
    new ChannelSubscribeHandler(transport).setup()
    new ChannelCancelHandler(transport).setup()
  } else {
    registerDisabledStubs(transport)
  }

  new AuthHandler({
    authService: new OAuthService(authConfig),
    authStateStore,
    browserLauncher: new SystemBrowserLauncher(),
    callbackHandler: new CallbackHandler(),
    projectConfigStore,
    providerConfigStore,
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

  new BillingHandler({
    authStateStore,
    billingConfigStoreFactory,
    billingService,
    providerConfigStore,
    resolveProjectPath,
    transport,
  }).setup()

  transport.onRequest(
    TransportStateEventNames.GET_PAID_ORGANIZATIONS,
    createPaidOrganizationsHandler({authStateStore, billingService}),
  )

  new TeamHandler({
    authStateStore,
    teamService,
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
    authStateStore,
    billingConfigStoreFactory,
    billingService,
    contextTreeService,
    contextTreeSnapshotService,
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({baseDir: getProjectDataDir(projectPath)}),
    projectConfigStore,
    providerConfigStore,
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
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({baseDir: getProjectDataDir(projectPath)}),
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

  new MigrateHandler({resolveProjectPath, transport}).setup()

  new ResetHandler({
    contextTreeService,
    contextTreeSnapshotService,
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({baseDir: getProjectDataDir(projectPath)}),
    resolveProjectPath,
    reviewBackupStoreFactory: (projectPath) => new FileReviewBackupStore(join(projectPath, BRV_DIR)),
    transport,
  }).setup()

  new ReviewHandler({
    curateLogStoreFactory: (projectPath) => new FileCurateLogStore({baseDir: getProjectDataDir(projectPath)}),
    onResolved({projectPath, taskId}) {
      broadcastToProject(projectPath, ReviewEvents.NOTIFY, {pendingCount: 0, taskId})
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

  const skillConnectorFactory = (projectRoot: string): SkillConnector => new SkillConnector({fileService, projectRoot})
  const hubInstallService = new HubInstallService({fileService, skillConnectorFactory})
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
  new WorktreeHandler({resolveProjectPath, transport}).setup()
  new SourceHandler({resolveProjectPath, transport}).setup()

  log('Feature handlers registered')
}
