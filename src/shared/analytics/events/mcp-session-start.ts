/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `mcp_session_start`.
 *
 * `client_name` is the IDE's self-reported product name (e.g. "Cursor",
 * "Claude Code"), captured via the MCP `oninitialized` handshake. It is
 * never a person's name; the field is named for the MCP client identity,
 * not user identity.
 */
export const McpSessionStartSchema = z
  .object({
    client_name: z.string().min(1),
  })
  .strict()

export type McpSessionStartProps = z.infer<typeof McpSessionStartSchema>
