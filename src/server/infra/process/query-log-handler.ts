import type {QueryLogEntry} from '../../core/domain/entities/query-log-entry.js'
import type {TaskInfo} from '../../core/domain/transport/task-info.js'
import type {QueryExecutorResult} from '../../core/interfaces/executor/i-query-executor.js'
import type {ITaskLifecycleHook} from '../../core/interfaces/process/i-task-lifecycle-hook.js'
import type {IQueryLogStore} from '../../core/interfaces/storage/i-query-log-store.js'

import {getProjectDataDir} from '../../utils/path-utils.js'
import {transportLog} from '../../utils/process-logger.js'
import {FileQueryLogStore} from '../storage/file-query-log-store.js'

// ── Internal state ────────────────────────────────────────────────────────────

/**
 * Pull the telemetry fields out of the query result onto the log entry
 * . All fields are optional; absent fields are not written. Spread
 * before the discriminated-union completion fields so completion fields
 * always win on conflicting keys.
 */
function telemetryFields(result: QueryResultMetadata | undefined): {
  cacheCreationTokens?: number
  cachedInputTokens?: number
  format?: 'html' | 'markdown'
  inputTokens?: number
  outputTokens?: number
} {
  if (!result) return {}
  return {
    ...(result.usage?.cacheCreationTokens !== undefined && {cacheCreationTokens: result.usage.cacheCreationTokens}),
    ...(result.usage?.cachedInputTokens !== undefined && {cachedInputTokens: result.usage.cachedInputTokens}),
    ...(result.format !== undefined && {format: result.format}),
    ...(result.usage?.inputTokens !== undefined && {inputTokens: result.usage.inputTokens}),
    ...(result.usage?.outputTokens !== undefined && {outputTokens: result.usage.outputTokens}),
  }
}

/** Query metadata without the response string (response arrives via task:completed). */
type QueryResultMetadata = Omit<QueryExecutorResult, 'response'>

type TaskState = {
  /** Cached initial entry — used in onTaskCompleted/onTaskError to avoid a getById round-trip. */
  entry: QueryLogEntry
  projectPath: string
  /** Metadata from QueryExecutor, set by setQueryResult(). Undefined until called. */
  queryResult?: QueryResultMetadata
}

const QUERY_TASK_TYPES: ReadonlySet<string> = new Set(['query'])

// ── QueryLogHandler ──────────────────────────────────────────────────────────

/**
 * Lifecycle hook that transparently logs query task execution.
 *
 * Wired into TaskRouter via lifecycleHooks[]. Writes log entries to
 * per-project FileQueryLogStore. All I/O errors are swallowed — logging
 * must never block or affect query task execution.
 *
 * Key difference from CurateLogHandler: no onToolResult accumulation.
 * Query metadata (tier, timing, matchedDocs, searchMetadata) arrives via
 * setQueryResult() called after QueryExecutor.executeWithAgent() returns.
 */
export class QueryLogHandler implements ITaskLifecycleHook {
  /** Active task count per projectPath — used to evict idle stores. */
  private readonly activeTaskCount = new Map<string, number>()
  /** Per-project store cache (one store per projectPath). Evicted when no active tasks remain. */
  private readonly stores = new Map<string, IQueryLogStore>()
  /** In-memory state per active task. Cleared on cleanup(). */
  private readonly tasks = new Map<string, TaskState>()

  constructor(private readonly createStore?: (projectPath: string) => IQueryLogStore) {}

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
   * Expose query metadata via the lifecycle-hook contract so TaskRouter can merge it into
   * the task:completed payload sent to the originating client. Returning {} when no metadata
   * is available keeps the merge a no-op and lets the daemon emit task:completed unchanged.
   */
  getTaskCompletionData(taskId: string): Record<string, unknown> {
    const state = this.tasks.get(taskId)
    if (!state?.queryResult) return {}

    // Flatten the QueryExecutorResult's nested shape onto the task:completed payload so
    // it matches the public RecallResult contract (flat `durationMs` / `topScore`).
    // `timing` is always populated by every QueryExecutor branch, so no guard.
    // `searchMetadata` is omitted on cache hits (Tier 0/1), so guard before extracting.
    const out: Record<string, unknown> = {
      durationMs: state.queryResult.timing.durationMs,
      matchedDocs: state.queryResult.matchedDocs,
      tier: state.queryResult.tier,
    }

    if (state.queryResult.searchMetadata !== undefined) {
      out.topScore = state.queryResult.searchMetadata.topScore
    }

    return out
  }

