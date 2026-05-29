/* eslint-disable camelcase */
import {readFile as readFileAsync} from 'node:fs/promises'
import {basename, isAbsolute as isAbsolutePath, relative as relativePath} from 'node:path'

import type {AnalyticsEventName} from '../../../shared/analytics/event-names.js'
import type {CurateRunCompletedProps} from '../../../shared/analytics/events/curate-run-completed.js'
import type {PropsArg} from '../../../shared/analytics/events/index.js'
import type {QueryCompletedProps} from '../../../shared/analytics/events/query-completed.js'
import type {FailureKind} from '../../../shared/analytics/events/task-failed.js'
import type {TaskType} from '../../../shared/analytics/task-types.js'
import type {LlmToolResultEvent} from '../../core/domain/transport/schemas.js'
import type {TaskInfo} from '../../core/domain/transport/task-info.js'
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {ITaskLifecycleHook} from '../../core/interfaces/process/i-task-lifecycle-hook.js'
import type {QueryResultMetadata} from './query-log-handler.js'

import {AnalyticsEventNames} from '../../../shared/analytics/event-names.js'
import {TaskTypes} from '../../../shared/analytics/task-types.js'
import {parseFrontmatter} from '../../core/domain/knowledge/markdown-writer.js'
import {extractCurateOperations} from '../../utils/curate-result-parser.js'
import {hashProjectPath} from '../../utils/hash-path.js'
import {processLog} from '../../utils/process-logger.js'
import {readHtmlTopicSync} from '../render/reader/html-reader.js'
import {CURATE_TASK_TYPES} from './curate-log-handler.js'
import {QUERY_TASK_TYPES} from './query-log-handler.js'

/**
 * Set of canonical task types accepted by the wire schema. Membership check
 * runs in `toAnalyticsTaskType` to gate emits against the daemon dispatching
 * a string TASK_TYPE_VALUES doesn't enumerate.
 */
const ANALYTICS_TASK_TYPE_SET: ReadonlySet<TaskType> = new Set(Object.values(TaskTypes) as TaskType[])

const isCanonicalTaskType = (value: string): value is TaskType => (ANALYTICS_TASK_TYPE_SET as Set<string>).has(value)

/**
 * Translate the daemon's runtime task type string to the canonical
 * analytics wire value. The daemon still dispatches the pre-ENG-2925
 * name `'curate-html-direct'`; analytics emits the post-rename
 * `'curate-tool-mode'`. Once the rename PR lands, the alias becomes
 * dead code and can be inlined.
 *
 * Drift guard (PR #722 review re-review): if the daemon dispatches a
 * type that isn't enumerated in `TASK_TYPE_VALUES`, fall back to
 * `TaskTypes.UNKNOWN` (which is in the wire vocabulary, so the backend
 * accepts the row) and log a daemon-side breadcrumb. The previous
 * implementation cast a non-enumerated string back to `TaskType`,
 * which silently failed the backend Zod check.
 */
function toAnalyticsTaskType(daemonType: string): TaskType {
  if (daemonType === 'curate-html-direct') return TaskTypes.CURATE_TOOL_MODE
  if (isCanonicalTaskType(daemonType)) return daemonType
  processLog(`AnalyticsHook: unknown task type '${daemonType}' — falling back to '${TaskTypes.UNKNOWN}'`)
  return TaskTypes.UNKNOWN
}

/**
 * M15.8 — map a daemon task type to its MCP tool name. Returns undefined
 * for any task that is not an MCP tool-mode flavor; callers gate emit on
 * the returned value being defined.
 */
function mcpToolNameForTaskType(daemonType: string): 'brv-curate' | 'brv-query' | undefined {
  if (daemonType === TaskTypes.QUERY_TOOL_MODE) return 'brv-query'
  if (daemonType === TaskTypes.CURATE_TOOL_MODE) return 'brv-curate'
  return undefined
}

/**
 * Stable sentinel for paths that can't be safely emitted as project-
 * relative — either outside the project root or the project root itself
 * is unknown. The backend can group these without leaking host layout.
 */
const OUTSIDE_PROJECT_PATH = '<outside-project>'

