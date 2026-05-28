/**
 * Build a `TaskHistoryEntry` from a live `TaskInfo`. Single source of truth
 * for `task-router.ts:handleTaskGet` (in-memory synthesis) and
 * `task-history-hook.ts:persist` (lifecycle persistence) — extracting it here
 * eliminates the duplicate `baseFromTaskInfo` + `statusShapeFromTaskInfo`
 * pair that previously lived in both modules and would silently drift.
 *
 * Two functions are exposed:
 * - `buildTaskHistoryEntry(task)` — full Zod-parsed `TaskHistoryEntry`,
 *   used by `task-router.handleTaskGet` to return the same shape as
 *   `store.getById` for in-flight tasks. Returns `undefined` when the
 *   `TaskInfo` is incomplete (e.g. missing `projectPath`) or when the
 *   inferred shape fails Zod validation.
 * - `buildTaskHistoryEntryCandidate({task, override})` — pre-Zod object
 *   used by the lifecycle hook, which sometimes injects branch-specific
 *   fields (terminal completedAt / error / result) before validation.
 */

import type {TaskInfo} from '../../core/domain/transport/task-info.js'

import {TASK_HISTORY_ID_PREFIX} from '../../constants.js'
import {
  TASK_HISTORY_SCHEMA_VERSION,
  type TaskHistoryEntry,
  TaskHistoryEntrySchema,
} from '../../core/domain/entities/task-history-entry.js'

/** Build the base shape (fields shared by every status branch). */
function baseFromTaskInfo(task: TaskInfo): Record<string, unknown> {
  return {
    content: task.content,
    createdAt: task.createdAt,
    id: `${TASK_HISTORY_ID_PREFIX}-${task.taskId}`,
    projectPath: task.projectPath,
    schemaVersion: TASK_HISTORY_SCHEMA_VERSION,
    taskId: task.taskId,
    type: task.type,
    ...(task.clientCwd === undefined ? {} : {clientCwd: task.clientCwd}),
    ...(task.files === undefined ? {} : {files: task.files}),
    ...(task.folderPath === undefined ? {} : {folderPath: task.folderPath}),
    ...(task.logId === undefined ? {} : {logId: task.logId}),
    ...(task.model === undefined ? {} : {model: task.model}),
    ...(task.provider === undefined ? {} : {provider: task.provider}),
    ...(task.reasoningContents === undefined ? {} : {reasoningContents: task.reasoningContents}),
    ...(task.responseContent === undefined ? {} : {responseContent: task.responseContent}),
    ...(task.sessionId === undefined ? {} : {sessionId: task.sessionId}),
    // PR #728 review fix (M17): tool-mode dispatch forges synthetic
    // `llmservice:toolCall` envelopes so AnalyticsHook can read them off
    // task.toolCalls — but those entries MUST NOT surface in persisted
    // history or the WebUI task-detail panel as if they were real LLM tool
    // calls. The accumulator stamps them with `_synthetic: true`; strip
    // here so history sees only the LLM-driven calls.
    ...(task.toolCalls === undefined
      ? {}
      : {toolCalls: task.toolCalls.filter((c) => c._synthetic !== true)}),
    ...(task.worktreeRoot === undefined ? {} : {worktreeRoot: task.worktreeRoot}),
  }
}

/**
 * Build the per-branch shape inferred from `task.status`. Override-only
 * paths (terminal hooks) supply their own status; this is the default for
 * in-flight transitions.
 */
function statusShapeFromTaskInfo(task: TaskInfo): Record<string, unknown> {
  switch (task.status) {
    case 'cancelled':
    case 'completed': {
      return {
        completedAt: task.completedAt ?? Date.now(),
        status: task.status,
        ...(task.startedAt === undefined ? {} : {startedAt: task.startedAt}),
        ...(task.status === 'completed' && task.result !== undefined ? {result: task.result} : {}),
      }
    }

    case 'error': {
      return {
        completedAt: task.completedAt ?? Date.now(),
        error: task.error ?? {code: 'TASK_ERROR', message: 'unknown error', name: 'TaskError'},
        status: 'error',
        ...(task.startedAt === undefined ? {} : {startedAt: task.startedAt}),
      }
    }

    case 'started': {
      return {startedAt: task.startedAt ?? task.createdAt, status: 'started'}
    }

    // 'created' or undefined — minimal base, no extra branch fields.
    default: {
      return {status: 'created'}
    }
  }
}

/**
 * Build the pre-validation candidate object. The lifecycle hook calls this
 * with an `override` to inject terminal-status fields before Zod-parsing.
 */
export function buildTaskHistoryEntryCandidate(args: {
  override?: Record<string, unknown>
  task: TaskInfo
}): Record<string, unknown> {
  const {override, task} = args
  if (override !== undefined) {
    return {...baseFromTaskInfo(task), ...statusShapeFromTaskInfo(task), ...override}
  }

  return {...baseFromTaskInfo(task), ...statusShapeFromTaskInfo(task)}
}

/**
 * Build a fully-validated `TaskHistoryEntry` from in-memory `TaskInfo`.
 * Returns `undefined` when `task.projectPath` is missing or when the
 * candidate fails Zod validation.
 *
 * Used by `task-router.handleTaskGet` to return live in-flight tasks in the
 * same shape `store.getById` would have returned for persisted ones.
 */
export function buildTaskHistoryEntry(task: TaskInfo): TaskHistoryEntry | undefined {
  if (task.projectPath === undefined) return undefined
  const candidate = buildTaskHistoryEntryCandidate({task})
  const parsed = TaskHistoryEntrySchema.safeParse(candidate)
  return parsed.success ? parsed.data : undefined
}
