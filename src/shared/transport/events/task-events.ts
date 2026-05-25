/**
 * Persisted-entry schema version. Bumped only on shape-breaking changes to
 * `TaskHistoryEntry`. The Zod schema in `server/core/domain/entities/` uses
 * `z.literal(TASK_HISTORY_SCHEMA_VERSION)` to refuse mismatched on-disk lines.
 */
export const TASK_HISTORY_SCHEMA_VERSION = 1

export const TaskEvents = {
  ACK: 'task:ack',
  CANCEL: 'task:cancel',
  CANCELLED: 'task:cancelled',
  CLEAR_COMPLETED: 'task:clearCompleted',
  COMPLETED: 'task:completed',
  CREATE: 'task:create',
  CREATED: 'task:created',
  DELETE: 'task:delete',
  DELETE_BULK: 'task:deleteBulk',
  DELETED: 'task:deleted',
  ERROR: 'task:error',
  GET: 'task:get',
  HEARTBEAT: 'task:heartbeat',
  LIST: 'task:list',
  STARTED: 'task:started',
} as const

/**
 * Wire payload for the daemon-driven liveness signal.
 * Emitted on a stale-interval timer when no other task-scoped event has
 * been forwarded for the given `taskId`; cleared on terminal events.
 */
export interface TaskHeartbeatEvent {
  /** `Date.now()` snapshot taken at emit time (echoed for client diagnostics). */
  lastActivityAt: number
  taskId: string
}

export interface TaskCreateRequest {
  clientCwd?: string
  content: string
  files?: string[]
  folderPath?: string
  projectPath?: string
  taskId: string
  type: 'curate' | 'curate-folder' | 'curate-html-direct' | 'query' | 'query-tool-mode' | 'search'
  worktreeRoot?: string
}

export interface TaskAckResponse {
  taskId: string
}

export interface TaskCancelRequest {
  taskId: string
}

export interface TaskCancelResponse {
  error?: string
  success: boolean
}

export type TaskListItemStatus = 'cancelled' | 'completed' | 'created' | 'error' | 'started'

/**
 * Reasoning/thinking content item with timestamp for ordering.
 * Shared between webui, tui, and the server-side TaskHistoryEntry.
 */
export type ReasoningContentItem = {
  content: string
  /** Whether this reasoning item is still being streamed */
  isThinking?: boolean
  timestamp: number
}

/**
 * Persisted tool-call lifecycle entry — distinct from the wire-payload
 * `LlmToolCallEventSchema` in `core/domain/transport/schemas.ts`. This shape
 * carries the `running | completed | error` state machine and is the form
 * stored in `TaskHistoryEntry.toolCalls`.
 */
export type ToolCallEvent = {
  args: Record<string, unknown>
  callId?: string
  error?: string
  errorType?: string
  result?: unknown
  sessionId: string
  status: 'completed' | 'error' | 'running'
  timestamp: number
  toolName: string
}

export interface TaskListItem {
  completedAt?: number
  content: string
  createdAt: number
  error?: {
    code?: string
    message: string
    name: string
  }
  /** Optional file paths from `curate --files` */
  files?: string[]
  /** Folder path for `curate-folder` tasks */
  folderPath?: string
  /** Active model id at task creation time */
  model?: string
  projectPath?: string
  /** Active provider id at task creation time */
  provider?: string
  result?: string
  startedAt?: number
  status: TaskListItemStatus
  taskId: string
  type: string
}

/**
 * task:list request — numbered pagination + filter/search (M2.16).
 * All filter dims are optional; AND-combined when multiple are set.
 */
export interface TaskListRequest {
  /** createdAt >= this epoch ms */
  createdAfter?: number
  /** createdAt <= this epoch ms */
  createdBefore?: number
  /** Maximum elapsed time (ms) for terminal tasks. */
  maxDurationMs?: number
  /** Minimum elapsed time (ms); only matches startedAt+completedAt rows. */
  minDurationMs?: number
  /** Filter to these model ids (exact match). */
  model?: string[]
  /** 1-based page index; defaults to 1. */
  page?: number
  /** Page size 1..1000; defaults to 50. */
  pageSize?: number
  projectPath?: string
  /** Filter to these provider ids (exact match). */
  provider?: string[]
  /** Case-insensitive substring on content + result + error.message. */
  searchText?: string
  status?: TaskListItemStatus[]
  type?: string[]
}

