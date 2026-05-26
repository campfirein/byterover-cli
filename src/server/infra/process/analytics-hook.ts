/* eslint-disable camelcase */
import {readFile as readFileAsync} from 'node:fs/promises'

import type {AnalyticsEventName} from '../../../shared/analytics/event-names.js'
import type {CurateRunCompletedProps} from '../../../shared/analytics/events/curate-run-completed.js'
import type {PropsArg} from '../../../shared/analytics/events/index.js'
import type {QueryCompletedProps} from '../../../shared/analytics/events/query-completed.js'
import type {LlmToolResultEvent} from '../../core/domain/transport/schemas.js'
import type {TaskInfo} from '../../core/domain/transport/task-info.js'
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {ITaskLifecycleHook} from '../../core/interfaces/process/i-task-lifecycle-hook.js'
import type {QueryResultMetadata} from './query-log-handler.js'

import {AnalyticsEventNames} from '../../../shared/analytics/event-names.js'
import {parseFrontmatter} from '../../core/domain/knowledge/markdown-writer.js'
import {extractCurateOperations} from '../../utils/curate-result-parser.js'
import {processLog} from '../../utils/process-logger.js'
import {CURATE_TASK_TYPES} from './curate-log-handler.js'
import {QUERY_TASK_TYPES} from './query-log-handler.js'

// `CURATE_TASK_TYPES` is exported as a readonly tuple; wrap in a Set<string>
// for cast-free `.has()` lookups against TaskInfo.type (string).
const CURATE_TASK_TYPE_SET: ReadonlySet<string> = new Set(CURATE_TASK_TYPES)

const READ_FILE_TOOL = 'read_file'
const EXPAND_KNOWLEDGE_TOOL = 'expand_knowledge'
const SEARCH_KNOWLEDGE_TOOL = 'search_knowledge'

const MAX_READ_PATHS = 10
const MAX_FRONTMATTER_ARRAY_LENGTH = 50
const MAX_FRONTMATTER_STRING_LENGTH = 256

type FrontmatterFields = {
  keywords?: string[]
  related?: string[]
  tags?: string[]
}

/**
 * Clip a frontmatter array to schema caps: array length <= 50, per-entry
 * string length <= 256. Returns `undefined` when the input is not an array
 * or is empty (so the emit can OMIT the field instead of carrying `[]`).
 */
function capStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    strings.push(entry.length > MAX_FRONTMATTER_STRING_LENGTH ? entry.slice(0, MAX_FRONTMATTER_STRING_LENGTH) : entry)
    if (strings.length >= MAX_FRONTMATTER_ARRAY_LENGTH) break
  }

  return strings.length > 0 ? strings : undefined
}

type CurateTaskTypeLiteral = (typeof CURATE_TASK_TYPES)[number]

type CurateCounters = {
  added: number
  deleted: number
  failed: number
  merged: number
  pendingReview: number
  updated: number
}

type CurateTaskAnalyticsState = {
  counters: CurateCounters
  flavor: 'curate'
  taskType: CurateTaskTypeLiteral
}

type QueryTaskAnalyticsState = {
  flavor: 'query'
  queryMeta?: QueryResultMetadata
}

type TaskAnalyticsState = CurateTaskAnalyticsState | QueryTaskAnalyticsState

const isCurateLiteral = (value: string): value is CurateTaskTypeLiteral =>
  CURATE_TASK_TYPE_SET.has(value)

/**
 * Lifecycle hook that emits per-task analytics (curate_operation_applied,
 * curate_run_completed, query_completed) into the daemon's
 * `IAnalyticsClient`. Pure in-memory state keyed by `taskId`; no I/O of its own.
 *
 * Wired as a peer to `CurateLogHandler` / `QueryLogHandler` /
 * `TaskHistoryHook` inside `TaskRouter.lifecycleHooks[]`. Does NOT modify the
 * other handlers — read paths and curate-op accumulators are recomputed here
 * via the shared `extractCurateOperations` parser and `task.toolCalls[]`
 * shape, so analytics emit is decoupled from log persistence.
 *
 * M12.2 emits skeleton payloads (no frontmatter harvest). M12.3 layers
 * `tags` / `keywords` / `related` arrays onto the curate-op and per-read-path
 * payloads via a daemon-side post-op file read.
 */
