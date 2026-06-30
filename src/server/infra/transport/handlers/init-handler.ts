import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITokenStore} from '../../../core/interfaces/auth/i-token-store.js'
import type {IConnectorManager} from '../../../core/interfaces/connectors/i-connector-manager.js'
import type {IContextTreeService} from '../../../core/interfaces/context-tree/i-context-tree-service.js'
import type {IContextTreeSnapshotService} from '../../../core/interfaces/context-tree/i-context-tree-snapshot-service.js'
import type {IContextTreeWriterService} from '../../../core/interfaces/context-tree/i-context-tree-writer-service.js'
import type {ICogitPullService} from '../../../core/interfaces/services/i-cogit-pull-service.js'
import type {ISpaceService} from '../../../core/interfaces/services/i-space-service.js'
import type {ITeamService} from '../../../core/interfaces/services/i-team-service.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {
  InitEvents,
  type InitExecuteRequest,
  type InitExecuteResponse,
  type InitGetAgentsResponse,
  type InitGetSpacesRequest,
  type InitGetSpacesResponse,
  type InitGetTeamsResponse,
  type InitLocalRequest,
  type InitLocalResponse,
} from '../../../../shared/transport/events/init-events.js'
import {isConnectorType} from '../../../../shared/types/connector-type.js'
import {isAgent} from '../../../core/domain/entities/agent.js'
import {BrvConfig} from '../../../core/domain/entities/brv-config.js'
import {NotAuthenticatedError, SpaceNotFoundError} from '../../../core/domain/errors/task-error.js'
import {syncConfigToXdg} from '../../../utils/config-xdg-sync.js'
import {getErrorMessage} from '../../../utils/error-helpers.js'
import {hashProjectPath} from '../../../utils/hash-path.js'
import {processLog} from '../../../utils/process-logger.js'
import {ensureProjectInitialized} from '../../config/auto-init.js'
import {mapAgentsToDTOs} from './agent-dto-mapper.js'
import {
  guardAgainstGitVc,
  type ProjectBroadcaster,
  type ProjectPathResolver,
  resolveRequiredProjectPath,
} from './handler-types.js'

export interface InitHandlerDeps {
  /**
   * Optional. When provided, the handler emits `brv_init` analytics
   * events at both the success terminal and every catch branch.
   */
  analyticsClient?: IAnalyticsClient
  broadcastToProject: ProjectBroadcaster
  cogitPullService: ICogitPullService
  connectorManagerFactory: (projectRoot: string) => IConnectorManager
  contextTreeService: IContextTreeService
  contextTreeSnapshotService: IContextTreeSnapshotService
  contextTreeWriterService: IContextTreeWriterService
  projectConfigStore: IProjectConfigStore
  resolveProjectPath: ProjectPathResolver
  spaceService: ISpaceService
  teamService: ITeamService
  tokenStore: ITokenStore
  transport: ITransportServer
}

/**
 * Handles init:* events.
 * Business logic for project initialization — no terminal/UI calls.
 * The TUI orchestrates the multi-step UX flow, calling granular events.
 */
