/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `setting_changed`.
 *
 * Carries `setting_key` only — NEVER the raw value, because a future
 * string-typed setting could carry paths or secrets. `value_kind`
 * discriminates the type bucket; `value_changed_from_default` is only
 * computable on success (optional). `outcome` covers both terminals.
 */
export const SettingChangedSchema = z
  .object({
    failure_kind: z.string().min(1).max(64).optional(),
    outcome: z.enum(['success', 'failure']),
    setting_key: z.string().min(1),
    value_changed_from_default: z.boolean().optional(),
    value_kind: z.enum(['integer', 'boolean']),
  })
  .strict()

export type SettingChangedProps = z.infer<typeof SettingChangedSchema>
