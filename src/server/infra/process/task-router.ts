/**
 * TaskRouter - Routes task and LLM events between clients and agents.
 *
 * Handles:
 * - Task lifecycle: create → ack → started → completed/error/cancelled
 * - LLM event routing: llmservice:* events from agent → client + project room
 * - Grace period: keeps completed tasks briefly for late-arriving LLM events
 * - Lifecycle hooks: extensible observer hooks (e.g. CurateLogHandler)
 *
 * Broadcasting: Task/LLM events are broadcast to project-scoped rooms
 * (project:<sanitizedPath>:broadcast) so only clients in the same project
 * receive them. Global events (auth, agent connect/disconnect) remain on
 * the global broadcast channel.
 *
 * Consumed by TransportHandlers (orchestrator).
 */

import type {ReasoningContentItem, ToolCallEvent} from '../../../shared/transport/events/task-events.js'
import type {
  LlmChunkEvent,
  LlmErrorEvent,
  LlmResponseEvent,
  LlmThinkingEvent,
  LlmToolCallEvent,
  LlmToolResultEvent,
  LlmUnsupportedInputEvent,
  TaskCancelledEvent,
  TaskCancelRequest,
  TaskCancelResponse,
  TaskClearCompletedRequest,
  TaskClearCompletedResponse,
  TaskCompletedEvent,
  TaskCreateRequest,
  TaskCreateResponse,
  TaskDeleteBulkRequest,
  TaskDeleteBulkResponse,
  TaskDeleteRequest,
  TaskDeleteResponse,
  TaskErrorEvent,
  TaskExecute,
  TaskGetRequest,
  TaskGetResponse,
  TaskListItem,
  TaskListItemStatus,
  TaskListRequest,
  TaskListResponse,
  TaskStartedEvent,
} from '../../core/domain/transport/schemas.js'
import type {IAgentPool} from '../../core/interfaces/agent/i-agent-pool.js'
import type {ITaskLifecycleHook} from '../../core/interfaces/process/i-task-lifecycle-hook.js'
import type {IProjectRegistry} from '../../core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../core/interfaces/routing/i-project-router.js'
import type {ITaskHistoryStore} from '../../core/interfaces/storage/i-task-history-store.js'
import type {ITransportServer} from '../../core/interfaces/transport/i-transport-server.js'
import type {TaskInfo} from './types.js'

import {AgentNotAvailableError, serializeTaskError} from '../../core/domain/errors/task-error.js'
import {LlmEventNames, TransportLlmEventList, TransportTaskEventNames} from '../../core/domain/transport/schemas.js'
import {isDescendantOf} from '../../utils/path-utils.js'
import {transportLog} from '../../utils/process-logger.js'
import {isValidTaskType} from '../../utils/type-guards.js'
import {resolveProject} from '../project/resolve-project.js'
import {broadcastToProjectRoom} from './broadcast-utils.js'
import {TaskHeartbeatManager} from './task-heartbeat-manager.js'
import {buildTaskHistoryEntry} from './task-history-entry-builder.js'

type LlmEventName = (typeof TransportLlmEventList)[number]

type LlmEventPayloadMap = {
  [LlmEventNames.CHUNK]: LlmChunkEvent
  [LlmEventNames.ERROR]: LlmErrorEvent
  [LlmEventNames.RESPONSE]: LlmResponseEvent
  [LlmEventNames.THINKING]: LlmThinkingEvent
  [LlmEventNames.TOOL_CALL]: LlmToolCallEvent
  [LlmEventNames.TOOL_RESULT]: LlmToolResultEvent
  [LlmEventNames.UNSUPPORTED_INPUT]: LlmUnsupportedInputEvent
}

/**
 * Grace period (in ms) to keep completed tasks in memory for late-arriving events.
 * Prevents silent event drops when llmservice:* events arrive after task:completed.
 */
const TASK_CLEANUP_GRACE_PERIOD_MS = 5000

/** Default page size for `task:list` when caller omits `pageSize`. Schema caps at 1000. */
const DEFAULT_TASK_LIST_PAGE_SIZE = 50

/** Statuses considered terminal for delete refusal (M2.09). */
const TERMINAL_STATUSES: ReadonlySet<TaskListItemStatus> = new Set(['cancelled', 'completed', 'error'])

/**
 * Outcome of the daemon-side pre-dispatch check.
 *
 * `skipResult` is the full string sent to the client as the task:completed `result`.
 * The callback owns the message format so task-router stays task-type-agnostic
 * (e.g. dream uses "Dream skipped: <reason>"; future task types can use their own).
 */
export type PreDispatchCheckResult = {eligible: false; skipResult: string} | {eligible: true}

export type PreDispatchCheck = (task: TaskCreateRequest, projectPath?: string) => Promise<PreDispatchCheckResult>

/**
 * Resolves whether the review log is disabled for the given project. Called once
 * at task-create and the result is stamped onto TaskInfo + TaskExecute, so daemon
 * (CurateLogHandler) and agent (curate backups, dream review entries) observe a
 * single value across the daemon→agent process boundary. Errors → undefined →
 * downstream treats as enabled (fail-open).
 */
export type IsReviewDisabledResolver = (projectPath: string) => Promise<boolean>

type TaskRouterOptions = {
  agentPool?: IAgentPool
  /** Function to resolve agent clientId for a given project */
  getAgentForProject: (projectPath?: string) => string | undefined
  /**
   * Per-project `ITaskHistoryStore` factory (DIP). When omitted, the new
   * persistent-history handlers (`task:list` paginated, `task:get`,
   * `task:delete*`, `task:clearCompleted`) gracefully degrade to in-memory
   * only — keeping pre-M2.09 unit tests unaffected.
   */
  getTaskHistoryStore?: (projectPath: string) => ITaskHistoryStore
  /**
   * Optional daemon-side liveness manager. When provided, the router
   * registers each task on `task:started`, resets the timer on every
   * task-scoped emission, and clears it on the three terminal events.
   * The manager fires `TaskEvents.HEARTBEAT` during quiet periods so
   * the CLI can detect a stuck daemon without a wall-clock timer.
   */
  heartbeatManager?: TaskHeartbeatManager
  /** Resolves project's review-disabled flag at task-create. Optional; missing → undefined → enabled. */
  isReviewDisabled?: IsReviewDisabledResolver
  /** Lifecycle hooks for task events (e.g. CurateLogHandler). */
  lifecycleHooks?: ITaskLifecycleHook[]
  /**
   * Optional daemon-side gate run before dispatching to the agent pool. If it
   * resolves ineligible, task-router short-circuits with task:completed carrying
   * the skip reason and never submits the task to an agent.
   * Used for dream task type to enforce gates 1-3 (time, activity, queue) even
   * on the CLI dispatch path — mirrors the idle-trigger pre-check pattern.
   */
  preDispatchCheck?: PreDispatchCheck
  projectRegistry?: IProjectRegistry
  projectRouter?: IProjectRouter
  /**
   * Resolves the active provider/model snapshot at task-create time.
   * Failures are swallowed (fail-open) so dispatch is never blocked.
   */
  resolveActiveProvider?: () => Promise<{model?: string; provider?: string}>
  /** Resolves the projectPath a client registered with (from client:register). */
  resolveClientProjectPath?: (clientId: string) => string | undefined
  transport: ITransportServer
}

function hasTaskId(data: unknown): data is {[key: string]: unknown; taskId: string} {
  return typeof data === 'object' && data !== null && 'taskId' in data && typeof data.taskId === 'string'
}

