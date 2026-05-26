/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `mcp_tool_called`.
 *
 * Captures the funnel for IDE-driven tool invocations (`brv-query`,
 * `brv-curate`). User-supplied tool arguments (the query text, curate goal,
 * file paths) are NEVER captured — only universal metadata.
 */
export const McpToolCalledSchema = z
  .object({
    client_name: z.string().min(1),
    duration_ms: z.number().int().nonnegative(),
    success: z.boolean(),
    tool_name: z.enum(['brv-query', 'brv-curate']),
  })
  .strict()

export type McpToolCalledProps = z.infer<typeof McpToolCalledSchema>
