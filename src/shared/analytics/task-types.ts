 

/**
 * Canonical wire-format values for `task_type` on task_* analytics events.
 * Mirrors the daemon's `TaskInfo.type` union (see
 * server/core/domain/transport/task-info.ts).
 *
 * Adding a new daemon task type REQUIRES adding it here so per-event schemas
 * accept it; otherwise the analytics hook will silently emit an event that
 * fails wire-side validation.
 */
export const TaskTypes = {
  CURATE: 'curate',
  CURATE_FOLDER: 'curate-folder',
  DREAM: 'dream',
  QUERY: 'query',
  SEARCH: 'search',
} as const

export type TaskType = (typeof TaskTypes)[keyof typeof TaskTypes]

/**
 * Tuple form of TaskTypes used as a runtime list (e.g. `z.enum(TASK_TYPE_VALUES)`).
 * Single source of truth: per-event schemas import this instead of redeclaring
 * the literal array, so adding a new daemon task type is a one-place change.
 */
export const TASK_TYPE_VALUES = [
  TaskTypes.CURATE,
  TaskTypes.CURATE_FOLDER,
  TaskTypes.DREAM,
  TaskTypes.QUERY,
  TaskTypes.SEARCH,
] as const
