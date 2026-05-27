import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {IContextTreeService} from '../../../core/interfaces/context-tree/i-context-tree-service.js'
import type {IContextTreeSnapshotService} from '../../../core/interfaces/context-tree/i-context-tree-snapshot-service.js'
import type {ICurateLogStore} from '../../../core/interfaces/storage/i-curate-log-store.js'
import type {IReviewBackupStore} from '../../../core/interfaces/storage/i-review-backup-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {ResetEvents, type ResetExecuteResponse} from '../../../../shared/transport/events/reset-events.js'
import {ContextTreeNotInitializedError, GitVcInitializedError} from '../../../core/domain/errors/task-error.js'
import {processLog} from '../../../utils/process-logger.js'
import {guardAgainstGitVc, type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

export interface ResetHandlerDeps {
  analyticsClient?: IAnalyticsClient
  contextTreeService: IContextTreeService
  contextTreeSnapshotService: IContextTreeSnapshotService
  curateLogStoreFactory: (projectPath: string) => ICurateLogStore
  resolveProjectPath: ProjectPathResolver
  reviewBackupStoreFactory: (projectPath: string) => IReviewBackupStore
  transport: ITransportServer
}

/**
 * Handles reset:execute event.
 * Deletes and re-initializes the context tree — no terminal/UI calls.
 */
export class ResetHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly contextTreeService: IContextTreeService
  private readonly contextTreeSnapshotService: IContextTreeSnapshotService
  private readonly curateLogStoreFactory: (projectPath: string) => ICurateLogStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly reviewBackupStoreFactory: (projectPath: string) => IReviewBackupStore
  private readonly transport: ITransportServer

  constructor(deps: ResetHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.contextTreeService = deps.contextTreeService
    this.contextTreeSnapshotService = deps.contextTreeSnapshotService
    this.curateLogStoreFactory = deps.curateLogStoreFactory
    this.resolveProjectPath = deps.resolveProjectPath
    this.reviewBackupStoreFactory = deps.reviewBackupStoreFactory
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<void, ResetExecuteResponse>(ResetEvents.EXECUTE, (_data, clientId) =>
      this.handleExecute(clientId),
    )
  }

  /**
   * Mark all pending review operations as 'rejected' so they no longer appear in /status.
   * The context tree has been wiped, so these reviews are no longer actionable.
   */
  private async clearPendingReviews(projectPath: string): Promise<void> {
    const store = this.curateLogStoreFactory(projectPath)
    // Only completed entries can carry reviewable operations; pending reviews are assigned at completion time.
    const entries = await store.list({status: ['completed']})

    const updates = entries
      .map((entry) => {
        const pendingIndices = entry.operations
          .map((op, i) => (op.reviewStatus === 'pending' ? {operationIndex: i, reviewStatus: 'rejected' as const} : null))
          .filter((u): u is {operationIndex: number; reviewStatus: 'rejected'} => u !== null)
        return pendingIndices.length > 0 ? {id: entry.id, pendingIndices} : null
      })
      .filter((u): u is {id: string; pendingIndices: Array<{operationIndex: number; reviewStatus: 'rejected'}>} => u !== null)

    await Promise.all(updates.map((u) => store.batchUpdateOperationReviewStatus(u.id, u.pendingIndices)))
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
      processLog(`[Reset] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async handleExecute(clientId: string): Promise<ResetExecuteResponse> {
    try {
      const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
      await guardAgainstGitVc({contextTreeService: this.contextTreeService, projectPath})

      const exists = await this.contextTreeService.exists(projectPath)
      if (!exists) {
        throw new ContextTreeNotInitializedError()
      }

      await this.contextTreeService.delete(projectPath)
      await this.contextTreeService.initialize(projectPath)
      await this.contextTreeSnapshotService.initEmptySnapshot(projectPath)

      // Best-effort: clear review backups and pending review statuses so /status starts fresh
      try {
        await this.reviewBackupStoreFactory(projectPath).clear()
      } catch {
        // Backup cleanup must never block the reset response
      }

      try {
        await this.clearPendingReviews(projectPath)
      } catch {
        // Review status cleanup must never block the reset response
      }

      /* eslint-disable camelcase */
      this.emitAnalytics(AnalyticsEventNames.DAEMON_RESET_EXECUTED, {
        outcome: 'success',
        reset_scope: 'project',
      })
      /* eslint-enable camelcase */
      return {success: true}
    } catch (error) {
      /* eslint-disable camelcase */
      this.emitAnalytics(AnalyticsEventNames.DAEMON_RESET_EXECUTED, {
        failure_kind: classifyResetFailure(error),
        outcome: 'failure',
        reset_scope: 'project',
      })
      /* eslint-enable camelcase */
      throw error
    }
  }
}

function classifyResetFailure(error: unknown): string {
  if (error instanceof ContextTreeNotInitializedError) return 'not_initialized'
  if (error instanceof GitVcInitializedError) return 'git_vc_active'
  if (error instanceof Error && 'code' in error) {
    const code = String((error as {code: unknown}).code)
    if (code.startsWith('E')) return 'fs_access'
  }

  return 'unknown'
}
