import type {Task, TaskStatus} from '../stores/tasks-store.js'

/** Terminal statuses — tasks in these states can no longer be cancelled. */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['cancelled', 'completed', 'error'])

/**
 * Pick the taskId Ctrl+Q should target.
 *
 * Policy: prefer the currently-running task over any queued task, and within
 * each group prefer the OLDEST. Rationale: when a user has several curate
 * tasks in flight and presses Ctrl+Q, the natural expectation is "stop what
 * is happening now" — which is the running task occupying the agent slot.
 * Cancelling it frees the slot so the next queued task starts immediately.
 * The previous "most recent non-terminal" policy violated this intuition
 * by silently cancelling whichever task was submitted last instead of the
 * one the user perceived as active.
 *
 * Returns undefined when nothing is cancellable. Pure function — extracted
 * from the React hook so it can be unit-tested without Ink.
 */
export function selectCancelTargetTaskId(tasks: ReadonlyMap<string, Task>): string | undefined {
  // Two-pass: first scan for a `started` task (running), then fall back to
  // any non-terminal task (covers `created`/queued).
  let runningCandidate: Task | undefined
  let queuedCandidate: Task | undefined
  for (const task of tasks.values()) {
    if (TERMINAL_STATUSES.has(task.status)) continue
    if (task.status === 'started') {
      if (!runningCandidate || task.createdAt < runningCandidate.createdAt) {
        runningCandidate = task
      }
    } else if (!queuedCandidate || task.createdAt < queuedCandidate.createdAt) {
      queuedCandidate = task
    }
  }

  return (runningCandidate ?? queuedCandidate)?.taskId
}
