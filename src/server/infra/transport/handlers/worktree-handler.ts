import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {
  type WorktreeAddRequest,
  type WorktreeAddResponse,
  WorktreeEvents,
  type WorktreeListRequest,
  type WorktreeListResponse,
  type WorktreeRemoveRequest,
  type WorktreeRemoveResponse,
} from '../../../../shared/transport/events/worktree-events.js'
import {hashProjectPath} from '../../../utils/hash-path.js'
import {processLog} from '../../../utils/process-logger.js'
import {addWorktree, findParentProject, listWorktrees, removeWorktree, resolveProject} from '../../project/resolve-project.js'
import {type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

export interface WorktreeHandlerDeps {
  analyticsClient?: IAnalyticsClient
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
}

export class WorktreeHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly transport: ITransportServer

  constructor(deps: WorktreeHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.resolveProjectPath = deps.resolveProjectPath
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<WorktreeAddRequest, WorktreeAddResponse>(
      WorktreeEvents.ADD,
      async (data, clientId) => {
        // Resolve the parent project from client registration
        let projectPath: string | undefined
        try {
          projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
        } catch {
          // Client not associated — fall through to auto-detect
        }

        // Auto-detect: if no project resolved, or client's project IS the worktree path
        // (user ran `brv worktree add` from a child dir with no args), walk up to find parent
        if (!projectPath || projectPath === data.worktreePath) {
          const parent = findParentProject(data.worktreePath)
          if (parent) {
            projectPath = parent
          } else if (!projectPath) {
            /* eslint-disable camelcase */
            this.emitAnalytics(AnalyticsEventNames.WORKTREE_ADDED, {
              failure_kind: 'no_parent_project',
              outcome: 'failure',
              project_path_hash: hashProjectPath(data.worktreePath),
            })
            /* eslint-enable camelcase */
            return {message: 'No parent project found for the target directory.', success: false}
          }
        }

        const result = addWorktree(projectPath, data.worktreePath, {force: data.force})
        /* eslint-disable camelcase */
        this.emitAnalytics(AnalyticsEventNames.WORKTREE_ADDED, {
          ...(result.success ? {} : {failure_kind: 'add_failed'}),
          outcome: result.success ? 'success' : 'failure',
          project_path_hash: hashProjectPath(projectPath),
        })
        /* eslint-enable camelcase */
        return {
          backedUp: result.backedUp,
          message: result.message,
          success: result.success,
        }
      },
    )

    this.transport.onRequest<WorktreeRemoveRequest, WorktreeRemoveResponse>(
      WorktreeEvents.REMOVE,
      async (data) => {
        const targetPath = data.worktreePath
        const result = removeWorktree(targetPath)
        /* eslint-disable camelcase */
        this.emitAnalytics(AnalyticsEventNames.WORKTREE_REMOVED, {
          ...(result.success ? {} : {failure_kind: 'remove_failed'}),
          outcome: result.success ? 'success' : 'failure',
          project_path_hash: hashProjectPath(targetPath),
        })
        /* eslint-enable camelcase */
        return {
          message: result.message,
          success: result.success,
        }
      },
    )

    this.transport.onRequest<WorktreeListRequest, WorktreeListResponse>(
      WorktreeEvents.LIST,
      async (_data, clientId) => {
        const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
        const resolution = resolveProject({cwd: projectPath})

        if (!resolution) {
          return {
            projectRoot: projectPath,
            source: 'direct' as const,
            worktreeRoot: projectPath,
            worktrees: [],
          }
        }

        const worktrees = listWorktrees(resolution.projectRoot)
        return {
          projectRoot: resolution.projectRoot,
          source: resolution.source,
          worktreeRoot: resolution.worktreeRoot,
          worktrees,
        }
      },
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
      processLog(`[Worktree] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
