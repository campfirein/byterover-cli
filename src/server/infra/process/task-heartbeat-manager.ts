/**
 * TaskHeartbeatManager
 *
 * Per-task liveness ticker. The task router calls `register` once the
 * task starts streaming events, `recordActivity` after every task-scoped
 * emission, and `recordTermination` on the three terminal `TaskEvents`
 * (`completed`, `error`, `cancelled`).
 *
 * The manager debounces a setTimeout so a quiet task (no other events)
 * fires `TaskEvents.HEARTBEAT` at `intervalMs`; a noisy task that keeps
 * receiving `recordActivity` resets the timer and never emits redundant
 * heartbeats. After emission the timer reschedules itself so a task
 * that stays quiet continues to be heard at the same cadence.
 *
 * Emission is delegated through the `emit` callback the daemon supplies
 * (typically `transport.sendTo(clientId, TaskEvents.HEARTBEAT, ...)`
 * plus `broadcastToProjectRoom(...)`); this module is transport-agnostic
 * so it stays trivially unit-testable.
 */

export type HeartbeatEmitter = (
  taskId: string,
  clientId: string,
  projectPath: string | undefined,
) => void

export interface TaskHeartbeatManagerOptions {
  readonly emit: HeartbeatEmitter
  readonly intervalMs: number
}

type TaskEntry = {
  readonly clientId: string
  readonly projectPath: string | undefined
  timer: NodeJS.Timeout
}

export class TaskHeartbeatManager {
  private readonly emit: HeartbeatEmitter
  private readonly intervalMs: number
  private readonly tasks = new Map<string, TaskEntry>()

  public constructor(options: TaskHeartbeatManagerOptions) {
    this.emit = options.emit
    this.intervalMs = options.intervalMs
  }

  /** Tear down every outstanding timer. Daemon shutdown hook. */
  public dispose(): void {
    for (const entry of this.tasks.values()) {
      clearTimeout(entry.timer)
    }

    this.tasks.clear()
  }

  /**
   * Reset the timer for `taskId` because another task-scoped event was
   * just emitted. No-op when the task was never registered.
   */
  public recordActivity(taskId: string): void {
    const entry = this.tasks.get(taskId)
    if (entry === undefined) return

    clearTimeout(entry.timer)
    entry.timer = this.schedule(taskId)
  }

  /**
   * Stop tracking the task. Called on the three terminal `TaskEvents`.
   * No-op when the task was never registered.
   */
  public recordTermination(taskId: string): void {
    this.clearExisting(taskId)
  }

  /**
   * Begin tracking a task. Schedules the first heartbeat after
   * `intervalMs` of quiet time. Idempotent: re-registering the same
   * `taskId` resets the timer and updates the cached clientId/path.
   */
  public register(taskId: string, clientId: string, projectPath: string | undefined): void {
    this.clearExisting(taskId)
    const timer = this.schedule(taskId)
    this.tasks.set(taskId, {clientId, projectPath, timer})
  }

  private clearExisting(taskId: string): void {
    const entry = this.tasks.get(taskId)
    if (entry === undefined) return
    clearTimeout(entry.timer)
    this.tasks.delete(taskId)
  }

  private fire(taskId: string): void {
    const entry = this.tasks.get(taskId)
    if (entry === undefined) return

    this.emit(taskId, entry.clientId, entry.projectPath)
    // Re-schedule so a task that stays quiet keeps emitting at cadence.
    entry.timer = this.schedule(taskId)
  }

  private schedule(taskId: string): NodeJS.Timeout {
    return setTimeout(() => {
      this.fire(taskId)
    }, this.intervalMs)
  }
}
