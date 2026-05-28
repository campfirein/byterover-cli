import type {ReasoningContentItem, ToolCallEvent} from '../../../../shared/transport/events/task-events.js'
import type {ClientType} from '../client/client-info.js'
import type {TaskErrorData, TaskListItemStatus, TaskType} from './schemas.js'

/**
 * Tracked task metadata used by TaskRouter for routing events
 * and by ConnectionCoordinator for agent disconnect cleanup.
 *
 * Level 2 fields (`responseContent`, `reasoningContents`, `toolCalls`,
 * `sessionId`) are accumulated from `llmservice:*` events and persisted
 * by `TaskHistoryHook` so a tab refresh mid-stream can render the in-flight
 * state.
 */
export type TaskInfo = {
  /** Client's working directory for file validation */
  clientCwd?: string
  clientId: string
  /**
   * M15.8: snapshot of submitting client's IDE product name (e.g. "Cursor")
   * captured at handleTaskCreate. Used by AnalyticsHook to emit
   * mcp_tool_called with `client_name` even after the originating MCP
   * client disconnects mid-task. Undefined for non-MCP submissions or
   * when the MCP handshake had not delivered a name by task-create time.
   */
  clientName?: string
  /**
   * M15.8: snapshot of submitting client's transport kind. Lets
   * AnalyticsHook gate MCP-only emits on `clientType === 'mcp'`
   * without re-querying ClientManager (which may have disconnected
   * the client by task completion).
   */
  clientType?: ClientType
  /** Set when task reaches a terminal state */
  completedAt?: number
  content: string
  createdAt: number
  /** Set when task ends in error */
  error?: TaskErrorData
  files?: string[]
  /** Folder path for curate-folder tasks */
  folderPath?: string
  /** Log entry ID set by lifecycle hook after onTaskCreate */
  logId?: string
  /** Active model id at task creation time */
  model?: string
  /** Project path this task belongs to (for multi-project routing) */
  projectPath?: string
  /** Active provider id at task creation time */
  provider?: string
  /** Accumulated reasoning/thinking entries from `llmservice:thinking` + `llmservice:chunk` (type=reasoning). */
  reasoningContents?: ReasoningContentItem[]
  /** Final assistant response set by `llmservice:response` (overwrites on multi-step). */
  responseContent?: string
  /** Set on successful completion */
  result?: string
  /**
   * Snapshot of the project's review-disabled flag captured at task-create time.
   * Stamped once at the daemon boundary so daemon (CurateLogHandler) and agent
   * (curate-tool backups, dream review entries) observe the same value even if
   * the user toggles the flag mid-task.
   */
  reviewDisabled?: boolean
  /** LLM session id set alongside `responseContent` */
  sessionId?: string
  /** Set when agent picks up the task */
  startedAt?: number
  /** Lifecycle status — defaults to 'created' on construction */
  status?: TaskListItemStatus
  taskId: string
  /** Accumulated tool-call lifecycle entries from `llmservice:toolCall` + `:toolResult`. */
  toolCalls?: ToolCallEvent[]
  type: TaskType
  /** Workspace root (linked subdir or projectRoot if unlinked) */
  worktreeRoot?: string
}
