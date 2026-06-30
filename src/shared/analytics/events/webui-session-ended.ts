/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `webui_session_ended`.
 *
 * Matches a `webui_session_started` row via `started_at_unix_ms`.
 * `session_duration_ms` is computed daemon-side from `ClientInfo.connectedAt`.
 *
 * IMPORTANT: NO `session_id` field — that name is on `forbidden-field-names.ts`
 * and would be runtime-redacted by `redactRecord`. The `started_at_unix_ms`
 * Date.now() value at register time serves as the join key instead.
 */
export const WebuiSessionEndedSchema = z
  .object({
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    session_duration_ms: z.number().int().nonnegative(),
    started_at_unix_ms: z.number().int().nonnegative(),
  })
  .strict()

export type WebuiSessionEndedProps = z.infer<typeof WebuiSessionEndedSchema>
