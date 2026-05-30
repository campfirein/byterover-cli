import type {CurateLogEntry, CurateLogOperation, CurateLogSummary, CurateLogTiming, CurateUsageRecord} from '../../core/domain/entities/curate-log-entry.js'
import type {LlmToolResultEvent} from '../../core/domain/transport/schemas.js'
import type {TaskInfo} from '../../core/domain/transport/task-info.js'
import type {ITaskLifecycleHook} from '../../core/interfaces/process/i-task-lifecycle-hook.js'
import type {ICurateLogStore} from '../../core/interfaces/storage/i-curate-log-store.js'

import {extractCurateOperations} from '../../utils/curate-result-parser.js'
import {getProjectDataDir} from '../../utils/path-utils.js'
import {transportLog} from '../../utils/process-logger.js'
import {FileCurateLogStore} from '../storage/file-curate-log-store.js'

// ── Internal state ────────────────────────────────────────────────────────────

// Re-export so existing handler consumers don't break.
export type {CurateUsageRecord} from '../../core/domain/entities/curate-log-entry.js'

type TaskState = {
  /** Cached initial entry — used in onTaskCompleted/onTaskError to avoid a getById round-trip. */
  entry: CurateLogEntry
  operations: CurateLogOperation[]
  projectPath: string
  /**
   * Snapshot of the project's `reviewDisabled` flag captured at task-create time.
   * Held for the task lifetime so onToolResult and onTaskCompleted observe a single value
   * even if the user toggles it mid-task. Sourced from `task.reviewDisabled`, which the
   * daemon stamps once at the task-create boundary.
   */
  reviewDisabled: boolean
  /** Telemetry from the executor . Set by `setCurateUsage`. */
  usage?: CurateUsageRecord
}

/** Pull the telemetry fields out of usage onto the log entry. */
function telemetryFields(record: CurateUsageRecord | undefined): {
  cacheCreationTokens?: number
  cachedInputTokens?: number
  format?: 'html' | 'markdown'
  inputTokens?: number
  outputTokens?: number
  timing?: CurateLogTiming
} {
  if (!record) return {}
  return {
    ...(record.usage?.cacheCreationTokens !== undefined && {cacheCreationTokens: record.usage.cacheCreationTokens}),
    ...(record.usage?.cachedInputTokens !== undefined && {cachedInputTokens: record.usage.cachedInputTokens}),
    ...(record.format !== undefined && {format: record.format}),
    ...(record.usage?.inputTokens !== undefined && {inputTokens: record.usage.inputTokens}),
    ...(record.usage?.outputTokens !== undefined && {outputTokens: record.usage.outputTokens}),
    ...(record.timing !== undefined && {timing: record.timing}),
  }
}

const CURATE_TASK_TYPES = ['curate', 'curate-folder'] as const

// ── Summary computation ───────────────────────────────────────────────────────

export function computeSummary(operations: CurateLogOperation[]): CurateLogSummary {
  const summary: CurateLogSummary = {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0}

  for (const op of operations) {
    if (op.status === 'failed') {
      summary.failed++
      continue
    }

    switch (op.type) {
      case 'ADD': {
        summary.added++
        break
      }

      case 'DELETE': {
        summary.deleted++
        break
      }

      case 'MERGE': {
        summary.merged++
        break
      }

      case 'UPDATE': {
        summary.updated++
        break
      }

      case 'UPSERT': {
        if (op.message?.includes('created new')) {
          summary.added++
        } else {
          summary.updated++
        }

        break
      }
    }
  }

  return summary
}

// ── CurateLogHandler ──────────────────────────────────────────────────────────

/**
 * Lifecycle hook that transparently logs curate task execution.
 *
 * Wired into TaskRouter via lifecycleHooks[]. Writes log entries to
 * per-project FileCurateLogStore. All I/O errors are swallowed — logging
 * must never block or affect curate task execution.
 */
/** Info passed to the onPendingReviews callback after curate completes with pending review ops. */
export type PendingReviewsInfo = {
  /** Transport client ID of the task originator — used for direct sendTo delivery. */
  clientId: string
  pendingCount: number
  projectPath: string
  taskId: string
}

export class CurateLogHandler implements ITaskLifecycleHook {
  /** Active task count per projectPath — used to evict idle stores. */
  private readonly activeTaskCount = new Map<string, number>()
  /** Per-project store cache (one store per projectPath). Evicted when no active tasks remain. */
  private readonly stores = new Map<string, ICurateLogStore>()
  /** In-memory state per active task. Cleared on cleanup(). */
  private readonly tasks = new Map<string, TaskState>()

  /**
   * @param createStore - Optional factory for testing. Default: FileCurateLogStore.
   * @param onPendingReviews - Optional callback fired when curate completes with pending review ops.
   *
   * Whether reviews are disabled is read directly from `task.reviewDisabled` (snapshotted by
   * the daemon at task-create time). Undefined means review enabled (fail-open).
   */
  constructor(
    private readonly createStore?: (projectPath: string) => ICurateLogStore,
    private readonly onPendingReviews?: (info: PendingReviewsInfo) => void,
  ) {}

  cleanup(taskId: string): void {
    const state = this.tasks.get(taskId)
    this.tasks.delete(taskId)

    if (state) {
      const remaining = (this.activeTaskCount.get(state.projectPath) ?? 1) - 1
      if (remaining <= 0) {
        this.activeTaskCount.delete(state.projectPath)
        this.stores.delete(state.projectPath)
      } else {
        this.activeTaskCount.set(state.projectPath, remaining)
      }
    }
  }

