/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `review_approved`.
 *
 * HITL review: user approved a pending curate operation.
 * `operation_kind` is the curate operation discriminator.
 */
export const ReviewApprovedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    operation_kind: z.string().min(1),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type ReviewApprovedProps = z.infer<typeof ReviewApprovedSchema>
