/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `vc_pushed`.
 *
 * See `vc-pulled.ts` for the rationale on `branch_name_hash`.
 */
export const VcPushedSchema = z
  .object({
    branch_name_hash: z.string().regex(/^[0-9a-f]{64}$/),
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
    remote_kind: z.enum(['byterover', 'external']),
  })
  .strict()

export type VcPushedProps = z.infer<typeof VcPushedSchema>
