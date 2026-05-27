/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `review_rejected`.
 *
 * Mirrors `review_approved` shape so downstream consumers can compute
 * per-operation approve/reject ratios.
 */
export const ReviewRejectedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    operation_kind: z.string().min(1),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type ReviewRejectedProps = z.infer<typeof ReviewRejectedSchema>
