/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `curate_run_completed`.
 *
 * Emitted by the daemon's `AnalyticsHook` (M12.2) at curate task terminal
 * states (completed / partial / cancelled / error). Carries per-task
 * operation counters so PMs can aggregate curate volume + outcome over time.
 */
export const CurateRunCompletedSchema = z
  .object({
    duration_ms: z.number().int().nonnegative(),
    operations_added: z.number().int().nonnegative(),
    operations_deleted: z.number().int().nonnegative(),
    operations_failed: z.number().int().nonnegative(),
    operations_merged: z.number().int().nonnegative(),
    operations_updated: z.number().int().nonnegative(),
    outcome: z.enum(['completed', 'partial', 'cancelled', 'error']),
    pending_review_count: z.number().int().nonnegative(),
    task_id: z.string().min(1),
    task_type: z.enum(['curate', 'curate-folder']),
  })
  .strict()

export type CurateRunCompletedProps = z.infer<typeof CurateRunCompletedSchema>
