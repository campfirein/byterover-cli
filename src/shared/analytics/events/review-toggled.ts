/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `review_toggled`.
 *
 * User toggled HITL review on or off (`brv review enable` / `disable`).
 * `new_state` is only meaningful on success — optional.
 */
export const ReviewToggledSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    new_state: z.enum(['enabled', 'disabled']).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type ReviewToggledProps = z.infer<typeof ReviewToggledSchema>