/** Type guard for a plain JSON object — replaces ad-hoc `as Record<string, unknown>` casts. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Bounded-concurrency map for async I/O (M2.16 pass-2 lazy crack of data files).
 * Keeps file-descriptor usage well under macOS default soft limit (256).
 * No external dep (`p-limit` is not installed); ~10 lines hand-roll.
 */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R | undefined>,
): Promise<(R | undefined)[]> {
  const results: (R | undefined)[] = Array.from({length: items.length})
  let nextIdx = 0
  const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (true) {
      const i = nextIdx++
      if (i >= items.length) return
      // eslint-disable-next-line no-await-in-loop -- bounded worker pool; awaiting in sequence inside each worker is the point
      results[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return results
}

/** Concurrency cap for pass-2 lazy crack — keeps FD usage minimal. */
const FULL_TEXT_CONCURRENCY = 16

/** Build a clamped, well-typed empty response (M2.16). */
function emptyTaskListResponse(data: TaskListRequest): TaskListResponse {
  const pageSize = Math.min(Math.max(data.pageSize ?? DEFAULT_TASK_LIST_PAGE_SIZE, 1), 1000)
  const page = Math.max(data.page ?? 1, 1)
  return {
    availableModels: [],
    availableProviders: [],
    counts: {all: 0, cancelled: 0, completed: 0, failed: 0, running: 0},
    page,
    pageCount: 1,
    pageSize,
    tasks: [],
    total: 0,
  }
}

/**
 * Filter dimensions evaluated on a `TaskListItem` (M2.16).
 * AND-combined; empty arrays treated as "no filter" to match store `?.length` semantics.
 *
 * Search Pass-1 (`searchText`) checks `content + error.message` here. Pass-2
 * (full `result` lazy crack) runs separately in `handleTaskList` and is NOT
 * evaluated here — see that handler for the 2-pass flow.
 */
type ListFilterArgs = {
  createdAfter?: number
  createdBefore?: number
  maxDurationMs?: number
  minDurationMs?: number
  modelFilter?: string[]
  projectFilter: string
  providerFilter?: string[]
  searchText?: string
  statusFilter?: TaskListItemStatus[]
  typeFilter?: string[]
}

function matchesListFilters(item: TaskListItem, filters: ListFilterArgs): boolean {
  const taskProject = item.projectPath
  if (taskProject !== undefined && taskProject !== filters.projectFilter) return false

  if (filters.statusFilter && filters.statusFilter.length > 0 && !filters.statusFilter.includes(item.status)) {
    return false
  }

  if (filters.typeFilter && filters.typeFilter.length > 0 && !filters.typeFilter.includes(item.type)) {
    return false
  }

  if (
    filters.providerFilter &&
    filters.providerFilter.length > 0 &&
    (item.provider === undefined || !filters.providerFilter.includes(item.provider))
  )
    return false

  if (
    filters.modelFilter &&
    filters.modelFilter.length > 0 &&
    (item.model === undefined || !filters.modelFilter.includes(item.model))
  )
    return false

  if (filters.createdAfter !== undefined && item.createdAt < filters.createdAfter) return false
  if (filters.createdBefore !== undefined && item.createdAt > filters.createdBefore) return false

  if (filters.minDurationMs !== undefined || filters.maxDurationMs !== undefined) {
    if (item.startedAt === undefined || item.completedAt === undefined) return false
    const dur = item.completedAt - item.startedAt
    if (filters.minDurationMs !== undefined && dur < filters.minDurationMs) return false
    if (filters.maxDurationMs !== undefined && dur > filters.maxDurationMs) return false
  }

  if (filters.searchText !== undefined && filters.searchText.length > 0) {
    const haystack = (item.content + '\n' + (item.error?.message ?? '')).toLowerCase()
    if (!haystack.includes(filters.searchText.toLowerCase())) return false
  }

  return true
}

// `synthesizeEntryFromTaskInfo` was extracted to `task-history-entry-builder.ts`
// alongside `TaskHistoryHook`'s identical code path. Both consumers now import
// the same builder, so the two no longer drift.

function toListItem(task: TaskInfo): TaskListItem {
  const status: TaskListItemStatus =
    task.status ?? (task.completedAt ? 'completed' : task.startedAt ? 'started' : 'created')
  return {
    ...(task.completedAt ? {completedAt: task.completedAt} : {}),
    content: task.content,
    createdAt: task.createdAt,
    ...(task.error ? {error: task.error} : {}),
    ...(task.files && task.files.length > 0 ? {files: task.files} : {}),
    ...(task.folderPath ? {folderPath: task.folderPath} : {}),
    ...(task.model ? {model: task.model} : {}),
    ...(task.projectPath ? {projectPath: task.projectPath} : {}),
    ...(task.provider ? {provider: task.provider} : {}),
    ...(task.result ? {result: task.result} : {}),
    ...(task.startedAt ? {startedAt: task.startedAt} : {}),
    status,
    taskId: task.taskId,
    type: task.type,
  }
}

export class TaskRouter {
  /**
   * Throttle window for `onTaskUpdate` flushes — bursts of llmservice events
   * are coalesced into one save per window. 100ms keeps perceived latency low
   * while bounding write volume on chatty multi-step agents.
   */
  private static readonly FLUSH_INTERVAL_MS = 100
  private readonly agentPool: IAgentPool | undefined
  /**
   * Track recently completed tasks for grace period.
   * Allows late-arriving llmservice:* events to be routed even after task:completed.
   */
  private completedTasks: Map<string, {completedAt: number; task: TaskInfo}> = new Map()
  /** TaskIds with pending in-flight mutations awaiting the next throttled flush. */
  private readonly dirtyTaskIds: Set<string> = new Set()
  /** Pending throttle timer, if any. */
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private readonly getAgentForProject: (projectPath?: string) => string | undefined
  private readonly getTaskHistoryStore: TaskRouterOptions['getTaskHistoryStore']
  private readonly heartbeatManager: TaskHeartbeatManager | undefined
  private readonly isReviewDisabled: IsReviewDisabledResolver | undefined
  private readonly lifecycleHooks: ITaskLifecycleHook[]
  private readonly preDispatchCheck: TaskRouterOptions['preDispatchCheck']
  private readonly projectRegistry: IProjectRegistry | undefined
  private readonly projectRouter: IProjectRouter | undefined
  private readonly resolveActiveProvider: TaskRouterOptions['resolveActiveProvider']
  private readonly resolveClientProjectPath: ((clientId: string) => string | undefined) | undefined
  /** Track active tasks */
  private tasks: Map<string, TaskInfo> = new Map()
  private readonly transport: ITransportServer

  constructor(options: TaskRouterOptions) {
    this.transport = options.transport
    this.agentPool = options.agentPool
    this.getAgentForProject = options.getAgentForProject
    this.getTaskHistoryStore = options.getTaskHistoryStore
    this.heartbeatManager = options.heartbeatManager
    this.isReviewDisabled = options.isReviewDisabled
    this.lifecycleHooks = options.lifecycleHooks ?? []
    this.preDispatchCheck = options.preDispatchCheck
    this.projectRegistry = options.projectRegistry
    this.projectRouter = options.projectRouter
    this.resolveActiveProvider = options.resolveActiveProvider
    this.resolveClientProjectPath = options.resolveClientProjectPath
  }

  clearTasks(): void {
    this.tasks.clear()
    this.completedTasks.clear()
    this.dirtyTaskIds.clear()
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
  }

  /**
   * Remove a task from tracking and send error to its client.
   * Used by ConnectionCoordinator when an agent disconnects.
   */
  failTask(taskId: string, error: {code?: string; message: string; name: string}): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    this.transport.sendTo(task.clientId, TransportTaskEventNames.ERROR, {error, taskId})
    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      task.projectPath,
      TransportTaskEventNames.ERROR,
      {error, taskId},
      task.clientId,
    )
    this.tasks.delete(taskId)

    // Notify hooks (fire-and-forget)
    this.notifyHooksError(taskId, error.message, task).catch(() => {})

    this.heartbeatManager?.recordTermination(taskId)
  }

  getDebugState(): {
    activeTasks: Array<{clientId: string; createdAt: number; projectPath?: string; taskId: string; type: string}>
    completedTasks: Array<{completedAt: number; projectPath?: string; taskId: string; type: string}>
  } {
    return {
      activeTasks: [...this.tasks.values()].map((t) => ({
        clientId: t.clientId,
        createdAt: t.createdAt,
        projectPath: t.projectPath,
        taskId: t.taskId,
        type: t.type,
      })),
      completedTasks: [...this.completedTasks.entries()].map(([taskId, entry]) => ({
        completedAt: entry.completedAt,
        projectPath: entry.task.projectPath,
        taskId,
        type: entry.task.type,
      })),
    }
  }

  /**
   * Returns all active tasks for a given project path.
   * Used by ConnectionCoordinator to fail tasks on agent disconnect.
   */
  getTasksForProject(projectPath?: string): TaskInfo[] {
    const result: TaskInfo[] = []
    for (const task of this.tasks.values()) {
      if (projectPath === undefined) {
        // No projectPath specified — only match tasks without a project
        if (task.projectPath === undefined) {
          result.push(task)
        }
      } else if (task.projectPath === projectPath || task.projectPath === undefined) {
        // Specific project — match tasks for that project or unassigned tasks
        result.push(task)
      }
    }

    return result
  }

  /**
   * Register all task and LLM event handlers on the transport.
   */
  setup(): void {
    // Task creation from clients
    this.transport.onRequest<TaskCreateRequest, TaskCreateResponse>(TransportTaskEventNames.CREATE, (data, clientId) =>
      this.handleTaskCreate(data, clientId),
    )

    // Task cancellation from clients
    this.transport.onRequest<TaskCancelRequest, TaskCancelResponse>(TransportTaskEventNames.CANCEL, (data, clientId) =>
      this.handleTaskCancel(data, clientId),
    )

    // Snapshot query from clients (e.g. web UI Tasks tab)
    this.transport.onRequest<TaskListRequest, TaskListResponse>(TransportTaskEventNames.LIST, (data, clientId) =>
      this.handleTaskList(data, clientId),
    )

    // M2.09 — persistent-history handlers
    this.transport.onRequest<TaskGetRequest, TaskGetResponse>(TransportTaskEventNames.GET, (data, clientId) =>
      this.handleTaskGet(data, clientId),
    )
    this.transport.onRequest<TaskDeleteRequest, TaskDeleteResponse>(TransportTaskEventNames.DELETE, (data, clientId) =>
      this.handleTaskDelete(data, clientId),
    )
    this.transport.onRequest<TaskDeleteBulkRequest, TaskDeleteBulkResponse>(
      TransportTaskEventNames.DELETE_BULK,
      (data, clientId) => this.handleTaskDeleteBulk(data, clientId),
    )
    this.transport.onRequest<TaskClearCompletedRequest, TaskClearCompletedResponse>(
      TransportTaskEventNames.CLEAR_COMPLETED,
      (data, clientId) => this.handleTaskClearCompleted(data, clientId),
    )

    // Task lifecycle events from agent
    this.transport.onRequest<TaskStartedEvent, void>(TransportTaskEventNames.STARTED, (data) => {
      this.handleTaskStarted(data)
    })

    this.transport.onRequest<TaskCompletedEvent, void>(TransportTaskEventNames.COMPLETED, (data) => {
      this.handleTaskCompleted(data)
    })

    this.transport.onRequest<TaskErrorEvent, void>(TransportTaskEventNames.ERROR, (data) => {
      this.handleTaskError(data)
    })

    this.transport.onRequest<TaskCancelledEvent, void>(TransportTaskEventNames.CANCELLED, (data) => {
      this.handleTaskCancelled(data)
    })

    // LLM events
    for (const eventName of TransportLlmEventList) {
      this.registerLlmEvent(eventName)
    }
  }

  /**
   * Mutate the live `TaskInfo` from an `llmservice:*` event so a tab refresh
   * during the throttle window sees the in-flight state. Each branch:
   *   - thinking: push a `{isThinking: true, content: ''}` marker
   *   - chunk(reasoning): append to last item / flip empty marker / push fresh
   *   - chunk(text): IGNORED for persistence (transient stream)
   *   - response: set responseContent + sessionId (overwrite — multi-step keeps latest)
   *   - toolCall: push running entry
   *   - toolResult: update existing entry by callId
   *   - error / unsupportedInput: IGNORED (terminal hooks capture failure)
   *
   * Mutations use immutable `tasks.set(id, {...task, ...delta})` so consumers
   * holding a captured reference (e.g. notifyHooks*) see a stable snapshot.
   */
  private accumulateLlmEvent(taskId: string, eventName: string, data: {[key: string]: unknown}): void {
    const task = this.tasks.get(taskId)
    if (!task) return

    switch (eventName) {
      case LlmEventNames.CHUNK: {
        if (data.type !== 'reasoning') return // 'text' is transient — ignore
        const content = typeof data.content === 'string' ? data.content : ''
        const items = task.reasoningContents ?? []
        const last = items.at(-1)
        let nextItems: ReasoningContentItem[]
        if (last === undefined) {
          // Case C: empty array — push fresh body entry.
          nextItems = [{content, isThinking: false, timestamp: Date.now()}]
        } else if (last.isThinking === true && (last.content ?? '') === '') {
          // Case A: flip the empty isThinking marker to body.
          nextItems = [...items.slice(0, -1), {...last, content, isThinking: false}]
        } else {
          // Case B: append to existing body.
          nextItems = [...items.slice(0, -1), {...last, content: (last.content ?? '') + content}]
        }

        this.tasks.set(taskId, {...task, reasoningContents: nextItems})
        this.markDirty(taskId)
        return
      }

      case LlmEventNames.RESPONSE: {
        const content = typeof data.content === 'string' ? data.content : ''
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : task.sessionId
        this.tasks.set(taskId, {
          ...task,
          responseContent: content,
          ...(sessionId === undefined ? {} : {sessionId}),
        })
        this.markDirty(taskId)
        return
      }

      case LlmEventNames.THINKING: {
        // Dedup parity with the TUI store (`tasks-store.ts:127`): if the last
        // reasoning item is already a THINKING marker, skip — the model is
        // about to stream more reasoning content that will be appended to it.
        // Without this, repeated THINKING events from the provider produce
        // multiple empty `{isThinking: true, content: ''}` items in persisted
        // entries, which the live UI never showed.
        const items = task.reasoningContents ?? []
        const last = items.at(-1)
        if (last?.isThinking === true) return
        const nextItems: ReasoningContentItem[] = [...items, {content: '', isThinking: true, timestamp: Date.now()}]
        this.tasks.set(taskId, {...task, reasoningContents: nextItems})
        this.markDirty(taskId)
        return
      }

      case LlmEventNames.TOOL_CALL: {
        const args = isRecord(data.args) ? data.args : {}
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        const sessionId = typeof data.sessionId === 'string' ? data.sessionId : ''
        const toolName = typeof data.toolName === 'string' ? data.toolName : ''
        const newCall: ToolCallEvent = {
          args,
          ...(callId === undefined ? {} : {callId}),
          sessionId,
          status: 'running',
          timestamp: Date.now(),
          toolName,
        }
        this.tasks.set(taskId, {
          ...task,
          toolCalls: [...(task.toolCalls ?? []), newCall],
        })
        this.markDirty(taskId)
        return
      }

      case LlmEventNames.TOOL_RESULT: {
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        if (callId === undefined) return
        const items = task.toolCalls ?? []
        const idx = items.findIndex((c) => c.callId === callId)
        if (idx === -1) return
        const success = data.success !== false
        const updated: ToolCallEvent = {
          ...items[idx],
          ...(typeof data.error === 'string' ? {error: data.error} : {}),
          ...(typeof data.errorType === 'string' ? {errorType: data.errorType} : {}),
          ...(data.result === undefined ? {} : {result: data.result}),
          status: success ? 'completed' : 'error',
        }
        const nextCalls = [...items.slice(0, idx), updated, ...items.slice(idx + 1)]
        this.tasks.set(taskId, {...task, toolCalls: nextCalls})
        this.markDirty(taskId)
        break
      }

      // ERROR + UNSUPPORTED_INPUT: ignored — terminal lifecycle hook captures failure.
      default:
      // No mutation; fall through.
    }
  }

  /**
   * Emit `task:deleted` to the project room when a task is removed. Skips
   * silently when no projectPath is resolvable (broadcast wouldn't reach
   * any room). Clients that miss the broadcast will simply not see a row
   * disappear; they reconcile on next `task:list`.
   */
  private broadcastTaskDeleted(projectPath: string | undefined, taskId: string): void {
    if (projectPath === undefined) return
    broadcastToProjectRoom(this.projectRegistry, this.projectRouter, projectPath, TransportTaskEventNames.DELETED, {
      taskId,
    })
  }

  private cancelTaskLocally(task: TaskInfo, taskId: string): void {
    this.transport.sendTo(task.clientId, TransportTaskEventNames.CANCELLED, {taskId})
    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      task.projectPath,
      TransportTaskEventNames.CANCELLED,
      {taskId},
      task.clientId,
    )
    // Stamp status='cancelled' before moveToCompleted so the in-memory
    // completedTasks cache stores a 'cancelled' entry — the fast-path
    // idempotency check at handleTaskCancel reads `prior?.task.status`.
    // Without this, sequential retries (queued-cancel + no-agent-cancel
    // paths) would skip the in-memory cache entirely and have to win a
    // race against the fire-and-forget notifyHooksCancelled before the
    // durable history-store lookup could see the persisted status.
    this.tasks.set(taskId, {...task, completedAt: Date.now(), status: 'cancelled'})
    this.moveToCompleted(taskId)
    this.notifyHooksCancelled(taskId, task).catch(() => {})
  }

  /**
   * Drain the dirty set: for each taskId still active, fire `onTaskUpdate` on
   * each lifecycle hook. Tasks moved to `completedTasks` between markDirty
   * and flush are skipped — their terminal lifecycle hook already saved.
   */
  private async flushDirty(): Promise<void> {
    this.flushTimer = undefined
    if (this.dirtyTaskIds.size === 0) return

    const ids = [...this.dirtyTaskIds]
    this.dirtyTaskIds.clear()

    for (const taskId of ids) {
      const task = this.tasks.get(taskId)
      if (!task) continue
      for (const hook of this.lifecycleHooks) {
        try {
          // eslint-disable-next-line no-await-in-loop -- sequential hook calls by design
          await hook.onTaskUpdate?.(task)
        } catch (error) {
          transportLog(
            `LifecycleHook.onTaskUpdate error for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  private async handleTaskCancel(data: TaskCancelRequest, clientId: string): Promise<TaskCancelResponse> {
    const {taskId} = data

    transportLog(`Task cancel requested: ${taskId}`)

    const task = this.tasks.get(taskId)
    if (!task) {
      // Idempotency — fast path: if the task already reached status:
      // 'cancelled' on a prior cancel, the in-memory completedTasks entry
      // (within TASK_CLEANUP_GRACE_PERIOD_MS) lets us short-circuit without
      // a disk read.
      const prior = this.completedTasks.get(taskId)
      if (prior?.task.status === 'cancelled') {
        return {success: true}
      }

      // Idempotency — durable path: completedTasks is a cache and ages out
      // after the cleanup grace period. The persistent task history store,
      // populated by TaskHistoryHook.onTaskCancelled, is the long-lived
      // source of truth. Consulting it lets late retries (and retries
      // across daemon restarts) still report success rather than a
      // misleading "Task not found".
      if (this.getTaskHistoryStore !== undefined) {
        const projectPath = this.resolveClientProjectPath?.(clientId)
        if (projectPath !== undefined) {
          try {
            const store = this.getTaskHistoryStore(projectPath)
            const entry = await store.getById(taskId)
            if (entry?.status === 'cancelled') {
              return {success: true}
            }
          } catch (error) {
            transportLog(
              `handleTaskCancel: history-store lookup failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
      }

      return {error: 'Task not found', success: false}
    }

    // Queue-first: a task that has not been dispatched to an agent still lives
    // in the pool's per-project FIFO. Removing it there avoids forwarding a
    // cancel to an agent that holds no controller for the task. The daemon
    // emits the terminal event itself and runs lifecycle hooks so history
    // reflects status: 'cancelled' on this path too.
    if (this.agentPool?.cancelQueuedTask(taskId)) {
      transportLog(`Cancelled queued task: ${taskId}`)
      this.cancelTaskLocally(task, taskId)
      return {success: true}
    }

    // If Agent connected for this task's project, forward cancel request.
    // NOTE: `success: true` here means "queued for forward", NOT "agent
    // confirmed cancellation". The agent may have already finished the task
    // (race window between daemon dispatch and agent terminal event), in
    // which case agent-cancel-listener returns false and emits no
    // task:cancelled. Callers must rely on the terminal event broadcast,
    // not this success flag, to know the final task state. See JSDoc on
    // TaskCancelResponse for full semantics.
    const agentId = this.getAgentForProject(task.projectPath)
    if (agentId) {
      this.transport.sendTo(agentId, TransportTaskEventNames.CANCEL, {taskId})
      return {success: true}
    }

    // No Agent - cancel task locally and emit terminal event
    transportLog(`No Agent connected, cancelling task locally: ${taskId}`)
    this.cancelTaskLocally(task, taskId)

    this.heartbeatManager?.recordTermination(taskId)
    return {success: true}
  }

  private handleTaskCancelled(data: TaskCancelledEvent): void {
    const {taskId} = data
    const existing = this.tasks.get(taskId)
    if (existing) {
      this.tasks.set(taskId, {...existing, completedAt: Date.now(), status: 'cancelled'})
    }

    const task = this.tasks.get(taskId)

    transportLog(`Task cancelled: ${taskId}`)

    if (task) {
      this.transport.sendTo(task.clientId, TransportTaskEventNames.CANCELLED, {taskId})
    }

    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      task?.projectPath,
      TransportTaskEventNames.CANCELLED,
      {taskId},
      task?.clientId,
    )
    this.moveToCompleted(taskId)

    // Notify pool so the project queue drains. Symmetric with task:completed
    // and task:error — cancellation also vacates a pool slot, and without this
    // call the next queued task for the project would wait until another task
    // finishes naturally.
    if (task?.projectPath) {
      this.agentPool?.notifyTaskCompleted(task.projectPath)
    }

    // Notify hooks (fire-and-forget)
    if (task) {
      this.notifyHooksCancelled(taskId, task).catch(() => {})
    }

    this.heartbeatManager?.recordTermination(taskId)
  }

  private async handleTaskClearCompleted(
    data: TaskClearCompletedRequest,
    clientId: string,
  ): Promise<TaskClearCompletedResponse> {
    const projectFilter = data.projectPath ?? this.resolveClientProjectPath?.(clientId)
    if (projectFilter === undefined) return {deletedCount: 0}

    // In-memory: collect terminal completedTasks for the project.
    const inMemoryIds: string[] = []
    for (const [taskId, {task}] of this.completedTasks) {
      if (task.projectPath !== undefined && task.projectPath !== projectFilter) continue
      inMemoryIds.push(taskId)
    }

    // Persistent: clear matching terminal entries from disk (default statuses).
    let storeIds: string[] = []
    if (this.getTaskHistoryStore !== undefined) {
      try {
        const store = this.getTaskHistoryStore(projectFilter)
        const result = await store.clear({projectPath: projectFilter})
        storeIds = result.taskIds
      } catch (error) {
        transportLog(
          `handleTaskClearCompleted: store.clear failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        return {deletedCount: 0, error: 'task history store unavailable'}
      }
    }

    // Remove from in-memory.
    for (const taskId of inMemoryIds) this.completedTasks.delete(taskId)

    // Union + dedupe.
    const allIds = new Set<string>([...inMemoryIds, ...storeIds])
    for (const taskId of allIds) this.broadcastTaskDeleted(projectFilter, taskId)
    return {deletedCount: allIds.size}
  }

  private handleTaskCompleted(data: TaskCompletedEvent): void {
    const {logId: eventLogId, result, taskId} = data
    const existing = this.tasks.get(taskId)
    if (existing) {
      this.tasks.set(taskId, {...existing, completedAt: Date.now(), result, status: 'completed'})
    }

    const task = this.tasks.get(taskId)

    transportLog(`Task completed: ${taskId}`)

    // Collect synchronous completion data from hooks (e.g. pendingReviewCount from CurateLogHandler).
    // This runs before task:completed is emitted so the client receives everything atomically,
    // avoiding the race where review:notify would otherwise arrive after task:completed.
    const hookData: Record<string, unknown> = {}
    for (const hook of this.lifecycleHooks) {
      if (hook.getTaskCompletionData) {
        try {
          Object.assign(hookData, hook.getTaskCompletionData(taskId))
        } catch {
          // Best-effort: never block task:completed delivery
        }
      }
    }

    // Prefer logId from lifecycle hooks (curate), fall back to executor-provided logId (dream)
    const resolvedLogId = task?.logId ?? eventLogId

    if (task) {
      this.transport.sendTo(task.clientId, TransportTaskEventNames.COMPLETED, {
        ...(resolvedLogId ? {logId: resolvedLogId} : {}),
        ...hookData,
        result,
        taskId,
      })
    }

    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      task?.projectPath,
      TransportTaskEventNames.COMPLETED,
      {
        ...(resolvedLogId ? {logId: resolvedLogId} : {}),
        ...hookData,
        result,
        taskId,
      },
      task?.clientId,
    )
    this.moveToCompleted(taskId)

    // Notify pool so it can clear busy flag and drain queued tasks.
    // Fallback to data.projectPath for daemon-submitted tasks (e.g. idle dream)
    // that bypass handleTaskCreate and are not registered in this.tasks.
    const projectPath = task?.projectPath ?? data.projectPath
    if (projectPath) {
      this.agentPool?.notifyTaskCompleted(projectPath)
    }

    // Notify hooks (fire-and-forget)
    if (task) {
      this.notifyHooksCompleted(taskId, result, task).catch(() => {})
    }

    this.heartbeatManager?.recordTermination(taskId)
  }

  /**
   * Handle task creation from a client.
   *
   * Ordering (critical for correctness):
   * 1. Idempotency check
   * 2. Early validation — on failure: send task:error, return. No task stored, no task:created, no hooks called.
   * 3. Store task + send task:created synchronously (before any await)
   * 4. Await lifecycle hooks → get logId
   *    Note: task:ack is intentionally delayed until hooks resolve so logId can be included.
   *    This reverses the old ordering (previously ack preceded created).
   * 5. Send task:ack with logId
   * 6. Submit to agentPool (fire-and-forget)
   */
  private async handleTaskCreate(data: TaskCreateRequest, clientId: string): Promise<TaskCreateResponse> {
    const {taskId} = data

    if (this.tasks.has(taskId)) {
      // Idempotent — duplicate creation returns existing taskId (e.g. client retry)
      return {taskId}
    }

    // ── Early validation: no hooks called if invalid ──────────────────────────

    if (!this.agentPool) {
      transportLog(`No AgentPool available, cannot process task ${taskId}`)
      const error = serializeTaskError(new AgentNotAvailableError())
      const projectPath = data.projectPath ?? this.resolveClientProjectPath?.(clientId) ?? data.clientCwd
      this.transport.sendTo(clientId, TransportTaskEventNames.ERROR, {error, taskId})
      broadcastToProjectRoom(
        this.projectRegistry,
        this.projectRouter,
        projectPath,
        TransportTaskEventNames.ERROR,
        {error, taskId},
        clientId,
      )
      return {taskId}
    }

    if (!isValidTaskType(data.type)) {
      transportLog(`Invalid task type: ${data.type}`)
      const error = serializeTaskError(new Error(`Invalid task type: ${data.type}`))
      const projectPath = data.projectPath ?? this.resolveClientProjectPath?.(clientId) ?? data.clientCwd
      this.transport.sendTo(clientId, TransportTaskEventNames.ERROR, {error, taskId})
      broadcastToProjectRoom(
        this.projectRegistry,
        this.projectRouter,
        projectPath,
        TransportTaskEventNames.ERROR,
        {error, taskId},
        clientId,
      )
      return {taskId}
    }

    // ── Resolve projectPath & worktreeRoot, store task synchronously ─────────

    let projectPath: string | undefined
    let worktreeRoot: string | undefined

    try {
      const taskContext = this.resolveTaskContext(data, clientId)
      if (taskContext.error) {
        const error = serializeTaskError(new Error(taskContext.error))
        this.transport.sendTo(clientId, TransportTaskEventNames.ERROR, {error, taskId})
        broadcastToProjectRoom(
          this.projectRegistry,
          this.projectRouter,
          taskContext.projectPath,
          TransportTaskEventNames.ERROR,
          {error, taskId},
          clientId,
        )
        return {taskId}
      }

      projectPath = taskContext.projectPath
      worktreeRoot = taskContext.worktreeRoot
    } catch (error_) {
      const error = serializeTaskError(error_ instanceof Error ? error_ : new Error(String(error_)))
      const fallbackProjectPath = data.projectPath ?? this.resolveClientProjectPath?.(clientId) ?? data.clientCwd
      this.transport.sendTo(clientId, TransportTaskEventNames.ERROR, {error, taskId})
      broadcastToProjectRoom(
        this.projectRegistry,
        this.projectRouter,
        fallbackProjectPath,
        TransportTaskEventNames.ERROR,
        {error, taskId},
        clientId,
      )
      return {taskId}
    }

    transportLog(`Task accepted: ${taskId} (type=${data.type}, client=${clientId})`)

    // Resolve active provider/model snapshot. Conditional await preserves the
    // synchronous "store → broadcast" timing when no resolver is configured —
    // an unconditional await would yield a microtask even on an immediately-
    // resolved Promise, breaking tests that assert on broadcasts without
    // awaiting the handler.
    const {model, provider} = this.resolveActiveProvider ? await this.safeResolveActiveProvider() : {}

    this.tasks.set(taskId, {
      clientId,
      content: data.content,
      createdAt: Date.now(),
      status: 'created',
      ...(data.clientCwd ? {clientCwd: data.clientCwd} : {}),
      ...(data.files?.length ? {files: data.files} : {}),
      ...(data.folderPath ? {folderPath: data.folderPath} : {}),
      ...(model ? {model} : {}),
      ...(projectPath ? {projectPath} : {}),
      ...(provider ? {provider} : {}),
      taskId,
      type: data.type,
      ...(worktreeRoot ? {worktreeRoot} : {}),
    })

    // ── Send task:created synchronously (before any await) ────────────────────

    const createdPayload = {
      content: data.content,
      ...(data.clientCwd ? {clientCwd: data.clientCwd} : {}),
      ...(data.files?.length ? {files: data.files} : {}),
      ...(data.folderPath ? {folderPath: data.folderPath} : {}),
      ...(model ? {model} : {}),
      ...(provider ? {provider} : {}),
      taskId,
      type: data.type,
    }
    this.transport.sendTo(clientId, TransportTaskEventNames.CREATED, createdPayload)

    // Broadcast to other clients in the project room (exclude creator to avoid duplicate)
    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      projectPath,
      TransportTaskEventNames.CREATED,
      createdPayload,
      clientId,
    )

    // ── Snapshot reviewDisabled + await lifecycle hooks ───────────────────────

    // Snapshot the project's review-disabled flag once at the task-create boundary.
    // Placed after the synchronous tasks.set/task:created so callers that don't
    // await the create handler still see the task in this.tasks immediately.
    // The value is stamped onto TaskInfo (for CurateLogHandler) and TaskExecute
    // (forwarded to the agent) so both sides observe a single consistent value
    // even if the user toggles mid-task. Errors → undefined → fail-open enabled.
    const reviewDisabled = await this.snapshotReviewDisabled(projectPath)
    const taskAfterSnapshot = this.tasks.get(taskId)
    if (taskAfterSnapshot && reviewDisabled !== undefined) {
      this.tasks.set(taskId, {...taskAfterSnapshot, reviewDisabled})
    }

    const logId = await this.runCreateHooks(taskId)
    const task = this.tasks.get(taskId)
    if (task && logId) {
      this.tasks.set(taskId, {...task, logId})
    }

    // ── Send task:ack with logId ──────────────────────────────────────────────

    this.transport.sendTo(clientId, TransportTaskEventNames.ACK, {
      ...(logId ? {logId} : {}),
      taskId,
    })

    // ── Daemon-side pre-dispatch gate (dream uses this for gates 1-3) ────────
    // Runs after ack so the client has a logId to correlate; short-circuits with
    // task:completed + skip-reason when ineligible. Mirrors the idle-trigger
    // pattern in brv-server.ts:260 for the CLI dispatch path.

    if (this.preDispatchCheck) {
      let check: PreDispatchCheckResult = {eligible: true}
      try {
        check = await this.preDispatchCheck(data, projectPath)
      } catch (error_) {
        transportLog(
          `preDispatchCheck threw for task ${taskId}, proceeding with dispatch: ${error_ instanceof Error ? error_.message : String(error_)}`,
        )
      }

      if (!check.eligible) {
        transportLog(`Task ${taskId} (type=${data.type}) skipped by daemon pre-check: ${check.skipResult}`)
        // Use the skip-specific handler so the pool's activeTasks counter and
        // onTaskCompleted hooks aren't notified for a task that never reached
        // submitTask. See handleTaskSkippedByPreCheck for rationale.
        this.handleTaskSkippedByPreCheck(taskId, check.skipResult)
        return {taskId}
      }
    }

    // ── Submit to AgentPool (fire-and-forget) ─────────────────────────────────

    const executeMsg: TaskExecute = {
      clientId,
      content: data.content,
      ...(data.clientCwd ? {clientCwd: data.clientCwd} : {}),
      ...(data.files?.length ? {files: data.files} : {}),
      ...(data.folderPath ? {folderPath: data.folderPath} : {}),
      ...(data.force === undefined ? {} : {force: data.force}),
      ...(projectPath ? {projectPath} : {}),
      ...(reviewDisabled === undefined ? {} : {reviewDisabled}),
      taskId,
      type: data.type,
      ...(worktreeRoot ? {worktreeRoot} : {}),
    }

    // eslint-disable-next-line no-void
    void this.agentPool
      .submitTask(executeMsg)
      .then((submitResult) => {
        if (!submitResult.success) {
          transportLog(`AgentPool rejected task ${taskId}: ${submitResult.reason} — ${submitResult.message}`)
          const error = serializeTaskError(new Error(submitResult.message))
          const rejectedTask = this.tasks.get(taskId) ?? {
            clientId,
            content: data.content,
            createdAt: Date.now(),
            taskId,
            type: data.type,
          }
          this.tasks.delete(taskId)
          this.transport.sendTo(clientId, TransportTaskEventNames.ERROR, {
            ...(rejectedTask.logId ? {logId: rejectedTask.logId} : {}),
            error,
            taskId,
          })
          broadcastToProjectRoom(
            this.projectRegistry,
            this.projectRouter,
            projectPath,
            TransportTaskEventNames.ERROR,
            {
              ...(rejectedTask.logId ? {logId: rejectedTask.logId} : {}),
              error,
              taskId,
            },
            clientId,
          )
          this.notifyHooksError(taskId, submitResult.message, rejectedTask).catch(() => {})
        }
      })
      .catch((error_: unknown) => {
        transportLog(
          `AgentPool.submitTask threw unexpectedly for task ${taskId}: ${error_ instanceof Error ? error_.message : String(error_)}`,
        )
        const error = serializeTaskError(error_ instanceof Error ? error_ : new Error(String(error_)))
        const errorMsg = error_ instanceof Error ? error_.message : String(error_)
        const thrownTask = this.tasks.get(taskId) ?? {
          clientId,
          content: data.content,
          createdAt: Date.now(),
          taskId,
          type: data.type,
        }
        this.tasks.delete(taskId)
        this.transport.sendTo(clientId, TransportTaskEventNames.ERROR, {
          ...(thrownTask.logId ? {logId: thrownTask.logId} : {}),
          error,
          taskId,
        })
        broadcastToProjectRoom(
          this.projectRegistry,
          this.projectRouter,
          projectPath,
          TransportTaskEventNames.ERROR,
          {
            ...(thrownTask.logId ? {logId: thrownTask.logId} : {}),
            error,
            taskId,
          },
          clientId,
        )
        this.notifyHooksError(taskId, errorMsg, thrownTask).catch(() => {})
      })

    return {...(logId ? {logId} : {}), taskId}
  }

  private async handleTaskDelete(data: TaskDeleteRequest, clientId: string): Promise<TaskDeleteResponse> {
    const {taskId} = data

    // Refusal: non-terminal in-memory tasks must not be deleted out from under the agent.
    const liveTask = this.tasks.get(taskId)
    if (liveTask !== undefined) {
      const {status} = liveTask
      if (status !== undefined && !TERMINAL_STATUSES.has(status)) {
        return {error: `cannot delete task in status '${status}'`, removed: false, success: false}
      }
    }

    // Resolve projectPath: in-memory first, then the client's registered project.
    const projectPath =
      liveTask?.projectPath ??
      this.completedTasks.get(taskId)?.task.projectPath ??
      this.resolveClientProjectPath?.(clientId)

    const wasInMemory = this.tasks.has(taskId) || this.completedTasks.has(taskId)
    this.tasks.delete(taskId)
    this.completedTasks.delete(taskId)

    let wasLive = false
    if (this.getTaskHistoryStore !== undefined && projectPath !== undefined) {
      try {
        const store = this.getTaskHistoryStore(projectPath)
        wasLive = await store.delete(taskId)
      } catch (error) {
        transportLog(
          `handleTaskDelete: store.delete failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const removed = wasInMemory || wasLive
    if (removed) this.broadcastTaskDeleted(projectPath, taskId)

    // C4: `removed` distinguishes "actually deleted" from "idempotent no-op".
    // `task:deleteBulk` sums on this flag so unknown / already-tombstoned ids
    // never inflate `deletedCount`. The wire-level `success` stays `true` to
    // preserve the documented idempotent contract for single-delete callers.
    return {removed, success: true}
  }

  private async handleTaskDeleteBulk(data: TaskDeleteBulkRequest, clientId: string): Promise<TaskDeleteBulkResponse> {
    // N3: batch store.deleteMany per project instead of N×handleTaskDelete.
    // Per-id work splits into (a) liveness/refusal checks + in-memory cleanup
    // (cheap, sequential) and (b) the actual store mutation (expensive,
    // batched). Bulk delete of 200 ids in one project: 1 readIndexDedup +
    // 1 batched tombstone vs the previous 200 readIndexDedups.

    type Pending = {projectPath: string; taskId: string; wasInMemory: boolean}
    const pending: Pending[] = []

    for (const taskId of data.taskIds) {
      // Refusal: non-terminal in-memory tasks must not be deleted out from
      // under the agent — same contract as the single-delete handler.
      const liveTask = this.tasks.get(taskId)
      if (liveTask !== undefined) {
        const {status} = liveTask
        if (status !== undefined && !TERMINAL_STATUSES.has(status)) continue
      }

      // Resolve projectPath: in-memory first, then the client's registered project.
      const projectPath =
        liveTask?.projectPath ??
        this.completedTasks.get(taskId)?.task.projectPath ??
        this.resolveClientProjectPath?.(clientId)
      if (projectPath === undefined) continue

      const wasInMemory = this.tasks.has(taskId) || this.completedTasks.has(taskId)
      this.tasks.delete(taskId)
      this.completedTasks.delete(taskId)

      pending.push({projectPath, taskId, wasInMemory})
    }

    // Group by projectPath for batched store.deleteMany.
    const byProject = new Map<string, string[]>()
    for (const {projectPath, taskId} of pending) {
      const ids = byProject.get(projectPath) ?? []
      ids.push(taskId)
      byProject.set(projectPath, ids)
    }

    const storeRemoved = new Set<string>()
    if (this.getTaskHistoryStore !== undefined) {
      for (const [projectPath, ids] of byProject) {
        try {
          const store = this.getTaskHistoryStore(projectPath)
          // eslint-disable-next-line no-await-in-loop -- per-project sequential; project count is small
          const removed = await store.deleteMany(ids)
          for (const id of removed) storeRemoved.add(id)
        } catch (error) {
          transportLog(
            `handleTaskDeleteBulk: store.deleteMany failed for ${projectPath}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    // Final removed set = in-memory hits ∪ store hits. Per-id broadcast for
    // each — preserves the C4 contract (no broadcast for unknown ids).
    const removedSet = new Set<string>()
    const projectByTaskId = new Map<string, string>()
    for (const {projectPath, taskId, wasInMemory} of pending) {
      if (wasInMemory || storeRemoved.has(taskId)) {
        removedSet.add(taskId)
        projectByTaskId.set(taskId, projectPath)
      }
    }

    for (const taskId of removedSet) {
      this.broadcastTaskDeleted(projectByTaskId.get(taskId), taskId)
    }

    return {deletedCount: removedSet.size}
  }

  private handleTaskError(data: TaskErrorEvent): void {
    const {error, taskId} = data
    const existing = this.tasks.get(taskId)
    if (existing) {
      this.tasks.set(taskId, {...existing, completedAt: Date.now(), error, status: 'error'})
    }

    const task = this.tasks.get(taskId)

    transportLog(`Task error: ${taskId} - [${error.code}] ${error.message}`)

    if (task) {
      this.transport.sendTo(task.clientId, TransportTaskEventNames.ERROR, {
        ...(task.logId ? {logId: task.logId} : {}),
        error,
        taskId,
      })
    }

    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      task?.projectPath,
      TransportTaskEventNames.ERROR,
      {
        ...(task?.logId ? {logId: task.logId} : {}),
        error,
        taskId,
      },
      task?.clientId,
    )
    this.moveToCompleted(taskId)

    // Notify pool so it can clear busy flag and drain queued tasks.
    // Fallback to data.projectPath for daemon-submitted tasks (e.g. idle dream).
    const errorProjectPath = task?.projectPath ?? data.projectPath
    if (errorProjectPath) {
      this.agentPool?.notifyTaskCompleted(errorProjectPath)
    }

    // Notify hooks (fire-and-forget)
    if (task) {
      this.notifyHooksError(taskId, error.message, task).catch(() => {})
    }

    this.heartbeatManager?.recordTermination(taskId)
  }

  private async handleTaskGet(data: TaskGetRequest, clientId: string): Promise<TaskGetResponse> {
    const {taskId} = data

    // Try in-memory active first
    const liveTask = this.tasks.get(taskId) ?? this.completedTasks.get(taskId)?.task
    if (liveTask !== undefined) {
      const synthesized = buildTaskHistoryEntry(liveTask)
      if (synthesized !== undefined) return {task: synthesized}
    }

    // Fall back to disk
    if (this.getTaskHistoryStore === undefined) return {task: null}
    const projectFilter = liveTask?.projectPath ?? this.resolveClientProjectPath?.(clientId)
    if (projectFilter === undefined) return {task: null}

    try {
      const store = this.getTaskHistoryStore(projectFilter)
      const entry = await store.getById(taskId)
      return {task: entry ?? null}
    } catch (error) {
      transportLog(
        `handleTaskGet: store.getById failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return {task: null}
    }
  }

  // eslint-disable-next-line complexity
  private async handleTaskList(data: TaskListRequest, clientId: string): Promise<TaskListResponse> {
    const projectFilter = data.projectPath ?? this.resolveClientProjectPath?.(clientId)

    // No resolvable project — return empty (don't leak other projects' work).
    if (projectFilter === undefined) return emptyTaskListResponse(data)

    const inMemoryTaskById = new Map<string, TaskInfo>()
    const collectInMemory = (task: TaskInfo): void => {
      if (task.projectPath !== undefined && task.projectPath !== projectFilter) return
      inMemoryTaskById.set(task.taskId, task)
    }

    for (const task of this.tasks.values()) collectInMemory(task)
    for (const {task} of this.completedTasks.values()) collectInMemory(task)

    // Persisted entries (best-effort — tolerate store outages). Push down ONLY
    // non-pivot filters (project + type + time). Pivot filters (status / provider
    // / model) are evaluated at the handler level so derivative sets (counts,
    // availableProviders, availableModels) can apply their exclusion rules.
    let persisted: TaskListItem[] = []
    if (this.getTaskHistoryStore !== undefined) {
      try {
        const store = this.getTaskHistoryStore(projectFilter)
        persisted = await store.list({
          projectPath: projectFilter,
          ...(data.createdAfter === undefined ? {} : {createdAfter: data.createdAfter}),
          ...(data.createdBefore === undefined ? {} : {createdBefore: data.createdBefore}),
          ...(data.type === undefined ? {} : {type: data.type}),
        })
      } catch (error) {
        transportLog(`handleTaskList: store.list failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // Step 1-2: merge candidates + apply NON-PIVOT filters with pass-1 search
    // (project + type + time + duration + content/error.message search).
    // Status/provider/model are pivot filters — applied later. `available*`
    // dropdowns exclude status+provider+model pivots so users can switch
    // selections without the dropdown shrinking. `counts` reflects the FULL
    // current filter (including status) — chip count = visible row count.
    //
    // Pass-2 (full-result lazy crack) re-uses the same `candidatesNoSearch` map
    // built below to find completed tasks whose result text matches but whose
    // content/error.message did not. `pass2Filter` is the same shape as
    // `nonPivotFilterArgs` minus searchText — the spread auto-inherits any
    // future non-pivot filter dim added upstream.
    const merged = new Map<string, TaskListItem>()
    const nonPivotFilterArgs: ListFilterArgs = {
      createdAfter: data.createdAfter,
      createdBefore: data.createdBefore,
      maxDurationMs: data.maxDurationMs,
      minDurationMs: data.minDurationMs,
      projectFilter,
      searchText: data.searchText,
      typeFilter: data.type,
    }
    const pass2Filter: ListFilterArgs = {...nonPivotFilterArgs, searchText: undefined}

    // Single pass over persisted + in-memory: build `candidatesNoSearch` (all non-pivot
    // filters applied EXCEPT search). `merged` derives from it by re-applying the search
    // predicate via `matchesListFilters(item, nonPivotFilterArgs)`. Saves a 2×N traversal
    // when searchText is set; same cost when unset.
    const candidatesNoSearch = new Map<string, TaskListItem>()
    for (const item of persisted) {
      if (matchesListFilters(item, pass2Filter)) candidatesNoSearch.set(item.taskId, item)
    }

    for (const task of inMemoryTaskById.values()) {
      const item = toListItem(task)
      if (matchesListFilters(item, pass2Filter)) candidatesNoSearch.set(item.taskId, item)
    }

    for (const [taskId, item] of candidatesNoSearch) {
      if (matchesListFilters(item, nonPivotFilterArgs)) merged.set(taskId, item)
    }

    // Step 3-4: pass-2 search (full-text via lazy data-file crack).
    // Only when searchText is set AND the row has status='completed' AND it didn't match pass-1.
    // For in-memory tasks we read result directly from TaskInfo (no I/O); for
    // persisted we call store.getById, swallowing file-race errors.
    if (data.searchText !== undefined && data.searchText.length > 0) {
      const needle = data.searchText.toLowerCase()

      const completedUnmatched: TaskListItem[] = []
      for (const item of candidatesNoSearch.values()) {
        if (item.status !== 'completed') continue
        if (merged.has(item.taskId)) continue
        completedUnmatched.push(item)
      }

      // Log race errors at most once per query to avoid log spam during compaction storms.
      // The rest of the racing reads still execute; we just don't write N log lines.
      let raceLogged = false

      const matchedIds = await mapBounded(completedUnmatched, FULL_TEXT_CONCURRENCY, async (item) => {
        // In-memory task — match against task.result directly (no I/O).
        // Invariant: in-memory tasks with status='completed' always have task.result
        // defined because handleTaskCompleted sets it synchronously with the status
        // transition (TaskCompletedEvent.result is required by schema). Persisted
        // snapshots are derived from this same TaskInfo, so no in-memory/disk
        // result divergence is possible — fallback to getById is unnecessary here.
        const inMem = inMemoryTaskById.get(item.taskId)
        if (inMem !== undefined) {
          if (inMem.result !== undefined && inMem.result.toLowerCase().includes(needle)) return item.taskId
          return
        }

        // Persisted — load full entry via store.getById.
        if (this.getTaskHistoryStore === undefined) return
        try {
          const store = this.getTaskHistoryStore(projectFilter)
          const entry = await store.getById(item.taskId)
          if (entry?.status === 'completed' && entry.result?.toLowerCase().includes(needle)) {
            return item.taskId
          }
        } catch (error) {
          // Swallow file-race (concurrent delete/compaction) — treat as no-match.
          if (!raceLogged) {
            raceLogged = true
            transportLog(
              `handleTaskList: pass-2 getById(${item.taskId}) failed: ${error instanceof Error ? error.message : String(error)} (further race errors in this query suppressed)`,
            )
          }
        }
      })

      for (const id of matchedIds) {
        if (id === undefined) continue
        const fromMap = candidatesNoSearch.get(id)
        if (fromMap !== undefined) merged.set(id, fromMap)
      }
    }

    // Step 5: nonPivotFull = merged. Derive availableProviders/availableModels.
    // Guard both provider AND model length > 0 — wire/index schemas accept empty
    // strings, which would otherwise emit phantom entries like {providerId: 'openai', modelId: ''}.
    const availableProviderSet = new Set<string>()
    const availableModelMap = new Map<string, {modelId: string; providerId: string}>()
    for (const item of merged.values()) {
      const providerId = item.provider
      const modelId = item.model
      if (providerId !== undefined && providerId.length > 0) availableProviderSet.add(providerId)
      if (providerId !== undefined && providerId.length > 0 && modelId !== undefined && modelId.length > 0) {
        const key = `${providerId}|${modelId}`
        if (!availableModelMap.has(key)) availableModelMap.set(key, {modelId, providerId})
      }
    }

    const availableProviders = [...availableProviderSet].sort((a, b) => a.localeCompare(b))
    const availableModels = [...availableModelMap.values()].sort((a, b) => {
      const p = a.providerId.localeCompare(b.providerId)
      return p === 0 ? a.modelId.localeCompare(b.modelId) : p
    })

    // Step 6: apply pivot filters (provider + model + status) → allFiltered.
    // Hoist into consts so TS narrows the loop captures (avoids `!` assertion per CLAUDE.md).
    const providerFilter = data.provider
    const modelFilter = data.model
    const statusFilter = data.status
    const allFiltered: TaskListItem[] = []
    for (const item of merged.values()) {
      if (
        providerFilter &&
        providerFilter.length > 0 &&
        (item.provider === undefined || !providerFilter.includes(item.provider))
      ) {
        continue
      }

      if (modelFilter && modelFilter.length > 0 && (item.model === undefined || !modelFilter.includes(item.model))) {
        continue
      }

      if (statusFilter && statusFilter.length > 0 && !statusFilter.includes(item.status)) continue
      allFiltered.push(item)
    }

    // Step 7: counts = status histogram of allFiltered (matches current filter scope — Model A).
    // Chip count == visible row count; counts.all === total invariant.
    const counts = {all: allFiltered.length, cancelled: 0, completed: 0, failed: 0, running: 0}
    for (const item of allFiltered) {
      switch (item.status) {
        case 'cancelled': {
          counts.cancelled++
          break
        }

        case 'completed': {
          counts.completed++
          break
        }

        case 'created':
        case 'started': {
          counts.running++
          break
        }

        case 'error': {
          counts.failed++
          break
        }
      }
    }

    // Step 8: Sort (createdAt DESC, taskId DESC) — stable secondary order for same-millisecond clusters.
    allFiltered.sort((a, b) => {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt
      if (b.taskId > a.taskId) return 1
      if (b.taskId < a.taskId) return -1
      return 0
    })

    // Step 9: paginate. Wire shape unchanged (result preserved per existing toListItem behavior).
    const pageSize = Math.min(Math.max(data.pageSize ?? DEFAULT_TASK_LIST_PAGE_SIZE, 1), 1000)
    const page = Math.max(data.page ?? 1, 1)
    const total = allFiltered.length
    const pageCount = Math.max(Math.ceil(total / pageSize), 1)
    const start = (page - 1) * pageSize
    const tasks = allFiltered.slice(start, start + pageSize)

    return {availableModels, availableProviders, counts, page, pageCount, pageSize, tasks, total}
  }

  /**
   * Emit `task:completed` for a task that the daemon's pre-dispatch gate skipped
   * before it ever reached `AgentPool.submitTask`.
   *
   * Distinct from {@link handleTaskCompleted}:
   *   - does NOT call `agentPool.notifyTaskCompleted` (the pool's `activeTasks`
   *     counter was never incremented, so decrementing here would undercount real
   *     load and let `drainQueue` dispatch an extra queued task)
   *   - does NOT fire `onTaskCompleted` lifecycle hooks (counters/metrics that
   *     act on completed tasks should not see pre-check skips as completions)
   *
   * Still emits the event to the client and the project room so REPL/TUI
   * receive the skip result, and still calls `moveToCompleted` so the task is
   * removed from the active set.
   */
  private handleTaskSkippedByPreCheck(taskId: string, result: string): void {
    const task = this.tasks.get(taskId)

    transportLog(`Task skipped by pre-dispatch gate: ${taskId}`)

    if (task) {
      this.transport.sendTo(task.clientId, TransportTaskEventNames.COMPLETED, {
        result,
        taskId,
      })
    }

    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      task?.projectPath,
      TransportTaskEventNames.COMPLETED,
      {result, taskId},
      task?.clientId,
    )
    this.moveToCompleted(taskId)
  }

  private handleTaskStarted(data: TaskStartedEvent): void {
    const {taskId} = data
    const task = this.tasks.get(taskId)
    if (task) {
      this.tasks.set(taskId, {...task, startedAt: Date.now(), status: 'started'})
      // No `onTaskStarted` hook — capture the transition via the throttled flush.
      this.markDirty(taskId)
      this.transport.sendTo(task.clientId, TransportTaskEventNames.STARTED, {taskId})

      broadcastToProjectRoom(
        this.projectRegistry,
        this.projectRouter,
        task.projectPath,
        TransportTaskEventNames.STARTED,
        {
          content: task.content,
          ...(task.clientCwd ? {clientCwd: task.clientCwd} : {}),
          ...(task.files?.length ? {files: task.files} : {}),
          taskId,
          type: task.type,
        },
        task.clientId,
      )

      // Begin liveness ticker for the CLI heartbeat watcher (M6 T1).
      // Cleared on the three terminal events; reset on every LlmEvent forward.
      this.heartbeatManager?.register(taskId, task.clientId, task.projectPath)
    } else {
      // No task context — cannot determine project room, skip broadcast
      transportLog(`Task started but no task context found: ${taskId}`)
    }
  }

  /**
   * Mark a taskId for the next throttled `onTaskUpdate` flush.
   * Schedules a timer if none is pending. Bursts of dirty marks within the
   * 100ms window coalesce into a single flush.
   */
  private markDirty(taskId: string): void {
    this.dirtyTaskIds.add(taskId)
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushDirty().catch(() => {
        // flushDirty already swallows per-hook errors; this catch covers
        // unexpected scheduler-level failures.
      })
    }, TaskRouter.FLUSH_INTERVAL_MS)
    // unref so a pending flush doesn't block daemon shutdown.
    this.flushTimer.unref?.()
  }

  /**
   * Move a task to the completed tasks map with grace period cleanup.
   */
  private moveToCompleted(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (task) {
      this.completedTasks.set(taskId, {completedAt: Date.now(), task})
      this.tasks.delete(taskId)

      const timer = setTimeout(() => {
        this.completedTasks.delete(taskId)
      }, TASK_CLEANUP_GRACE_PERIOD_MS)
      // Don't keep the event loop alive purely for completed-task GC.
      timer.unref?.()
    }
  }

  /**
   * Notify all hooks of task cancellation.
   * Each hook is called independently; errors are caught and logged.
   * cleanup() is called for each hook after onTaskCancelled.
   */
  private async notifyHooksCancelled(taskId: string, task: TaskInfo): Promise<void> {
    await Promise.allSettled(
      this.lifecycleHooks.map(async (hook) => {
        try {
          await hook.onTaskCancelled?.(taskId, task)
        } catch (error) {
          transportLog(
            `LifecycleHook.onTaskCancelled error for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          hook.cleanup?.(taskId)
        }
      }),
    )
  }

  /**
   * Notify all hooks of task completion.
   * Each hook is called independently; errors are caught and logged.
   * cleanup() is called for each hook after onTaskCompleted.
   */
  private async notifyHooksCompleted(taskId: string, result: string, task: TaskInfo): Promise<void> {
    await Promise.allSettled(
      this.lifecycleHooks.map(async (hook) => {
        try {
          await hook.onTaskCompleted?.(taskId, result, task)
        } catch (error) {
          transportLog(
            `LifecycleHook.onTaskCompleted error for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          hook.cleanup?.(taskId)
        }
      }),
    )
  }

  /**
   * Notify all hooks of task error.
   * Each hook is called independently; errors are caught and logged.
   * cleanup() is called for each hook after onTaskError.
   */
  private async notifyHooksError(taskId: string, errorMessage: string, task: TaskInfo): Promise<void> {
    await Promise.allSettled(
      this.lifecycleHooks.map(async (hook) => {
        try {
          await hook.onTaskError?.(taskId, errorMessage, task)
        } catch (error) {
          transportLog(
            `LifecycleHook.onTaskError error for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        } finally {
          hook.cleanup?.(taskId)
        }
      }),
    )
  }

  private registerLlmEvent<E extends LlmEventName>(eventName: E): void {
    this.transport.onRequest<LlmEventPayloadMap[E], void>(eventName, (data) => {
      if (!hasTaskId(data)) return
      this.routeLlmEvent(eventName, data)
    })
  }

  private resolveTaskContext(
    data: TaskCreateRequest,
    clientId: string,
  ): {error?: string; projectPath?: string; worktreeRoot?: string} {
    // When both projectPath and worktreeRoot are explicitly provided,
    // skip the resolver entirely — a broken link under clientCwd must not
    // reject an otherwise valid explicit payload.
    if (data.projectPath && data.worktreeRoot) {
      if (!isDescendantOf(data.worktreeRoot, data.projectPath)) {
        return {
          error: `worktreeRoot "${data.worktreeRoot}" must be equal to or within projectPath "${data.projectPath}".`,
          projectPath: data.projectPath,
        }
      }

      return {projectPath: data.projectPath, worktreeRoot: data.worktreeRoot}
    }

    // Resolve from clientCwd (fresh, workspace-link-aware) when needed.
    let resolvedProjectPath: string | undefined
    let resolvedWorkspaceRoot: string | undefined

    if (data.clientCwd) {
      const resolution = resolveProject({cwd: data.clientCwd})
      resolvedProjectPath = resolution?.projectRoot
      resolvedWorkspaceRoot = resolution?.worktreeRoot
    }

    // Fallback order: explicit > fresh cwd resolution > stale registration > raw clientCwd.
    // Fresh resolution is preferred over registered path because the registered path
    // may be stale (e.g. in-flight reassociation after worktree add/remove).
    const registeredProjectPath = this.resolveClientProjectPath?.(clientId)
    const projectPath = data.projectPath ?? resolvedProjectPath ?? registeredProjectPath ?? data.clientCwd
    const worktreeRoot = data.worktreeRoot ?? resolvedWorkspaceRoot ?? projectPath

    if (projectPath && worktreeRoot && !isDescendantOf(worktreeRoot, projectPath)) {
      return {
        error: `worktreeRoot "${worktreeRoot}" must be equal to or within projectPath "${projectPath}".`,
        projectPath,
      }
    }

    return {projectPath, worktreeRoot}
  }

  /**
   * Generic handler for routing LLM events from Agent to clients.
   * Checks both active and recently completed tasks (within grace period).
   * onToolResult hooks are called only for ACTIVE tasks (not grace-period).
   */
  private routeLlmEvent(eventName: string, data: {[key: string]: unknown; taskId: string}): void {
    const {taskId, ...rest} = data
    const activeTask = this.tasks.get(taskId)
    const task = activeTask ?? this.completedTasks.get(taskId)?.task

    if (!task) {
      return
    }

    // Accumulator: mutate the live `TaskInfo` BEFORE broadcasting so a tab
    // refresh during the next throttle window sees the in-flight state.
    // Only mutates for ACTIVE tasks — grace-period entries already had their
    // terminal save persisted by the lifecycle hook.
    if (activeTask) {
      this.accumulateLlmEvent(taskId, eventName, data)
    }

    // Notify onToolResult hooks only for active tasks
    if (activeTask && eventName === LlmEventNames.TOOL_RESULT) {
      for (const hook of this.lifecycleHooks) {
        try {
          hook.onToolResult?.(taskId, data as unknown as LlmToolResultEvent)
        } catch (error) {
          transportLog(
            `LifecycleHook.onToolResult error for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    this.transport.sendTo(task.clientId, eventName, {taskId, ...rest})
    broadcastToProjectRoom(
      this.projectRegistry,
      this.projectRouter,
      task.projectPath,
      eventName,
      {taskId, ...rest},
      task.clientId,
    )

    // Reset the heartbeat timer — every forwarded LLM event counts as
    // activity so a noisy task never triggers a redundant `task:heartbeat`.
    this.heartbeatManager?.recordActivity(taskId)
  }

  /**
   * Run all onTaskCreate hooks and return the first logId.
   * Each hook is called independently; errors are caught and logged.
   */
  private async runCreateHooks(taskId: string): Promise<string | undefined> {
    if (this.lifecycleHooks.length === 0) return undefined

    const task = this.tasks.get(taskId)
    if (!task) return undefined

    const logIds = await Promise.all(
      this.lifecycleHooks.map(async (hook) => {
        if (!hook.onTaskCreate) return
        try {
          const result = await hook.onTaskCreate(task)
          return result?.logId
        } catch (error) {
          transportLog(
            `LifecycleHook.onTaskCreate error for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }),
    )

    return logIds.find((id): id is string => typeof id === 'string')
  }

  /**
   * Invoke `resolveActiveProvider` with a try/catch so a thrown resolver
   * cannot block task dispatch. Returns `{}` when no resolver is configured
   * or when the resolver rejects/throws.
   */
  private async safeResolveActiveProvider(): Promise<{model?: string; provider?: string}> {
    if (!this.resolveActiveProvider) return {}
    try {
      return await this.resolveActiveProvider()
    } catch (error) {
      transportLog(`resolveActiveProvider failed: ${error instanceof Error ? error.message : String(error)}`)
      return {}
    }
  }

  /**
   * Reads the project's reviewDisabled flag at task-create.
   *
   * Returns `undefined` only when no resolver is wired or no projectPath was
   * resolved — those are legitimate "not configured" cases where downstream
   * consumers fall back to their own resolution path.
   *
   * On resolver THROW, returns the explicit boolean `false` (review enabled =
   * fail-open) so the daemon and the agent observe a single concrete value.
   * Returning `undefined` here would re-introduce the exact divergence the
   * snapshot is supposed to prevent: daemon stamps no field → CurateLogHandler
   * uses `?? false` (enabled) while the agent process opens no ALS scope and
   * may read `reviewDisabled: true` from `.brv/config.json` in the
   * curate-tool fallback, producing pending review entries without backups
   * (or vice versa). Aligns with the agent-side `isReviewDisabledForBrvDir`
   * which also fails open.
   */
  private async snapshotReviewDisabled(projectPath: string | undefined): Promise<boolean | undefined> {
    if (!this.isReviewDisabled || !projectPath) return undefined
    try {
      return await this.isReviewDisabled(projectPath)
    } catch (error_) {
      transportLog(
        `TaskRouter: isReviewDisabled resolver threw for ${projectPath} — defaulting to enabled: ${error_ instanceof Error ? error_.message : String(error_)}`,
      )
      return false
    }
  }
}
