import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITokenStore} from '../../../core/interfaces/auth/i-token-store.js'
import type {IContextTreeMerger} from '../../../core/interfaces/context-tree/i-context-tree-merger.js'
import type {IContextTreeService} from '../../../core/interfaces/context-tree/i-context-tree-service.js'
import type {IContextTreeSnapshotService} from '../../../core/interfaces/context-tree/i-context-tree-snapshot-service.js'
import type {IContextTreeWriterService} from '../../../core/interfaces/context-tree/i-context-tree-writer-service.js'
import type {ICogitPullService} from '../../../core/interfaces/services/i-cogit-pull-service.js'
import type {ISpaceService} from '../../../core/interfaces/services/i-space-service.js'
import type {ITeamService} from '../../../core/interfaces/services/i-team-service.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {PullEvents} from '../../../../shared/transport/events/pull-events.js'
import {
  SpaceEvents,
  type SpaceListResponse,
  type SpaceSwitchPullResult,
  type SpaceSwitchRequest,
  type SpaceSwitchResponse,
} from '../../../../shared/transport/events/space-events.js'
import {BRV_DIR, CONTEXT_TREE_CONFLICT_DIR, DEFAULT_BRANCH} from '../../../constants.js'
import {
  LocalChangesExistError,
  NotAuthenticatedError,
  ProjectNotInitError,
  SpaceNotFoundError,
} from '../../../core/domain/errors/task-error.js'
import {syncConfigToXdg} from '../../../utils/config-xdg-sync.js'
import {processLog} from '../../../utils/process-logger.js'
import {
  guardAgainstGitVc,
  hasAnyChanges,
  type ProjectBroadcaster,
  type ProjectPathResolver,
  resolveRequiredProjectPath,
} from './handler-types.js'

export interface SpaceHandlerDeps {
  analyticsClient?: IAnalyticsClient
  broadcastToProject: ProjectBroadcaster
  cogitPullService: ICogitPullService
  contextTreeMerger: IContextTreeMerger
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
 * Handles space:* events.
 * Business logic for space listing and switching — no terminal/UI calls.
 */
export class SpaceHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly broadcastToProject: ProjectBroadcaster
  private readonly cogitPullService: ICogitPullService
  private readonly contextTreeMerger: IContextTreeMerger
  private readonly contextTreeService: IContextTreeService
  private readonly contextTreeSnapshotService: IContextTreeSnapshotService
  private readonly contextTreeWriterService: IContextTreeWriterService
  private readonly projectConfigStore: IProjectConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly spaceService: ISpaceService
  private readonly teamService: ITeamService
  private readonly tokenStore: ITokenStore
  private readonly transport: ITransportServer