type AnalyticsHookDeps = {
  /**
   * Returns the daemon's cached analytics-enabled flag. Used by M12.3 to
   * short-circuit frontmatter file reads when analytics is disabled (avoids
   * wasted disk I/O on top of the no-op `track()`). Defaults to `() => true`
   * in tests; production wires `() => globalConfigHandler.getCachedAnalytics()`.
   */
  isEnabled?: () => boolean
  /**
   * Async file reader. Defaults to `node:fs/promises.readFile`. Injectable
   * so unit tests can stub disk timing without touching the real filesystem
   * (the per-task serialization tests in `analytics-hook.test.ts` rely on
   * controlled `Deferred` promises here).
   */
  readFile?: (filePath: string, encoding: 'utf8') => Promise<string>
}

export class AnalyticsHook implements ITaskLifecycleHook {
  /** Lazy-injected by the daemon after `setupFeatureHandlers` constructs the client. */
  private analyticsClient?: IAnalyticsClient
  private readonly isEnabled: () => boolean
  /**
   * Per-task FIFO of in-flight `onToolResult` processing. Without this the
   * naive async refactor would let concurrent TOOL_RESULT events for the
   * SAME task interleave their reads + emits (socket.io does NOT serialize
   * async listener invocations). The map holds a NEVER-REJECTING chain so a
   * thrown read in one op cannot poison subsequent ops on the same task.
   * Drained by terminal hooks (`onTaskCompleted` / `dispatchTerminal`)
   * before the run-completion emit goes out, then removed in `cleanup()`.
   */
  private readonly pendingByTask = new Map<string, Promise<void>>()
  private readonly readFile: (filePath: string, encoding: 'utf8') => Promise<string>
  /** In-memory state per active task. Cleared on cleanup(). */
  private readonly tasks = new Map<string, TaskAnalyticsState>()

  constructor(deps: AnalyticsHookDeps = {}) {
    this.isEnabled = deps.isEnabled ?? (() => true)
    this.readFile = deps.readFile ?? readFileAsync
  }

  cleanup(taskId: string): void {
    this.tasks.delete(taskId)
    this.pendingByTask.delete(taskId)
  }

  async onTaskCancelled(taskId: string, task: TaskInfo): Promise<void> {
    await this.dispatchTerminal(taskId, task, 'cancelled')
  }

  async onTaskCompleted(taskId: string, _result: string, task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    // Drain any in-flight per-op processing so CURATE_OPERATION_APPLIED emits
    // land BEFORE the run-completion emit on the wire. The chain never
    // rejects (see `onToolResult`), so this await is safe.
    await this.pendingByTask.get(taskId)

    if (state.flavor === 'curate') {
      const outcome = state.counters.failed > 0 ? 'partial' : 'completed'
      this.emit(
        AnalyticsEventNames.CURATE_RUN_COMPLETED,
        this.buildCurateRunPayload({outcome, state, task, taskId}),
      )
    } else {
      this.emit(
        AnalyticsEventNames.QUERY_COMPLETED,
        await this.buildQueryCompletedPayload({outcome: 'completed', state, task, taskId}),
      )
    }
  }

  async onTaskCreate(task: TaskInfo): Promise<void> {
    if (isCurateLiteral(task.type)) {
      this.tasks.set(task.taskId, {
        counters: {added: 0, deleted: 0, failed: 0, merged: 0, pendingReview: 0, updated: 0},
        flavor: 'curate',
        taskType: task.type,
      })
      return
    }

    if (QUERY_TASK_TYPES.has(task.type)) {
      this.tasks.set(task.taskId, {flavor: 'query'})
    }
  }

  async onTaskError(taskId: string, _errorMessage: string, task: TaskInfo): Promise<void> {
    await this.dispatchTerminal(taskId, task, 'error')
  }

  async onToolResult(taskId: string, payload: LlmToolResultEvent): Promise<void> {
    // Chain onto any in-flight processing for THIS task so:
    //   1. Per-op CURATE_OPERATION_APPLIED emits land in arrival order,
    //      even when a later op's read settles before an earlier op's read.
    //   2. The terminal emit (drained via pendingByTask.get(taskId) in
    //      onTaskCompleted / dispatchTerminal) observes ALL per-op emits.
    // The map stores a never-rejecting tail (`.catch(() => {})`) so a
    // failure in one onToolResult cannot poison subsequent ones — but the
    // returned `next` preserves rejection so the caller observes its own
    // error (TaskRouter logs it).
    const prev = this.pendingByTask.get(taskId) ?? Promise.resolve()
    const next = prev.then(async () => this.processToolResult(taskId, payload))
    this.pendingByTask.set(
      taskId,
      next.catch(() => {}),
    )
    await next
  }

  /**
   * Wired by the daemon factory after `setupFeatureHandlers` constructs
   * the real `IAnalyticsClient`. Calls to `emit()` before this setter
   * runs silently no-op (no tasks are active during daemon boot).
   */
  setAnalyticsClient(client: IAnalyticsClient): void {
    this.analyticsClient = client
  }

