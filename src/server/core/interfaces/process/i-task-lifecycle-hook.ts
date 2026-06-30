import type {LlmToolResultEvent} from '../../domain/transport/schemas.js'
import type {TaskInfo} from '../../domain/transport/task-info.js'

/**
 * Hook interface for observing task lifecycle events.
 *
 * All methods are optional — implement only the events you care about.
 * Implementations must never throw; errors should be handled internally.
 *
 * Design: TaskRouter accepts lifecycleHooks[] so new hooks (e.g. QueryLogHandler)
 * can be added without modifying TaskRouter.
 */
export interface ITaskLifecycleHook {
  /** Called after onTaskCompleted, onTaskError, or onTaskCancelled to release in-memory resources. */
  cleanup?(taskId: string): void
  /**
   * Synchronous hook called just before task:completed is emitted.
   * Returns extra data to merge into the task:completed payload (e.g. {pendingReviewCount: 2}).
   * Must be synchronous and must not throw.
   */
  getTaskCompletionData?(taskId: string): Record<string, unknown>
  /** Called when a task is cancelled by the user. Distinct from onTaskError. */
  onTaskCancelled?(taskId: string, task: TaskInfo): Promise<void>
  /** Called when a task completes successfully. */
  onTaskCompleted?(taskId: string, result: string, task: TaskInfo): Promise<void>
  /** Called when a new task is created. Return {logId} to associate a log entry with the task. */
  onTaskCreate?(task: TaskInfo): Promise<void | {logId?: string}>
  /** Called when a task fails with an error. */
  onTaskError?(taskId: string, errorMessage: string, task: TaskInfo): Promise<void>
  /**
   * Called by the throttled flush (~100ms window) for in-flight task mutations
   * — `task:started` transition + every `llmservice:*` accumulator update.
   * Optional: existing handlers (CurateLogHandler, QueryLogHandler) don't
   * implement it. Implementations must never throw.
   */
  onTaskUpdate?(task: TaskInfo): Promise<void>
  /**
   * Called when an LLM tool result event is received for an ACTIVE task (not grace-period).
   * Now async so implementations (e.g. AnalyticsHook) can do non-blocking I/O without
   * wedging the daemon event loop. TaskRouter awaits the returned promise inside its
   * per-hook try/catch so rejections cannot escape as unhandled rejections.
   */
  onToolResult?(taskId: string, payload: LlmToolResultEvent): Promise<void>
}
