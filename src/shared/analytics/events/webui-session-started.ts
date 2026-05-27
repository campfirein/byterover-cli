/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `webui_session_started`.
 *
 * Fires when a browser dashboard connects to the daemon over Socket.IO.
 * `started_at_unix_ms` (Date.now()) is the join key with the matching
 * `webui_session_ended` row.
 *
 * IMPORTANT: NO `session_id` field — see `webui-session-ended.ts`.
 */
export const WebuiSessionStartedSchema = z
  .object({
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    started_at_unix_ms: z.number().int().nonnegative(),
  })
  .strict()

export type WebuiSessionStartedProps = z.infer<typeof WebuiSessionStartedSchema>
