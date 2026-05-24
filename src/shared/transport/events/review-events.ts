export const ReviewEvents = {
  DECIDE_TASK: 'review:decideTask',
  GET_DISABLED: 'review:getDisabled',
  LIST_OPERATIONS: 'review:listOperations',
  NOTIFY: 'review:notify',
  PENDING: 'review:pending',
  SET_DISABLED: 'review:setDisabled',
} as const

export interface ReviewGetDisabledResponse {
  reviewDisabled: boolean
}

export interface ReviewSetDisabledRequest {
  reviewDisabled: boolean
}

export interface ReviewSetDisabledResponse {
  reviewDisabled: boolean
}

export interface ReviewNotifyEvent {
  pendingCount: number
  /** URL to the local Changes tab (only set when WebUI is running). */
  reviewUrl?: string
  taskId: string
}

export interface ReviewDecideTaskRequest {
  decision: 'approved' | 'rejected'
  /** When provided, only operations targeting these context-tree-relative paths are affected. */
  filePaths?: string[]
  taskId: string
}

export interface ReviewDecideTaskResponse {
  files: Array<{path: string; reverted: boolean}>
  totalCount: number
}

export interface ReviewPendingOperation {
  /** Context-tree-relative file path (e.g. architecture/daemon/lifecycle.md). Used with --file flag. */
  filePath?: string
  impact?: 'high' | 'low'
  path: string
  previousSummary?: string
  reason?: string
  summary?: string
  type: 'ADD' | 'DELETE' | 'MERGE' | 'UPDATE' | 'UPSERT'
}

export interface ReviewPendingTask {
  operations: ReviewPendingOperation[]
  taskId: string
}

export interface ReviewPendingResponse {
  pendingCount: number
  tasks: ReviewPendingTask[]
}

/**
 * Single agent-authored operation surfaced for the WebUI Changes tab.
 * Returned by `review:listOperations`. Path is context-tree-relative (e.g.
 * `architecture/daemon/lifecycle.md`) so the client can join it onto the working-tree
 * file list returned by `vc:status`. `reviewStatus` is `undefined` for ops the agent
 * applied directly without queueing (low-impact UPSERT/MERGE/UPDATE/ADD).
 */
export interface AgentChangeOperation {
  filePath: string
  impact?: 'high' | 'low'
  /** entry.startedAt — used by the client to dedup multiple ops on the same file (latest wins). */
  opCreatedAt: number
  reason?: string
  reviewStatus?: 'approved' | 'pending' | 'rejected'
  summary?: string
  taskId: string
  type: 'ADD' | 'DELETE' | 'MERGE' | 'UPDATE' | 'UPSERT'
}

export interface ReviewListOperationsResponse {
  operations: AgentChangeOperation[]
}
