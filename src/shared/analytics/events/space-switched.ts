/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `space_switched`.
 *
 * Active Context Hub space changed. `to_space_id` only set on success
 * (the switch landed). `from_space_id` is always known at request time.
 */
export const SpaceSwitchedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    from_space_id: z.string().min(1),
    outcome: z.enum(['success', 'failure']),
    to_space_id: z.string().min(1).optional(),
  })
  .strict()

export type SpaceSwitchedProps = z.infer<typeof SpaceSwitchedSchema>