  /**
   * Cache per-task query execution metadata for later finalization.
   * Symmetric to `QueryLogHandler.setQueryResult`. Called from the
   * `QUERY_RESULT` transport handler fan-out in `brv-server.ts`.
   */
  setQueryResult(taskId: string, metadata: QueryResultMetadata): void {
    const state = this.tasks.get(taskId)
    if (!state || state.flavor !== 'query') return
    state.queryMeta = metadata
  }

  private buildCurateRunPayload({
    outcome,
    state,
    task,
    taskId,
  }: {
    outcome: 'cancelled' | 'completed' | 'error' | 'partial'
    state: CurateTaskAnalyticsState
    task: TaskInfo
    taskId: string
  }): CurateRunCompletedProps {
    return {
      duration_ms: this.durationMs(task),
      operations_added: state.counters.added,
      operations_deleted: state.counters.deleted,
      operations_failed: state.counters.failed,
      operations_merged: state.counters.merged,
      operations_updated: state.counters.updated,
      outcome,
      pending_review_count: state.counters.pendingReview,
      task_id: taskId,
      task_type: state.taskType,
    }
  }

  private async buildQueryCompletedPayload({
    outcome,
    state,
    task,
    taskId,
  }: {
    outcome: 'cancelled' | 'completed' | 'error'
    state: QueryTaskAnalyticsState
    task: TaskInfo
    taskId: string
  }): Promise<QueryCompletedProps> {
    const readPaths = new Set<string>()
    let readToolCallCount = 0
    let searchCallCount = 0

    for (const call of task.toolCalls ?? []) {
      // `call.args` is a required `Record<string, unknown>` on ToolCallEvent;
      // index access returns `unknown` (possibly undefined when the key is
      // absent), so the runtime `typeof === 'string'` check below is what
      // actually narrows. No optional chain on `args` itself.
      switch (call.toolName) {
        case EXPAND_KNOWLEDGE_TOOL: {
          readToolCallCount++
          const {overviewPath, stubPath} = call.args
          if (typeof stubPath === 'string' && stubPath.length > 0) readPaths.add(stubPath)
          if (typeof overviewPath === 'string' && overviewPath.length > 0) readPaths.add(overviewPath)

          break
        }

        case READ_FILE_TOOL: {
          readToolCallCount++
          const {filePath} = call.args
          if (typeof filePath === 'string' && filePath.length > 0) readPaths.add(filePath)

          break
        }

        case SEARCH_KNOWLEDGE_TOOL: {
          searchCallCount++

          break
        }
        // No default
      }
    }

    const cappedPaths = [...readPaths].sort().slice(0, MAX_READ_PATHS)
    const tier = state.queryMeta?.tier
    const matchedDocCount = state.queryMeta?.searchMetadata?.resultCount ?? 0

    // M12.3: harvest per-path frontmatter on the same async read path used
    // for curate emits. Entries whose file is unreadable / has no frontmatter
    // carry `absolute_path` alone (the three array fields stay absent).
    // `Promise.all` preserves input-array order in the result regardless of
    // which read settles first.
    const readPathsWithMetadata = await Promise.all(
      cappedPaths.map(async (p) => {
        const fm = await this.readFrontmatterFields(p)
        return {
          absolute_path: p,
          ...(fm.keywords ? {keywords: fm.keywords} : {}),
          ...(fm.related ? {related: fm.related} : {}),
          ...(fm.tags ? {tags: fm.tags} : {}),
        }
      }),
    )

    return {
      cache_hit: tier === 0 || tier === 1,
      duration_ms: this.durationMs(task),
      matched_doc_count: matchedDocCount,
      outcome,
      read_doc_count: readPaths.size,
      // M12.1 schema marks read_paths_with_metadata as optional outer array.
      // Mirror that: omit the field when the command had no read paths
      // (instead of emitting an empty array). Same idiom as `tier` above.
      ...(readPathsWithMetadata.length > 0 ? {read_paths_with_metadata: readPathsWithMetadata} : {}),
      read_tool_call_count: readToolCallCount,
      search_call_count: searchCallCount,
      task_id: taskId,
      task_type: 'query',
      ...(tier === undefined ? {} : {tier}),
    }
  }