  async onTaskCancelled(taskId: string, _task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    const store = this.getOrCreateStore(state.projectPath)

    const updated: QueryLogEntry = {
      ...state.entry,
      ...telemetryFields(state.queryResult),
      completedAt: Date.now(),
      matchedDocs: state.queryResult?.matchedDocs ?? state.entry.matchedDocs,
      searchMetadata: state.queryResult?.searchMetadata,
      status: 'cancelled',
      tier: state.queryResult?.tier,
      timing: state.queryResult?.timing,
    }

    await store.save(updated).catch((error: unknown) => {
      transportLog(
        `QueryLogHandler: failed to save cancelled entry for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  async onTaskCompleted(taskId: string, result: string, _task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    const store = this.getOrCreateStore(state.projectPath)

    const updated: QueryLogEntry = {
      ...state.entry,
      ...telemetryFields(state.queryResult),
      completedAt: Date.now(),
      matchedDocs: state.queryResult?.matchedDocs ?? state.entry.matchedDocs,
      response: result.length > 0 ? result : undefined,
      searchMetadata: state.queryResult?.searchMetadata,
      status: 'completed',
      tier: state.queryResult?.tier,
      timing: state.queryResult?.timing,
    }

    await store.save(updated).catch((error: unknown) => {
      transportLog(
        `QueryLogHandler: failed to save completed entry for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  async onTaskCreate(task: TaskInfo): Promise<void | {logId?: string}> {
    if (!QUERY_TASK_TYPES.has(task.type)) return
    if (!task.projectPath) return

    const store = this.getOrCreateStore(task.projectPath)
    const logId = await store.getNextId().catch((error: unknown) => {
      transportLog(
        `QueryLogHandler: getNextId failed for ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
    if (!logId) return

    const entry: QueryLogEntry = {
      id: logId,
      matchedDocs: [],
      query: task.content,
      startedAt: task.createdAt,
      status: 'processing',
      taskId: task.taskId,
    }

    // MEMORY-FIRST: Set in-memory state BEFORE disk write so setQueryResult can access it immediately.
    // Caching `entry` here lets onTaskCompleted/onTaskError rebuild the final entry
    // without a getById round-trip — so completion is never lost even if this initial
    // save fails.
    this.tasks.set(task.taskId, {entry, projectPath: task.projectPath})
    this.activeTaskCount.set(task.projectPath, (this.activeTaskCount.get(task.projectPath) ?? 0) + 1)

    // Fire-and-forget disk I/O — logId is already known and returned.
    store.save(entry).catch((error: unknown) => {
      transportLog(
        `QueryLogHandler: failed to save processing entry for ${task.taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })

    return {logId}
  }

  async onTaskError(taskId: string, errorMessage: string, _task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    const store = this.getOrCreateStore(state.projectPath)

    const updated: QueryLogEntry = {
      ...state.entry,
      ...telemetryFields(state.queryResult),
      completedAt: Date.now(),
      error: errorMessage,
      matchedDocs: state.queryResult?.matchedDocs ?? state.entry.matchedDocs,
      searchMetadata: state.queryResult?.searchMetadata,
      status: 'error',
      tier: state.queryResult?.tier,
      timing: state.queryResult?.timing,
    }

    await store.save(updated).catch((error: unknown) => {
      transportLog(
        `QueryLogHandler: failed to save error entry for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  /**
   * Store query execution metadata for later finalization.
   * Called by agent-process after QueryExecutor.executeWithAgent() returns.
   * Synchronous — no I/O. Metadata is merged into the final entry on completion.
   */
  setQueryResult(taskId: string, result: QueryResultMetadata): void {
    const state = this.tasks.get(taskId)
    if (!state) return
    state.queryResult = result
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private getOrCreateStore(projectPath: string): IQueryLogStore {
    const existing = this.stores.get(projectPath)
    if (existing) return existing

    const store = this.createStore
      ? this.createStore(projectPath)
      : new FileQueryLogStore({baseDir: getProjectDataDir(projectPath)})

    this.stores.set(projectPath, store)
    return store
  }
}
