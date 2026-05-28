/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `mcp_session_ended`.
 *
 * Mirrors `webui_session_ended` (M15.5) for the MCP transport. Fires when
 * a client of type `mcp` disconnects from the daemon (or is orphan-ended
 * on reconnect). Pairs with a prior `mcp_session_start` via
 * `started_at_unix_ms`. `client_name` is the IDE product name captured
 * during the MCP `oninitialized` handshake.
 *
 * IMPORTANT: NO `session_id` field — that name is on `forbidden-field-names.ts`
 * and would be runtime-redacted. `started_at_unix_ms` (the connectedAt
 * Date.now() value) serves as the join key.
 */
export const McpSessionEndedSchema = z
  .object({
    client_name: z.string().min(1),
    session_duration_ms: z.number().int().nonnegative(),
    started_at_unix_ms: z.number().int().nonnegative(),
  })
  .strict()

export type McpSessionEndedProps = z.infer<typeof McpSessionEndedSchema>