  private async dispatchTerminal(taskId: string, task: TaskInfo, outcome: 'cancelled' | 'error'): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state) return

    // Drain any in-flight per-op processing so CURATE_OPERATION_APPLIED
    // emits land before this terminal emit. Symmetric to onTaskCompleted.
    await this.pendingByTask.get(taskId)

    if (state.flavor === 'curate') {
      this.emit(
        AnalyticsEventNames.CURATE_RUN_COMPLETED,
        this.buildCurateRunPayload({outcome, state, task, taskId}),
      )
    } else {
      this.emit(
        AnalyticsEventNames.QUERY_COMPLETED,
        await this.buildQueryCompletedPayload({outcome, state, task, taskId}),
      )
    }
  }

  private durationMs(task: TaskInfo): number {
    return Math.max(0, (task.completedAt ?? Date.now()) - task.createdAt)
  }

  private emit<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
    const client = this.analyticsClient
    if (!client) return
    try {
      client.track(event, ...rest)
    } catch (error) {
      processLog(`AnalyticsHook: ${event} track failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async processToolResult(taskId: string, payload: LlmToolResultEvent): Promise<void> {
    const state = this.tasks.get(taskId)
    if (!state || state.flavor !== 'curate') return

    const ops = extractCurateOperations(payload)
    for (const op of ops) {
      if (op.status !== 'success') {
        state.counters.failed++
        continue
      }

      // Bump counters per op.type. UPSERT counts as `added` when the message
      // hints at a new-file create (mirrors `computeSummary` in
      // curate-log-handler.ts); otherwise treat as an update.
      switch (op.type) {
        case 'ADD': {
          state.counters.added++
          break
        }

        case 'DELETE': {
          state.counters.deleted++
          break
        }

        case 'MERGE': {
          state.counters.merged++
          break
        }

        case 'UPDATE': {
          state.counters.updated++
          break
        }

        case 'UPSERT': {
          if (op.message?.includes('created new')) state.counters.added++
          else state.counters.updated++
          break
        }
      }

      if (op.needsReview === true) state.counters.pendingReview++

      // `op.filePath` is optional on CurateLogOperation but every M12 emit
      // requires absolute_path. Skip ops missing filePath so the daemon
      // never emits a malformed row (these are rare; UPSERT/MERGE without
      // a concrete file path would be the only realistic case).
      if (!op.filePath) continue

      // M12.3: read post-op frontmatter for ADD / UPDATE / MERGE-target /
      // UPSERT. DELETE skips the read (file is gone). Frontmatter fields
      // stay absent when the read fails (ENOENT, EACCES, malformed YAML).
      // eslint-disable-next-line no-await-in-loop -- emit order MUST match op order
      const frontmatter = op.type === 'DELETE' ? {} : await this.readFrontmatterFields(op.filePath)

      this.emit(AnalyticsEventNames.CURATE_OPERATION_APPLIED, {
        absolute_path: op.filePath,
        ...(op.confidence ? {confidence: op.confidence} : {}),
        ...(op.impact ? {impact: op.impact} : {}),
        ...(frontmatter.keywords ? {keywords: frontmatter.keywords} : {}),
        knowledge_path: op.path,
        needs_review: op.needsReview ?? false,
        operation_type: op.type,
        ...(frontmatter.related ? {related: frontmatter.related} : {}),
        ...(frontmatter.tags ? {tags: frontmatter.tags} : {}),
        task_id: taskId,
      })
    }
  }

  /**
   * Read the YAML frontmatter from `filePath` and return only `tags` /
   * `keywords` / `related` arrays (capped at 50 entries / 256 chars per
   * entry). Returns an empty object on ANY failure: ENOENT, EACCES,
   * permission errors, malformed YAML. Telemetry MUST NOT crash the hook.
   *
   * Async (`node:fs/promises.readFile`) so the daemon event loop is free
   * to serve other transport requests while the read is in flight. The
   * per-task queue in `onToolResult` enforces emit-arrival order across
   * concurrent invocations on the same task; for query-task termination
   * `Promise.all` parallelises up to 10 reads while preserving array order.
   *
   * Short-circuits when analytics is disabled to avoid wasted disk I/O.
   */
  private async readFrontmatterFields(filePath: string): Promise<FrontmatterFields> {
    if (!this.isEnabled()) return {}
    try {
      const content = await this.readFile(filePath, 'utf8')
      const parsed = parseFrontmatter(content)
      if (parsed === null) return {}
      return {
        keywords: capStringArray(parsed.frontmatter.keywords),
        related: capStringArray(parsed.frontmatter.related),
        tags: capStringArray(parsed.frontmatter.tags),
      }
    } catch {
      // ENOENT, EACCES, permission, malformed YAML — all silently treated
      // as "no frontmatter". No retry, no log noise.
      return {}
    }
  }
}
