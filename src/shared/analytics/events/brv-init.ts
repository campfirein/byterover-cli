/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `brv_init`.
 *
 * Activation-funnel entry: `brv init` ran on a project (success or failure).
 * `project_path_hash` = sha256 of the absolute project path (raw paths
 * are forbidden); `had_existing_brv_dir` separates "first-touch" from
 * "re-init" funnels. `outcome` covers both terminals; `failure_kind` is a
 * coarse tag — never a raw error message.
 */
export const BrvInitSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    had_existing_brv_dir: z.boolean(),
    outcome: z.enum(['success', 'failure']),
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()

export type BrvInitProps = z.infer<typeof BrvInitSchema>
