import type {TaskExecute} from '../../domain/transport/schemas.js'

/**
 * Result of submitting a task to the pool.
 * Uses discriminated union (success field) instead of thrown errors.
 */
export type SubmitTaskResult =
  | {message: string; reason: 'create_failed' | 'invalid_task' | 'pool_full'; success: false}
  | {success: true}

/**
 * Read-only snapshot of a managed agent entry for monitoring.
 */
export type AgentEntryInfo = {
  /** Number of currently executing tasks */
  readonly activeTasks: number
  /** Child process PID (-1 if process hasn't started yet or has exited) */
  readonly childPid: number
  readonly createdAt: number
  readonly hasActiveTask: boolean
  readonly isIdle: boolean
  readonly lastUsedAt: number
  readonly projectPath: string
}

/**
 * Manages up to N forked child process agents, one per active project.
 *
 * Each agent is a separate Node.js process (child_process.fork())
 * associated with a projectPath. When the pool is full, new projects
 * are rejected with `pool_full`. Existing agents can still queue tasks.
 * Idle agents are cleaned up by AgentIdleTimeoutPolicy after inactivity.
 *
 * Pool is pure lifecycle management — zero knowledge of auth, project config,
 * or agent internals. Each child process handles all agent setup independently.
 *
 * Consumed by:
 * - brv-server.ts: instantiation and wiring
 * - TransportHandlers: delegates task submission via submitTask()
 * - ClientManager.onProjectEmpty → markIdle() for idle cleanup
 */
export interface IAgentPool {
  /**
   * Remove a queued task by taskId from any project's FIFO queue.
   * Returns true when the task was found and removed; false when the task
   * is not in any queue (either it never queued, or it is currently in flight).
   *
   * Used by the cancel pipeline to short-circuit queued cancellations without
   * forwarding the request to an agent that has no controller for the task.
   *
   * @param taskId - Task identifier to remove from queues
   */
  cancelQueuedTask(taskId: string): boolean

  /**
   * Get pool entries for monitoring/debugging.
   */
  getEntries(): readonly AgentEntryInfo[]

  /**
   * Get current pool size (number of managed agents).
   */
  getSize(): number

  /**
   * Handle agent socket disconnection.
   * Removes the agent from the pool and stops the child process.
   * Called by TransportHandlers when an agent's Socket.IO client disconnects.
   * Without this, the pool retains a stale clientId and tasks sent to it are lost.
   */
  handleAgentDisconnected(projectPath: string): void

  /**
   * Check if the pool has an agent for a given project.
   */
  hasAgent(projectPath: string): boolean

  /**
   * Mark a project's agent as idle (no external clients).
   * Called by wiring code in response to ClientManager.onProjectEmpty.
   * Idle agents are candidates for cleanup by AgentIdleTimeoutPolicy.
   */
  markIdle(projectPath: string): void

  /**
   * Notify pool that a task has completed (or errored) for a project.
   * Clears busy flag and drains queued tasks for the project.
   * Called by TransportHandlers on task:completed / task:error events.
   */
  notifyTaskCompleted(projectPath: string): void

  /**
   * Graceful shutdown: stop all agent processes and clear the pool.
   * Called during daemon shutdown sequence.
   */
  shutdown(): Promise<void>

  /**
   * Submit a task for execution.
   *
   * The pool acquires or forks an agent process for the task's project,
   * then sends the task via the transport server. If the agent is busy,
   * the task is queued in a per-project FIFO queue.
   */
  submitTask(task: TaskExecute): Promise<SubmitTaskResult>
}