  constructor(deps: SpaceHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.broadcastToProject = deps.broadcastToProject
    this.cogitPullService = deps.cogitPullService
    this.contextTreeMerger = deps.contextTreeMerger
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
    this.transport.onRequest<void, SpaceListResponse>(SpaceEvents.LIST, (_data, clientId) => this.handleList(clientId))

    this.transport.onRequest<SpaceSwitchRequest, SpaceSwitchResponse>(SpaceEvents.SWITCH, (data, clientId) =>
      this.handleSwitch(data, clientId),
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
      processLog(`[Space] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleList(clientId: string): Promise<SpaceListResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)

    const token = await this.tokenStore.load()
    if (!token || !token.isValid()) {
      throw new NotAuthenticatedError()
    }

    const config = await this.projectConfigStore.read(projectPath)
    if (!config) {
      throw new ProjectNotInitError()
    }

    const {teams} = await this.teamService.getTeams(token.sessionKey, {fetchAll: true})

    const teamsWithSpaces = await Promise.all(
      teams.map(async (team) => {
        const {spaces} = await this.spaceService.getSpaces(token.sessionKey, team.id, {fetchAll: true})
        return {
          spaces: spaces.map((s) => ({
            id: s.id,
            isDefault: s.isDefault,
            name: s.name,
            teamId: s.teamId,
            teamName: s.teamName,
          })),
          teamId: team.id,
          teamName: team.name,
        }
      }),
    )

    return {teams: teamsWithSpaces}
  }

  private async handleSwitch(data: SpaceSwitchRequest, clientId: string): Promise<SpaceSwitchResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    await guardAgainstGitVc({contextTreeService: this.contextTreeService, projectPath})

    const token = await this.tokenStore.load()
    if (!token || !token.isValid()) {
      throw new NotAuthenticatedError()
    }

    const existingConfig = await this.projectConfigStore.read(projectPath)
    if (!existingConfig) {
      throw new ProjectNotInitError()
    }

    // No-op: switching to the currently active space
    if (existingConfig.spaceId === data.spaceId) {
      if (existingConfig.spaceId) {
        /* eslint-disable camelcase */
        this.emitAnalytics(AnalyticsEventNames.SPACE_SWITCHED, {
          from_space_id: existingConfig.spaceId,
          outcome: 'success',
          to_space_id: data.spaceId,
        })
        /* eslint-enable camelcase */
      }

      return {
        config: {
          spaceId: existingConfig.spaceId,
          spaceName: existingConfig.spaceName,
          teamId: existingConfig.teamId,
          teamName: existingConfig.teamName,
          version: existingConfig.version,
        },
        success: true,
      }
    }

    const localChanges = await this.contextTreeSnapshotService.getChanges(projectPath)
    const hasLocalChanges = hasAnyChanges(localChanges)

    // Already connected to a space — must push before switching
    if (existingConfig.spaceId && hasLocalChanges) {
      throw new LocalChangesExistError()
    }

    // Find the target space across all teams
    const {teams} = await this.teamService.getTeams(token.sessionKey, {fetchAll: true})
    const allSpaces = await Promise.all(
      teams.map(async (team) => {
        const {spaces} = await this.spaceService.getSpaces(token.sessionKey, team.id, {fetchAll: true})
        return spaces
      }),
    )
    const targetSpace = allSpaces.flat().find((s) => s.id === data.spaceId)

    if (!targetSpace) {
      throw new SpaceNotFoundError()
    }

    const newConfig = existingConfig.withSpace(targetSpace)

    // Config is written only after pull + merge succeed, so failure leaves config unchanged.
    let pullResult: SpaceSwitchPullResult | undefined
    let pullError: string | undefined

    if (newConfig.spaceId && newConfig.teamId) {
      try {
        this.broadcastToProject(projectPath, PullEvents.PROGRESS, {
          message: 'Pulling context from new space...',
          step: 'pulling',
        })

        const snapshot = await this.cogitPullService.pull({
          branch: DEFAULT_BRANCH,
          sessionKey: token.sessionKey,
          spaceId: newConfig.spaceId,
          teamId: newConfig.teamId,
        })

        this.broadcastToProject(projectPath, PullEvents.PROGRESS, {message: 'Syncing files...', step: 'syncing'})

        if (existingConfig.spaceId) {
          // Space-to-space switch (local changes were blocked above) — regular overwrite sync
          const syncResult = await this.contextTreeWriterService.sync({directory: projectPath, files: snapshot.files})
          await this.contextTreeSnapshotService.saveSnapshot(projectPath)

          pullResult = {
            added: syncResult.added.length,
            commitSha: snapshot.commitSha,
            deleted: syncResult.deleted.length,
            edited: syncResult.edited.length,
          }
        } else {
          // First-time connect: always merge with preserveLocalFiles=true.
          // The local context tree has no shared history with the target space, so any
          // local files absent from remote are new additions (not remote deletions).
          // This applies to tracked+clean files too, not just actively changed files.
          const mergeResult = await this.contextTreeMerger.merge({
            directory: projectPath,
            files: snapshot.files,
            localChanges,
            preserveLocalFiles: true,
          })

          if (mergeResult.conflicted.length > 0) {
            this.broadcastToProject(projectPath, PullEvents.PROGRESS, {
              message: `Auto-merged ${mergeResult.conflicted.length} conflict(s) — review ${BRV_DIR}/${CONTEXT_TREE_CONFLICT_DIR}/ for original files.`,
              step: 'syncing',
            })
          }

          if (mergeResult.restoredFromRemote.length > 0) {
            this.broadcastToProject(projectPath, PullEvents.PROGRESS, {
              message: `${mergeResult.restoredFromRemote.length} file(s) you had deleted were restored from remote because remote had a newer version: ${mergeResult.restoredFromRemote.join(', ')}`,
              step: 'syncing',
            })
          }

          pullResult = {
            added: mergeResult.added.length,
            commitSha: snapshot.commitSha,
            deleted: mergeResult.deleted.length,
            edited: mergeResult.edited.length,
            ...(mergeResult.conflicted.length > 0 && {conflicted: mergeResult.conflicted.length}),
            ...(mergeResult.restoredFromRemote.length > 0 && {restoredFromRemote: mergeResult.restoredFromRemote.length}),
          }
        }

        // Pull and merge succeeded — persist the new space config
        await this.projectConfigStore.write(newConfig, projectPath)
        await syncConfigToXdg(newConfig, projectPath)
      } catch (error) {
        // Config was never written — no rollback needed, state remains unchanged
        pullError = error instanceof Error ? error.message : String(error)
      }
    } else {
      // No pull required — write config directly
      await this.projectConfigStore.write(newConfig, projectPath)
      await syncConfigToXdg(newConfig, projectPath)
    }

    // Pull failed and config was rolled back — return the old config with success: false
    if (pullError) {
      if (existingConfig.spaceId) {
        /* eslint-disable camelcase */
        this.emitAnalytics(AnalyticsEventNames.SPACE_SWITCHED, {
          failure_kind: 'pull_failed',
          from_space_id: existingConfig.spaceId,
          outcome: 'failure',
        })
        /* eslint-enable camelcase */
      }

      return {
        config: {
          spaceId: existingConfig.spaceId,
          spaceName: existingConfig.spaceName,
          teamId: existingConfig.teamId,
          teamName: existingConfig.teamName,
          version: existingConfig.version,
        },
        pullError,
        success: false,
      }
    }

    if (existingConfig.spaceId && newConfig.spaceId) {
      /* eslint-disable camelcase */
      this.emitAnalytics(AnalyticsEventNames.SPACE_SWITCHED, {
        from_space_id: existingConfig.spaceId,
        outcome: 'success',
        to_space_id: newConfig.spaceId,
      })
      /* eslint-enable camelcase */
    }

    return {
      config: {
        spaceId: newConfig.spaceId,
        spaceName: newConfig.spaceName,
        teamId: newConfig.teamId,
        teamName: newConfig.teamName,
        version: newConfig.version,
      },
      pullResult,
      success: true,
    }
  }
}
