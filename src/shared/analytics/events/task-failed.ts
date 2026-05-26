/* eslint-disable camelcase */
import {z} from 'zod'

import {TASK_TYPE_VALUES} from '../task-types.js'

/**
 * Per-event schema for `task_failed`.
 *
 * Error path. The error message and stack trace are intentionally NOT
 * captured here: they may contain file paths, secrets, or user content.
 * Strict mode rejects any attempt to add `error_message` / `stack` later.
 *
 * Adding `error_class` / `error_code` would require extending
 * `ITaskLifecycleHook.onTaskError` to deliver the structured error object,
 * which is a separate ticket.
 */
export const TaskFailedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    task_id: z.string().min(1),
    task_type: z.enum(TASK_TYPE_VALUES),
  })
  .strict()

export type TaskFailedProps = z.infer<typeof TaskFailedSchema>
