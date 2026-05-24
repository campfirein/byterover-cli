import {mkdir, unlink, writeFile} from 'node:fs/promises'
import {dirname, join, relative} from 'node:path'

import type {ICurateLogStore} from '../../../core/interfaces/storage/i-curate-log-store.js'
import type {IProjectConfigStore} from '../../../core/interfaces/storage/i-project-config-store.js'
import type {IReviewBackupStore} from '../../../core/interfaces/storage/i-review-backup-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  type AgentChangeOperation,
  type ReviewDecideTaskRequest,
  type ReviewDecideTaskResponse,
  ReviewEvents,
  type ReviewGetDisabledResponse,
  type ReviewListOperationsResponse,
  type ReviewPendingOperation,
  type ReviewPendingResponse,
  type ReviewPendingTask,
  type ReviewSetDisabledRequest,
  type ReviewSetDisabledResponse,
} from '../../../../shared/transport/events/review-events.js'
import {BRV_DIR, CONTEXT_TREE_DIR} from '../../../constants.js'
import {type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

// ── Types ────────────────────────────────────────────────────────────────────

type CurateLogStoreFactory = (projectPath: string) => ICurateLogStore
type ReviewBackupStoreFactory = (projectPath: string) => IReviewBackupStore

export interface ReviewHandlerDeps {
  curateLogStoreFactory: CurateLogStoreFactory
  /** Called after all pending ops for a task are decided. Used to notify TUI clients. */
  onResolved?: (info: {projectPath: string; taskId: string}) => void
  projectConfigStore: IProjectConfigStore
  resolveProjectPath: ProjectPathResolver
  reviewBackupStoreFactory: ReviewBackupStoreFactory
  transport: ITransportServer
}

type PendingOp = {
  additionalFilePaths?: string[]
  logId: string
  operationIndex: number
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function writeFileWithDirs(absolutePath: string, content: string): Promise<void> {
  await mkdir(dirname(absolutePath), {recursive: true})
  await writeFile(absolutePath, content, 'utf8')
}

function projectContextTreeFilePath(absoluteFilePath: string | undefined, contextTreeDir: string): string | undefined {
  if (!absoluteFilePath) return undefined
  const rel = relative(contextTreeDir, absoluteFilePath)
  if (rel.startsWith('..')) return undefined
  return rel
}

// ── Handler ──────────────────────────────────────────────────────────────────

/**
 * Handles review:decideTask — approves or rejects all pending review operations
 * for a given task ID in a single transport request.
 *
 * Mirrors the per-file logic in review-api-handler.ts but operates at task scope.
 */
export class ReviewHandler {
  private readonly curateLogStoreFactory: CurateLogStoreFactory
  private readonly onResolved: ReviewHandlerDeps['onResolved']
  private readonly projectConfigStore: IProjectConfigStore
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly reviewBackupStoreFactory: ReviewBackupStoreFactory
  private readonly transport: ITransportServer

  constructor(deps: ReviewHandlerDeps) {
    this.curateLogStoreFactory = deps.curateLogStoreFactory
    this.onResolved = deps.onResolved
    this.projectConfigStore = deps.projectConfigStore
    this.resolveProjectPath = deps.resolveProjectPath
    this.reviewBackupStoreFactory = deps.reviewBackupStoreFactory
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<ReviewDecideTaskRequest, ReviewDecideTaskResponse>(
      ReviewEvents.DECIDE_TASK,
      (data, clientId) => this.handleDecideTask(data, clientId),
    )

    this.transport.onRequest<Record<string, unknown>, ReviewGetDisabledResponse>(
      ReviewEvents.GET_DISABLED,
      (_data, clientId) => this.handleGetDisabled(clientId),
    )

    this.transport.onRequest<Record<string, unknown>, ReviewListOperationsResponse>(
      ReviewEvents.LIST_OPERATIONS,
      (_data, clientId) => this.handleListOperations(clientId),
    )

    this.transport.onRequest<Record<string, unknown>, ReviewPendingResponse>(
      ReviewEvents.PENDING,
      (_data, clientId) => this.handlePending(clientId),
    )

    this.transport.onRequest<ReviewSetDisabledRequest, ReviewSetDisabledResponse>(
      ReviewEvents.SET_DISABLED,
      (data, clientId) => this.handleSetDisabled(data, clientId),
    )
  }

  private async handleDecideTask(
    {decision, filePaths: filterPaths, taskId}: ReviewDecideTaskRequest,
    clientId: string,
  ): Promise<ReviewDecideTaskResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const contextTreeDir = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)

    const store = this.curateLogStoreFactory(projectPath)
    const backupStore = this.reviewBackupStoreFactory(projectPath)
    const entries = await store.list()

    // Collect pending ops grouped by relative file path for this taskId
    const pendingByPath = new Map<string, PendingOp[]>()

    for (const entry of entries) {
      if (entry.taskId !== taskId) continue

      for (let i = 0; i < entry.operations.length; i++) {
        const op = entry.operations[i]
        if (op.reviewStatus !== 'pending') continue

        const rel = projectContextTreeFilePath(op.filePath, contextTreeDir)
        if (!rel) continue

        let ops = pendingByPath.get(rel)
        if (!ops) {
          ops = []
          pendingByPath.set(rel, ops)
        }

        ops.push({additionalFilePaths: op.additionalFilePaths, logId: entry.id, operationIndex: i})
      }
    }

    // If filePaths filter is provided, only process those files
    if (filterPaths?.length) {
      const filterSet = new Set(filterPaths)
      const keysToDelete = [...pendingByPath.keys()].filter((key) => !filterSet.has(key))
      for (const key of keysToDelete) pendingByPath.delete(key)
    }

    type FileResult = {ops: PendingOp[]; path: string; reverted: boolean}

    // Apply decision for each affected file in parallel.
    // allSettled so a single file failure does not block log updates for files that succeeded.
    const settled = await Promise.allSettled(
      [...pendingByPath.entries()].map(async ([relPath, ops]): Promise<FileResult> => {
        let reverted = false
        const allAdditionalPaths = [...new Set(ops.flatMap((o) => o.additionalFilePaths ?? []))]

        if (decision === 'rejected') {
          const absolutePath = join(contextTreeDir, relPath)
          const backupContent = await backupStore.read(relPath)

          // null backup = ADD operation (new file) → remove it; existing backup → restore
          await (backupContent === null
            ? unlink(absolutePath).catch(() => {})
            : writeFileWithDirs(absolutePath, backupContent))

          // Restore additional paths (MERGE source, folder DELETE contents).
          // Best-effort: partial failures must not block the log update below.
          await Promise.allSettled(
            allAdditionalPaths.map(async (absPath) => {
              const rel = relative(contextTreeDir, absPath)
              const content = await backupStore.read(rel)
              if (content !== null) await writeFileWithDirs(absPath, content)
            }),
          )

          reverted = true
        }

        // Clear backups for both approve and reject (current state becomes new baseline)
        await backupStore.delete(relPath)
        await Promise.allSettled(
          allAdditionalPaths.map((absPath) => backupStore.delete(relative(contextTreeDir, absPath))),
        )

        return {ops, path: relPath, reverted}
      }),
    )

    // Only update log entries for files that were successfully processed.
    // Files that failed remain pending and can be retried.
    const fileResults = settled
      .filter((r): r is PromiseFulfilledResult<FileResult> => r.status === 'fulfilled')
      .map((r) => r.value)

    // Batch-update review status grouped by logId (one read+write per entry file)
    const byLogId = new Map<string, Array<{operationIndex: number; reviewStatus: 'approved' | 'rejected'}>>()
    for (const {ops} of fileResults) {
      for (const {logId, operationIndex} of ops) {
        let batch = byLogId.get(logId)
        if (!batch) {
          batch = []
          byLogId.set(logId, batch)
        }

        batch.push({operationIndex, reviewStatus: decision})
      }
    }

    await Promise.all(
      [...byLogId.entries()].map(([logId, updates]) => store.batchUpdateOperationReviewStatus(logId, updates)),
    )

    try {
      this.onResolved?.({projectPath, taskId})
    } catch {
      // Best-effort notification — never block the response
    }

    const totalCount = fileResults.reduce((sum, {ops}) => sum + ops.length, 0)
    return {files: fileResults.map(({path, reverted}) => ({path, reverted})), totalCount}
  }

  private async handleGetDisabled(clientId: string): Promise<ReviewGetDisabledResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const config = await this.projectConfigStore.read(projectPath)
    if (!config) {
      throw new Error(`Project not initialized: ${projectPath}. Run \`brv init\` first.`)
    }

    return {reviewDisabled: config.reviewDisabled === true}
  }

  private async handleListOperations(clientId: string): Promise<ReviewListOperationsResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const config = await this.projectConfigStore.read(projectPath)
    if (!config) {
      throw new Error(`Project not initialized: ${projectPath}. Run \`brv init\` first.`)
    }

    if (config.reviewDisabled === true) return {operations: []}

    const contextTreeDir = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)
    const store = this.curateLogStoreFactory(projectPath)
    const entries = await store.list({limit: 200, status: ['completed']})

    const operations: AgentChangeOperation[] = []
    for (const entry of entries) {
      for (const op of entry.operations) {
        if (op.status === 'failed') continue
        const filePath = projectContextTreeFilePath(op.filePath, contextTreeDir)
        if (!filePath) continue

        const projected: AgentChangeOperation = {
          filePath,
          opCreatedAt: entry.startedAt,
          taskId: entry.taskId,
          type: op.type,
        }
        if (op.impact) projected.impact = op.impact
        if (op.reason) projected.reason = op.reason
        if (op.summary) projected.summary = op.summary
        if (op.reviewStatus) projected.reviewStatus = op.reviewStatus
        operations.push(projected)
      }
    }

    return {operations}
  }

  private async handlePending(clientId: string): Promise<ReviewPendingResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const contextTreeDir = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)
    const store = this.curateLogStoreFactory(projectPath)
    const entries = await store.list({status: ['completed']})

    const taskMap = new Map<string, ReviewPendingOperation[]>()

    for (const entry of entries) {
      for (const op of entry.operations) {
        // Skip failed ops (e.g. validation errors) — they were never applied to disk
        if (op.reviewStatus !== 'pending' || op.status === 'failed') continue

        let ops = taskMap.get(entry.taskId)
        if (!ops) {
          ops = []
          taskMap.set(entry.taskId, ops)
        }

        const pendingOp: ReviewPendingOperation = {path: op.path, type: op.type}
        const filePath = projectContextTreeFilePath(op.filePath, contextTreeDir)
        if (filePath) pendingOp.filePath = filePath

        if (op.impact) pendingOp.impact = op.impact
        if (op.reason) pendingOp.reason = op.reason
        if (op.previousSummary) pendingOp.previousSummary = op.previousSummary
        if (op.summary) pendingOp.summary = op.summary
        ops.push(pendingOp)
      }
    }

    const tasks: ReviewPendingTask[] = [...taskMap.entries()].map(([taskId, operations]) => ({
      operations,
      taskId,
    }))
    const pendingCount = tasks.reduce((sum, t) => sum + t.operations.length, 0)

    return {pendingCount, tasks}
  }

  private async handleSetDisabled(
    {reviewDisabled}: ReviewSetDisabledRequest,
    clientId: string,
  ): Promise<ReviewSetDisabledResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const config = await this.projectConfigStore.read(projectPath)
    if (!config) {
      throw new Error(`Project not initialized: ${projectPath}. Run \`brv init\` first.`)
    }

    const updated = config.withReviewDisabled(reviewDisabled)
    await this.projectConfigStore.write(updated, projectPath)
    return {reviewDisabled}
  }
}
