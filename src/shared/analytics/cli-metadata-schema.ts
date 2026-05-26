/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Shared schema for the `cli_metadata` block. Source of truth for two
 * call sites:
 *
 * 1. As the per-event analytics schema for `cli_invocation` (re-exported
 *    by `events/cli-invocation.ts` for catalog registration).
 * 2. Wrapped as `CliRequestBaseSchema` so every client-originated request
 *    schema in M13.2 can extend it and carry the optional block.
 *
 * Strict mode rejects accidental extra fields at parse / emit time. The
 * eight fields are all CLI-process detections the daemon cannot infer.
 * Field NAMES verified outside `FORBIDDEN_FIELD_NAMES`.
 */
export const CliMetadataSchema = z
  .object({
    client_sent_at: z.number().int().nonnegative(),
    command_id: z.string().min(1),
    flag_names: z.array(z.string()),
    is_ci: z.boolean(),
    is_tty: z.boolean(),
    package_manager: z.enum(['npm', 'yarn', 'pnpm', 'bun', 'unknown']),
    runtime: z.enum(['node', 'bun']),
    terminal_program: z.string().min(1).optional(),
  })
  .strict()

/**
 * Wrapper every client-originated request schema will extend (M13.2 sweep).
 * The `cli_metadata` block is always optional — non-CLI clients (TUI, MCP,
 * webui) keep working without filling it.
 */
export const CliRequestBaseSchema = z.object({
  cli_metadata: CliMetadataSchema.optional(),
})

/**
 * Inferred type with index signature so it satisfies
 * `IAnalyticsClient.track`'s `properties?: Record<string, unknown>` parameter
 * without any `as` cast or spread workaround at the emit site.
 */
export type CliMetadata = Record<string, unknown> & z.infer<typeof CliMetadataSchema>

export type CliRequestBase = z.infer<typeof CliRequestBaseSchema>
