/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `setting_reset`.
 *
 * Symmetric with `setting_changed`; does NOT carry the value.
 */
export const SettingResetSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    setting_key: z.string().min(1),
    value_kind: z.enum(['integer', 'boolean']),
  })
  .strict()

export type SettingResetProps = z.infer<typeof SettingResetSchema>