/**
 * Convert an absolute filesystem path to a project-relative path for the
 * analytics wire. Keeps emits free of `/Users/{name}` PII while still
 * letting PMs reason about which file inside a project an operation touched.
 *
 * PR #722 review: `path.relative('/proj', '/Users/dev/other/x.md')` yields
 * `'../../Users/dev/other/x.md'` — still encodes the host layout. When the
 * relative path escapes the project root (or projectPath is unset), surface
 * a stable sentinel + basename rather than the raw absolute path. The
 * sentinel preserves enough signal for backend grouping without becoming
 * PII.
 */
function toRelativePath(filePath: string, projectPath?: string): string {
  if (!projectPath) return `${OUTSIDE_PROJECT_PATH}/${basename(filePath)}`
  const rel = relativePath(projectPath, filePath)
  // `path.relative` returns '' when paths are identical — defensively
  // surface a leaf token rather than emit a zero-length wire string that
  // would fail `z.string().min(1)`.
  if (rel === '') return '.'
  // Anything that escapes the project root (`../foo`) or stays absolute
  // (Windows drive letter switches) is treated as outside-project.
  if (rel.startsWith('..') || isAbsolutePath(rel)) {
    return `${OUTSIDE_PROJECT_PATH}/${basename(filePath)}`
  }

  return rel
}

/**
 * Classify a daemon-side error message into a coarse failure_kind tag.
 *
 * Precedence (PR #722 review — pinned so the if-order can't silently rebucket
 * the funnel later): `timeout` > `agent_error` > `unknown`. A message
 * containing both `'timeout'` and `'agent'` classifies as `'timeout'`.
 *
 * Word-boundary matching keeps unrelated tokens (`'tooltip'`, `'engagement'`,
 * `'urgent'`) from bumping into the `agent_error` bucket. The raw message
 * NEVER ends up on the analytics wire — only the canonical tag.
 */
const TIMEOUT_PATTERN = /\b(timeout|timed out|deadline exceeded)\b/
const AGENT_ERROR_PATTERN = /\b(agent|llm|provider|tool)\b/
function classifyFailureKind(errorMessage: string): FailureKind {
  const m = errorMessage.toLowerCase()
  if (TIMEOUT_PATTERN.test(m)) return 'timeout'
  if (AGENT_ERROR_PATTERN.test(m)) return 'agent_error'
  return 'unknown'
}

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
 * M17 follow-up: project-scoped join key for the task / curate / query
 * funnel events. Mirrors the convention every other handler-emitted
 * event uses (vc-*, review-*, source-*, worktree-*, brv-init,
 * context-tree-file-edited, webui-session-*). Returns `{}` when the
 * project path is unset so the spread omits the field — schemas declare
 * `project_path_hash` as optional for that reason.
 */