/** Status histogram used by FE filter-bar breakdown (M2.16). */
export interface TaskListCounts {
  all: number
  cancelled: number
  completed: number
  /** Tasks with status === 'error'. */
  failed: number
  /** Tasks with status === 'created' || 'started'. */
  running: number
}

/** (providerId, modelId) pair from history (M2.16). */
export interface TaskListAvailableModel {
  modelId: string
  providerId: string
}

export interface TaskListResponse {
  /** Distinct (providerId, modelId) pairs seen in candidate set. */
  availableModels: TaskListAvailableModel[]
  /** Distinct providerId values seen in candidate set. */
  availableProviders: string[]
  /**
   * Status histogram matching current filter scope (Model A — post-filter).
   * `counts.all === total` invariant. When user picks `status: ['error']`,
   * `counts.failed === total` and other buckets are 0.
   */
  counts: TaskListCounts
  /**
   * 1-based page index, echoed back as-sent. Server clamps the LOWER bound
   * (page < 1 → 1) but does NOT clamp against `pageCount`. A request with
   * `page=9999` against a 1-page result returns `page: 9999, tasks: []` so
   * the caller can detect an out-of-range page.
   */
  page: number
  /** ceil(total / pageSize), min 1. */
  pageCount: number
  /** Page size echoed back, clamped to [1, 1000]. */
  pageSize: number
  tasks: TaskListItem[]
  /** Total items matching ALL filters (incl. status). */
  total: number
}

export type TaskClearCompletedRequest = {
  projectPath?: string
}

export type TaskClearCompletedResponse = {
  deletedCount: number
  error?: string
}

export type TaskDeleteBulkRequest = {
  taskIds: string[]
}

export type TaskDeleteBulkResponse = {
  deletedCount: number
  error?: string
}

export type TaskDeleteRequest = {
  taskId: string
}

export type TaskDeleteResponse = {
  error?: string
  /**
   * `true` when the task was actually removed (was live or persisted),
   * `false` when the call was a no-op (taskId unknown or already tombstoned).
   * `task:deleteBulk` uses this to compute an accurate `deletedCount`.
   */
  removed?: boolean
  success: boolean
}

export type TaskDeletedEvent = {
  taskId: string
}

export type TaskGetRequest = {
  taskId: string
}

export type TaskGetResponse = {
  task: null | TaskHistoryEntry
}

/**
 * Full per-task error payload — superset of `TaskListItem.error`, adds the
 * optional `details` bag. Mirrors `TaskErrorDataSchema` in
 * `src/server/core/domain/entities/task-history-entry.ts`; the server schema
 * carries `satisfies z.ZodType<TaskErrorData>` to keep them aligned.
 */
export type TaskErrorData = {
  code?: string
  details?: Record<string, unknown>
  message: string
  name: string
}

/**
 * Discriminated-union shape for a persisted task. The server-side Zod schema
 * (`TaskHistoryEntrySchema`) is the runtime source of truth and carries
 * `satisfies z.ZodType<TaskHistoryEntry>` so any drift between the two
 * representations is a typecheck error.
 *
 * Lives in `shared/` so webui + tui can consume it without inverting the
 * dependency direction onto `server/`.
 */
type TaskHistoryEntryBase = {
  clientCwd?: string
  content: string
  createdAt: number
  files?: string[]
  folderPath?: string
  id: string
  logId?: string
  model?: string
  projectPath: string
  provider?: string
  reasoningContents?: ReasoningContentItem[]
  responseContent?: string
  schemaVersion: typeof TASK_HISTORY_SCHEMA_VERSION
  sessionId?: string
  taskId: string
  toolCalls?: ToolCallEvent[]
  type: string
  worktreeRoot?: string
}

export type TaskHistoryEntry =
  | (TaskHistoryEntryBase & {
      completedAt: number
      error: TaskErrorData
      startedAt?: number
      status: 'error'
    })
  | (TaskHistoryEntryBase & {
      completedAt: number
      result?: string
      startedAt?: number
      status: 'completed'
    })
  | (TaskHistoryEntryBase & {
      completedAt: number
      startedAt?: number
      status: 'cancelled'
    })
  | (TaskHistoryEntryBase & {startedAt: number; status: 'started'})
  | (TaskHistoryEntryBase & {status: 'created'})

export type TaskHistoryStatus = TaskHistoryEntry['status']