  /**
   * Synchronously returns the pending review count from in-memory state.
   * Included in the task:completed payload so the client receives it atomically
   * without relying on a separate review:notify event that arrives after disk I/O.
   */
  getTaskCompletionData(taskId: string): Record<string, unknown> {
    const state = this.tasks.get(taskId)
    if (!state) return {}
    const pendingReviewCount = state.operations.filter((op) => op.reviewStatus === 'pending').length
    return pendingReviewCount > 0 ? {pendingReviewCount} : {}
  }

  async onTaskCancelled(taskId: string, _task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    const store = this.getOrCreateStore(state.projectPath)

    const updated: CurateLogEntry = {
      ...state.entry,
      ...telemetryFields(state.usage),
      completedAt: Date.now(),
      operations: state.operations,
      status: 'cancelled',
      summary: computeSummary(state.operations),
    }

    await store.save(updated).catch((error: unknown) => {
      transportLog(
        `CurateLogHandler: failed to save cancelled entry for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  async onTaskCompleted(taskId: string, result: string, task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    const store = this.getOrCreateStore(state.projectPath)

    const updated: CurateLogEntry = {
      ...state.entry,
      ...telemetryFields(state.usage),
      completedAt: Date.now(),
      operations: state.operations,
      response: result || undefined,
      status: 'completed',
      summary: computeSummary(state.operations),
    }

    await store.save(updated).catch((error: unknown) => {
      transportLog(
        `CurateLogHandler: failed to save completed entry for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })

    // Notify about pending reviews (fire-and-forget)
    if (this.onPendingReviews) {
      const pendingCount = state.operations.filter((op) => op.reviewStatus === 'pending').length
      if (pendingCount > 0) {
        try {
          this.onPendingReviews({clientId: task.clientId, pendingCount, projectPath: state.projectPath, taskId})
        } catch {
          // Best-effort notification — never block task completion
        }
      }
    }
  }

  async onTaskCreate(task: TaskInfo): Promise<void | {logId?: string}> {
    if (!CURATE_TASK_TYPES.includes(task.type as (typeof CURATE_TASK_TYPES)[number])) return
    if (!task.projectPath) return

    const store = this.getOrCreateStore(task.projectPath)
    const logId = await store.getNextId().catch(() => {})
    if (!logId) return

    const entry: CurateLogEntry = {
      id: logId,
      input: {
        context: task.content || undefined,
        ...(task.files?.length ? {files: task.files} : {}),
        ...(task.folderPath ? {folders: [task.folderPath]} : {}),
      },
      operations: [],
      startedAt: task.createdAt,
      status: 'processing',
      summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
      taskId: task.taskId,
    }

    // Set in-memory state BEFORE disk write so onToolResult can see it immediately.
    // Caching `entry` here lets onTaskCompleted/onTaskError rebuild the final entry
    // without a getById round-trip — so completion is never lost even if this initial
    // save fails.
    const reviewDisabled = task.reviewDisabled ?? false
    this.tasks.set(task.taskId, {entry, operations: [], projectPath: task.projectPath, reviewDisabled})
    this.activeTaskCount.set(task.projectPath, (this.activeTaskCount.get(task.projectPath) ?? 0) + 1)

    // Fire-and-forget: logId is already known, save is best-effort.
    // Callers receive logId immediately without waiting for disk I/O.
    store.save(entry).catch((error: unknown) => {
      transportLog(
        `CurateLogHandler: failed to save processing entry for ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })

    return {logId}
  }

  async onTaskError(taskId: string, errorMessage: string, _task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    const store = this.getOrCreateStore(state.projectPath)

    // Merge telemetry into the error entry so failed curates don't
    // underreport cost. `state.usage` is populated when the executor's
    // best-effort error-path `reportTelemetry()` reaches `setCurateUsage`
    // before this handler fires; merge is a no-op when it didn't.
    const updated: CurateLogEntry = {
      ...state.entry,
      completedAt: Date.now(),
      error: errorMessage,
      operations: state.operations,
      status: 'error',
      summary: computeSummary(state.operations),
      ...telemetryFields(state.usage),
    }

    await store.save(updated).catch((error: unknown) => {
      transportLog(
        `CurateLogHandler: failed to save error entry for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  onToolResult(taskId: string, payload: LlmToolResultEvent): void {
    const state = this.tasks.get(taskId)
    if (!state) return

    const ops = extractCurateOperations(payload)
    for (const op of ops) {
      if (op.needsReview && op.status === 'success' && !state.reviewDisabled) {
        op.reviewStatus = 'pending'
      }

      // Deduplicate by filePath: keep only the latest operation per file.
      // This ensures the reviewer sees the final version, not intermediate states.
      if (op.filePath) {
        const existingIndex = state.operations.findIndex((existing) => existing.filePath === op.filePath)
        if (existingIndex !== -1) {
          state.operations[existingIndex] = op
          continue
        }
      }

      state.operations.push(op)
    }
  }

  /**
   * Inject telemetry collected by CurateExecutor (token usage, format, timing
   * tiers). Synchronous — no I/O. Merged into the final entry on completion.
   * Called once per task, after curation finishes, before onTaskCompleted/Error.
   *
   */
  setCurateUsage(taskId: string, record: CurateUsageRecord): void {
    const state = this.tasks.get(taskId)
    if (!state) return
    state.usage = record
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private getOrCreateStore(projectPath: string): ICurateLogStore {
    const existing = this.stores.get(projectPath)
    if (existing) return existing

    const store = this.createStore
      ? this.createStore(projectPath)
      : new FileCurateLogStore({baseDir: getProjectDataDir(projectPath)})

    this.stores.set(projectPath, store)
    return store
  }
}
