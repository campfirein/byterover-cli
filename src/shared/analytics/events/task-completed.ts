/* eslint-disable camelcase */
import {z} from 'zod'

import {TASK_TYPE_VALUES} from '../task-types.js'

/**
 * Per-event schema for `task_completed`.
 *
 * Successful task termination. The `result` payload (LLM output, search
 * results, curated content) is NEVER captured here — it is forbidden by
 * the privacy fixture.
 */
export const TaskCompletedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    task_id: z.string().min(1),
    task_type: z.enum(TASK_TYPE_VALUES),
  })
  .strict()

export type TaskCompletedProps = z.infer<typeof TaskCompletedSchema>
