/* eslint-disable camelcase */
import {z} from 'zod'

import {TASK_TYPE_VALUES} from '../task-types.js'

/**
 * Per-event schema for `curate_run_completed`.
 *
 * Emitted by the daemon's `AnalyticsHook` (M12.2) at curate task terminal
 * states (completed / partial / cancelled / error). Carries per-task
 * operation counters so PMs can aggregate curate volume + outcome over time.
 *
 * M14.2 migrated `task_type` from a literal ['curate', 'curate-folder']
 * enum to the canonical `TASK_TYPE_VALUES` tuple so v4.0 tool-mode types
 * (curate-tool-mode) round-trip the wire boundary. The hook is expected
 * to only emit this event for curate flavors; the schema no longer
 * structurally enforces that and trusts the caller.
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
    /** M17 follow-up: see task-created.ts for the rationale. */
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /**
     * Active Context Hub space ID for the project, when connected. Sourced
     * from `.brv/config.json#spaceId` at emit time. Omitted (not empty
     * string) when the project is standalone or the lookup fails — never
     * blocks an emit on space metadata.
     */
    space_id: z.string().min(1).max(64).optional(),
    task_id: z.string().min(1),
    task_type: z.enum(TASK_TYPE_VALUES),
    /**
     * Active team ID for the project, when connected. Independent of
     * `space_id` — a project can have a team without a space (intermediate
     * onboarding state). Same opaque-ID shape and emit semantics.
     */
    team_id: z.string().min(1).max(64).optional(),
  })
  .strict()

export type CurateRunCompletedProps = z.infer<typeof CurateRunCompletedSchema>