function projectPathHashOptional(projectPath: string | undefined): {project_path_hash?: string} {
  if (typeof projectPath !== 'string' || projectPath.length === 0) return {}
  return {project_path_hash: hashProjectPath(projectPath)}
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
  /** Captured at onTaskCreate so onToolResult emits can relativize op.filePath. */
  projectPath?: string
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
/**
 * Bundle of project-scoped identity fields stamped on terminal emits.
 * Each field is independently optional — a project may have a teamId
 * without a spaceId (mid-onboarding) or neither (standalone).
 */
type ProjectIdentity = {
  spaceId?: string
  teamId?: string
}

type AnalyticsHookDeps = {
  /**
   * Look up the Context Hub identity (space_id + team_id) for `projectPath`
   * at emit time. Returns `{}` when the project is unconnected, the lookup
   * fails, or the daemon couldn't resolve a project path — missing identity
   * fields NEVER block an emit. Production wires through
   * `projectStateLoader.getProjectConfig` in `brv-server.ts`; tests default
   * to a no-op that always returns `{}`.
   *
   * Bundled (instead of one accessor per field) so a single config read
   * serves both stamps at terminal time.
   */
  getIdentity?: (projectPath: string | undefined) => Promise<ProjectIdentity>
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
  private readonly getIdentity: (projectPath: string | undefined) => Promise<ProjectIdentity>
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
    this.getIdentity = deps.getIdentity ?? (async (): Promise<ProjectIdentity> => ({}))
    this.isEnabled = deps.isEnabled ?? (() => true)
    this.readFile = deps.readFile ?? readFileAsync
  }

  cleanup(taskId: string): void {
    this.tasks.delete(taskId)
    this.pendingByTask.delete(taskId)
  }

  async onTaskCancelled(taskId: string, task: TaskInfo): Promise<void> {
    await this.dispatchTerminal(taskId, task, 'cancelled')
    this.emitTaskFailed(taskId, task, 'cancelled')
    // M15.8 — surface MCP cancellation in the dedicated funnel. The schema
    // has only `success: boolean`; user-cancel is a not-completed call, so
    // it shares the failure bucket with onTaskError. Without this emit the
    // MCP funnel would under-count by the cancellation rate.
    this.emitMcpToolCalled(task, false)
  }

  async onTaskCompleted(taskId: string, _result: string, task: TaskInfo): Promise<void> {
    const state = this.tasks.get(taskId)
    if (state) {
      // Drain any in-flight per-op processing so CURATE_OPERATION_APPLIED emits
      // land BEFORE the run-completion emit on the wire. The chain never
      // rejects (see `onToolResult`), so this await is safe.
      await this.pendingByTask.get(taskId)

      if (state.flavor === 'curate') {
        const outcome = state.counters.failed > 0 ? 'partial' : 'completed'
        const identity = await this.resolveIdentity(task.projectPath ?? state.projectPath)
        this.emit(
          AnalyticsEventNames.CURATE_RUN_COMPLETED,
          this.buildCurateRunPayload({identity, outcome, state, task, taskId}),
        )
      } else {
        const identity = await this.resolveIdentity(task.projectPath)
        this.emit(
          AnalyticsEventNames.QUERY_COMPLETED,
          await this.buildQueryCompletedPayload({identity, outcome: 'completed', state, task, taskId}),
        )
      }
    }


    // M14.3 generic funnel emit. Fires for EVERY task type AFTER any
    // per-flavor M12 emit (terminal-event-last convention).
    this.emit(AnalyticsEventNames.TASK_COMPLETED, {
      duration_ms: this.durationMs(task),
      ...projectPathHashOptional(task.projectPath),
      task_id: taskId,
      task_type: toAnalyticsTaskType(task.type),
    })

    // M15.8 — dedicated MCP funnel emit. Fires alongside (not instead of)
    // TASK_COMPLETED; MCP volume is low so the dual-event cost is accepted.
    this.emitMcpToolCalled(task, true)
  }

  async onTaskCreate(task: TaskInfo): Promise<void> {
    // M14.3 generic funnel-entry emit. Fires for EVERY task type BEFORE
    // the M12 per-flavor state init so the entry event lands even if
    // state setup throws downstream.
    this.emit(AnalyticsEventNames.TASK_CREATED, {
      has_files: (task.files?.length ?? 0) > 0,
      has_folder: typeof task.folderPath === 'string' && task.folderPath.length > 0,
      ...projectPathHashOptional(task.projectPath),
      task_id: task.taskId,
      task_type: toAnalyticsTaskType(task.type),
    })

    if (isCurateLiteral(task.type)) {
      this.tasks.set(task.taskId, {
        counters: {added: 0, deleted: 0, failed: 0, merged: 0, pendingReview: 0, updated: 0},
        flavor: 'curate',
        projectPath: task.projectPath,
        taskType: task.type,
      })
      return
    }

    if (QUERY_TASK_TYPES.has(task.type)) {
      this.tasks.set(task.taskId, {flavor: 'query'})
    }
  }

  async onTaskError(taskId: string, errorMessage: string, task: TaskInfo): Promise<void> {
    await this.dispatchTerminal(taskId, task, 'error')
    this.emitTaskFailed(taskId, task, classifyFailureKind(errorMessage))
    // M15.8 — surface MCP failure path in the dedicated funnel.
    this.emitMcpToolCalled(task, false)
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
    identity,
    outcome,
    state,
    task,
    taskId,
  }: {
    identity: ProjectIdentity
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
      ...projectPathHashOptional(task.projectPath ?? state.projectPath),
      ...(identity.spaceId === undefined ? {} : {space_id: identity.spaceId}),
      task_id: taskId,
      task_type: toAnalyticsTaskType(state.taskType),
      ...(identity.teamId === undefined ? {} : {team_id: identity.teamId}),
    }
  }

  private async buildQueryCompletedPayload({
    identity,
    outcome,
    state,
    task,
    taskId,
  }: {
    identity: ProjectIdentity
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
    // carry empty keywords / tags / related_paths arrays — the wire shape
    // is uniform regardless of read success. `Promise.all` preserves
    // input-array order in the result regardless of which read settles first.
    const readPathsWithMetadata = await Promise.all(
      cappedPaths.map(async (p) => {
        const fm = await this.readFrontmatterFields(p)
        return {
          keywords: fm.keywords ?? [],
          // M14 review tightening: each related entry is structured so a
          // later FU can populate the linked file's own keywords/tags
          // without changing the wire shape.
          related_paths: (fm.related ?? []).map((r) => ({
            keywords: [],
            relative_path: r,
            tags: [],
          })),
          relative_path: toRelativePath(p, task.projectPath),
          tags: fm.tags ?? [],
        }
      }),
    )

    return {
      cache_hit: tier === 0 || tier === 1,
      duration_ms: this.durationMs(task),
      matched_doc_count: matchedDocCount,
      outcome,
      ...projectPathHashOptional(task.projectPath),
      read_doc_count: readPaths.size,
      // M12.1 schema marks read_paths_with_metadata as optional outer array.
      // Mirror that: omit the field when the command had no read paths
      // (instead of emitting an empty array). Same idiom as `tier` above.
      ...(readPathsWithMetadata.length > 0 ? {read_paths_with_metadata: readPathsWithMetadata} : {}),
      read_tool_call_count: readToolCallCount,
      search_call_count: searchCallCount,
      ...(identity.spaceId === undefined ? {} : {space_id: identity.spaceId}),
      task_id: taskId,
      task_type: toAnalyticsTaskType(task.type),
      ...(identity.teamId === undefined ? {} : {team_id: identity.teamId}),
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
      const identity = await this.resolveIdentity(task.projectPath ?? state.projectPath)
      this.emit(
        AnalyticsEventNames.CURATE_RUN_COMPLETED,
        this.buildCurateRunPayload({identity, outcome, state, task, taskId}),
      )
    } else {
      const identity = await this.resolveIdentity(task.projectPath)
      this.emit(
        AnalyticsEventNames.QUERY_COMPLETED,
        await this.buildQueryCompletedPayload({identity, outcome, state, task, taskId}),
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

  /**
   * M15.8 — emit `mcp_tool_called` for MCP-originated tool-mode tasks.
   * Gated on `clientType === 'mcp'` AND task type being a tool-mode flavor.
   * Falls back to `'unknown'` when the MCP handshake had not delivered a
   * client name by `handleTaskCreate` time (rare race; section 3 of M15.8
   * guarantees the name in steady-state).
   */
  private emitMcpToolCalled(task: TaskInfo, success: boolean): void {
    if (task.clientType !== 'mcp') return
    const toolName = mcpToolNameForTaskType(task.type)
    if (toolName === undefined) return

    this.emit(AnalyticsEventNames.MCP_TOOL_CALLED, {
      client_name: task.clientName ?? 'unknown',
      duration_ms: this.durationMs(task),
      success,
      tool_name: toolName,
    })
  }

  /**
   * M14.3 generic terminal-failure emit. Fired by both onTaskError and
   * onTaskCancelled AFTER dispatchTerminal so M12 per-flavor failure
   * emits land first on the wire. Cancellation maps to task_failed
   * (not a distinct event) per the schema's docblock.
   *
   * M15.6: failure_kind is a coarse classifier passed by the caller —
   * 'cancelled' from onTaskCancelled, classified-from-errorMessage from
   * onTaskError (see classifyFailureKind). Raw error.message MUST NOT
   * leak into the emit; only the canonical FailureKind tag does.
   */
  private emitTaskFailed(taskId: string, task: TaskInfo, failureKind: FailureKind): void {
    this.emit(AnalyticsEventNames.TASK_FAILED, {
      duration_ms: this.durationMs(task),
      failure_kind: failureKind,
      ...projectPathHashOptional(task.projectPath),
      task_id: taskId,
      task_type: toAnalyticsTaskType(task.type),
    })
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
      // default to empty arrays when the read fails (ENOENT, EACCES,
      // malformed YAML) so the wire shape stays uniform.
      // eslint-disable-next-line no-await-in-loop -- emit order MUST match op order
      const frontmatter = op.type === 'DELETE' ? {} : await this.readFrontmatterFields(op.filePath)

      this.emit(AnalyticsEventNames.CURATE_OPERATION_APPLIED, {
        ...(op.confidence ? {confidence: op.confidence} : {}),
        ...(op.impact ? {impact: op.impact} : {}),
        keywords: frontmatter.keywords ?? [],
        knowledge_path: op.path,
        needs_review: op.needsReview ?? false,
        operation_type: op.type,
        ...projectPathHashOptional(state.projectPath),
        ...(frontmatter.related ? {related: frontmatter.related} : {}),
        relative_path: toRelativePath(op.filePath, state.projectPath),
        tags: frontmatter.tags ?? [],
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
      // M17 follow-up: HTML topic files (curate-tool-mode writes) carry the
      // frontmatter as attributes on `<bv-topic>`, NOT as YAML. parseFrontmatter
      // returns null for them. Branch on extension so both formats produce
      // the same FrontmatterFields shape downstream.
      if (filePath.toLowerCase().endsWith('.html')) {
        const htmlAttrs = readHtmlTopicSync(content).topicAttributes
        return {
          keywords: capStringArray(splitTopicAttrList(htmlAttrs.keywords)),
          related: capStringArray(splitTopicAttrList(htmlAttrs.related)),
          tags: capStringArray(splitTopicAttrList(htmlAttrs.tags)),
        }
      }

      const parsed = parseFrontmatter(content)
      if (parsed === null) return {}
      return {
        keywords: capStringArray(parsed.frontmatter.keywords),
        related: capStringArray(parsed.frontmatter.related),
        tags: capStringArray(parsed.frontmatter.tags),
      }
    } catch {
      // ENOENT, EACCES, permission, malformed YAML / HTML — all silently
      // treated as "no frontmatter". No retry, no log noise.
      return {}
    }
  }

  /**
   * Resolve the project identity (spaceId + teamId) without ever throwing —
   * a getIdentity rejection (config-load failure, projectStateLoader race,
   * etc.) MUST NOT take down the terminal emit. Empty strings normalize to
   * `undefined` per-field so the payload spread omits each independently.
   */
  private async resolveIdentity(projectPath: string | undefined): Promise<ProjectIdentity> {
    try {
      const raw = await this.getIdentity(projectPath)
      return {
        spaceId: typeof raw.spaceId === 'string' && raw.spaceId.length > 0 ? raw.spaceId : undefined,
        teamId: typeof raw.teamId === 'string' && raw.teamId.length > 0 ? raw.teamId : undefined,
      }
    } catch (error) {
      processLog(
        `AnalyticsHook: getIdentity failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return {}
    }
  }
}

/**
 * Split a `<bv-topic>` attribute value into a string array. The HTML writer
 * emits these as comma-separated lists (e.g. `tags="analytics, m17, tool-mode"`)
 * to mirror the YAML array semantics. Whitespace around each entry is
 * trimmed; empty entries are dropped so a trailing comma never produces
 * a zero-length tag.
 *
 * PR #728 review fix: HTML `related` refs carry a leading `@` marker (e.g.
 * `related="@analytics/x.html, @analytics/y.html"`) per the renderer
 * convention. The legacy YAML path stores them stripped — see
 * `related-ref-warner.ts:33`. Canonicalize here so the same wire field
 * (`curate_operation_applied.related` /
 * `query_completed.read_paths_with_metadata[].related_paths[].relative_path`)
 * doesn't carry two shapes across HTML and YAML sources.
 */
function splitTopicAttrList(value: string | undefined): string[] | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .map((part) => (part.startsWith('@') ? part.slice(1) : part))
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}
