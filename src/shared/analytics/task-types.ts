 

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
  CURATE_TOOL_MODE: 'curate-tool-mode',
  DREAM: 'dream',
  DREAM_FINALIZE: 'dream-finalize',
  DREAM_SCAN: 'dream-scan',
  QUERY: 'query',
  QUERY_TOOL_MODE: 'query-tool-mode',
  SEARCH: 'search',
  /**
   * Drift sentinel — emitted by `AnalyticsHook.toAnalyticsTaskType` when the
   * daemon dispatches a type that isn't enumerated above. Lives in the
   * canonical vocabulary so the wire-side `z.enum(TASK_TYPE_VALUES)` accepts
   * the row at the backend instead of dropping it. The daemon-side
   * `processLog` warning is the actual signal — `'unknown'` on the wire is
   * the breadcrumb the backend can group on.
   */
  UNKNOWN: 'unknown',
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
  TaskTypes.CURATE_TOOL_MODE,
  TaskTypes.DREAM,
  TaskTypes.DREAM_FINALIZE,
  TaskTypes.DREAM_SCAN,
  TaskTypes.QUERY,
  TaskTypes.QUERY_TOOL_MODE,
  TaskTypes.SEARCH,
  TaskTypes.UNKNOWN,
] as const