export class InitHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly broadcastToProject: ProjectBroadcaster
  private readonly cogitPullService: ICogitPullService
  private readonly connectorManagerFactory: (projectRoot: string) => IConnectorManager
  private readonly contextTreeService: IContextTreeService
  private readonly contextTreeSnapshotService: IContextTreeSnapshotService
  private readonly contextTreeWriterService: IContextTreeWriterService
  private readonly projectConfigStore: IProjectConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly spaceService: ISpaceService
  private readonly teamService: ITeamService
  private readonly tokenStore: ITokenStore
  private readonly transport: ITransportServer

  constructor(deps: InitHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.broadcastToProject = deps.broadcastToProject
    this.cogitPullService = deps.cogitPullService
    this.connectorManagerFactory = deps.connectorManagerFactory
    this.contextTreeService = deps.contextTreeService
    this.contextTreeSnapshotService = deps.contextTreeSnapshotService
    this.contextTreeWriterService = deps.contextTreeWriterService
    this.projectConfigStore = deps.projectConfigStore
    this.resolveProjectPath = deps.resolveProjectPath
    this.spaceService = deps.spaceService
    this.teamService = deps.teamService
    this.tokenStore = deps.tokenStore
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<void, InitGetTeamsResponse>(InitEvents.GET_TEAMS, () => this.handleGetTeams())

    this.transport.onRequest<InitGetSpacesRequest, InitGetSpacesResponse>(InitEvents.GET_SPACES, (data) =>
      this.handleGetSpaces(data),
    )

    this.transport.onRequest<void, InitGetAgentsResponse>(InitEvents.GET_AGENTS, () => this.handleGetAgents())

    this.transport.onRequest<InitExecuteRequest, InitExecuteResponse>(InitEvents.EXECUTE, (data, clientId) =>
      this.handleExecute(data, clientId),
    )

    this.transport.onRequest<InitLocalRequest, InitLocalResponse>(InitEvents.LOCAL, (data, clientId) =>
      this.handleLocalInit(data, clientId),
    )
  }

  /**
   * Analytics emit helper. Mirrors the try/processLog pattern from other
   * handlers so analytics failures never affect command outcomes.
   */
  private emitAnalytics<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
    const client = this.analyticsClient
    if (!client) return
    try {
      client.track(event, ...rest)
    } catch (error) {
      processLog(`[Init] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleExecute(data: InitExecuteRequest, clientId: string): Promise<InitExecuteResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    await guardAgainstGitVc({contextTreeService: this.contextTreeService, projectPath})

    const token = await this.tokenStore.load()
    if (!token || !token.isValid()) {
      throw new NotAuthenticatedError()
    }

    // Naming-only refactor: capture the existing exists() result so the success
    // emit below can include `had_existing_brv_dir` without changing call order
    // or adding a second filesystem read.
    const hadExistingBrvDir = await this.projectConfigStore.exists(projectPath)
    if (hadExistingBrvDir && !data.force) {
      throw new Error('Project already initialized. Use force to re-initialize.')
    }

    this.broadcastToProject(projectPath, InitEvents.PROGRESS, {message: 'Fetching space...', step: 'fetch_space'})

    // Find space
    const {spaces} = await this.spaceService.getSpaces(token.sessionKey, data.teamId, {fetchAll: true})
    const space = spaces.find((s) => s.id === data.spaceId)
    if (!space) {
      throw new SpaceNotFoundError()
    }

    this.broadcastToProject(projectPath, InitEvents.PROGRESS, {message: 'Syncing from cloud...', step: 'sync'})

    // Pull from cloud
    try {
      const snapshot = await this.cogitPullService.pull({
        branch: 'main',
        sessionKey: token.sessionKey,
        spaceId: data.spaceId,
        teamId: data.teamId,
      })

      if (snapshot.files.length > 0) {
        await this.contextTreeWriterService.sync({directory: projectPath, files: snapshot.files})
        await this.contextTreeSnapshotService.saveSnapshot(projectPath)
      } else {
        await this.contextTreeService.initialize(projectPath)
        await this.contextTreeSnapshotService.initEmptySnapshot(projectPath)
      }
    } catch {
      // If pull fails, initialize empty context tree
      await this.contextTreeService.initialize(projectPath)
      await this.contextTreeSnapshotService.initEmptySnapshot(projectPath)
    }

    this.broadcastToProject(projectPath, InitEvents.PROGRESS, {message: 'Creating config...', step: 'config'})

    // Create and write config + XDG clone
    if (!isAgent(data.agentId)) {
      throw new Error(`Unsupported agent: ${data.agentId}`)
    }

    const brvConfig = BrvConfig.fromSpace({
      chatLogPath: '',
      cwd: projectPath,
      ide: data.agentId,
      space,
    })
    await this.projectConfigStore.write(brvConfig, projectPath)
    await syncConfigToXdg(brvConfig, projectPath)

    this.broadcastToProject(projectPath, InitEvents.PROGRESS, {message: 'Installing connector...', step: 'connector'})

    // Install connector
    try {
      if (!isConnectorType(data.connectorType)) {
        throw new Error(`Unsupported connector type: ${data.connectorType}`)
      }

      const connectorManager = this.connectorManagerFactory(projectPath)
      await connectorManager.switchConnector(data.agentId, data.connectorType)
    } catch (error) {
      // Non-fatal: connector installation failure shouldn't block init
      this.broadcastToProject(projectPath, InitEvents.PROGRESS, {
        message: `Connector warning: ${getErrorMessage(error)}`,
        step: 'connector_warning',
      })
    }

    this.broadcastToProject(projectPath, InitEvents.COMPLETED, {
      config: {spaceName: brvConfig.spaceName, teamName: brvConfig.teamName},
      success: true,
    })

    this.emitAnalytics(AnalyticsEventNames.BRV_INIT, {
      // eslint-disable-next-line camelcase
      had_existing_brv_dir: hadExistingBrvDir,
      outcome: 'success',
      // eslint-disable-next-line camelcase
      project_path_hash: hashProjectPath(projectPath),
    })
    return {success: true}
  }

  private handleGetAgents(): InitGetAgentsResponse {
    return {agents: mapAgentsToDTOs()}
  }

  private async handleGetSpaces(data: InitGetSpacesRequest): Promise<InitGetSpacesResponse> {
    const token = await this.tokenStore.load()
    if (!token || !token.isValid()) {
      throw new NotAuthenticatedError()
    }

    const {spaces} = await this.spaceService.getSpaces(token.sessionKey, data.teamId, {fetchAll: true})

    return {
      spaces: spaces.map((s) => ({
        id: s.id,
        isDefault: s.isDefault,
        name: s.name,
        teamId: s.teamId,
        teamName: s.teamName,
      })),
    }
  }

  private async handleGetTeams(): Promise<InitGetTeamsResponse> {
    const token = await this.tokenStore.load()
    if (!token || !token.isValid()) {
      throw new NotAuthenticatedError()
    }

    const {teams} = await this.teamService.getTeams(token.sessionKey, {fetchAll: true})

    return {
      teams: teams.map((t) => ({
        avatarUrl: t.avatarUrl,
        displayName: t.displayName,
        id: t.id,
        isDefault: t.isDefault,
        name: t.name,
        slug: t.slug,
      })),
    }
  }

  private async handleLocalInit(data: InitLocalRequest, clientId: string): Promise<InitLocalResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const hadExistingBrvDir = await this.projectConfigStore.exists(projectPath)

    if (hadExistingBrvDir && !data.force) {
      this.emitAnalytics(AnalyticsEventNames.BRV_INIT, {
        // eslint-disable-next-line camelcase
        had_existing_brv_dir: true,
        outcome: 'success',
        // eslint-disable-next-line camelcase
        project_path_hash: hashProjectPath(projectPath),
      })
      return {alreadyInitialized: true, success: true}
    }

    await ensureProjectInitialized(
      {contextTreeService: this.contextTreeService, projectConfigStore: this.projectConfigStore},
      projectPath,
    )

    this.emitAnalytics(AnalyticsEventNames.BRV_INIT, {
      // eslint-disable-next-line camelcase
      had_existing_brv_dir: hadExistingBrvDir,
      outcome: 'success',
      // eslint-disable-next-line camelcase
      project_path_hash: hashProjectPath(projectPath),
    })
    return {alreadyInitialized: false, success: true}
  }
}
