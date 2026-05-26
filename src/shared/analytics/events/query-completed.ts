/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-file structure inside `query_completed.read_paths_with_metadata`.
 * Frontmatter arrays are optional and absent when the daemon cannot read
 * the file (ENOENT, parse failure) — `absolute_path` alone still tells
 * PMs which file the agent touched.
 */
const ReadPathWithMetadataSchema = z
  .object({
    absolute_path: z.string().min(1),
    keywords: z.array(z.string().max(256)).max(50).optional(),
    related: z.array(z.string().max(256)).max(50).optional(),
    tags: z.array(z.string().max(256)).max(50).optional(),
  })
  .strict()

/**
 * Per-event schema for `query_completed`.
 *
 * Emitted by the daemon's `AnalyticsHook` (M12.2) at query task terminal
 * states (completed / cancelled / error). Carries duration, retrieval
 * tier hit, doc counts, and (M12.3) the per-file structure for the top-N
 * (max 10) files the agent read during the query.
 */
export const QueryCompletedSchema = z
  .object({
    cache_hit: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
    matched_doc_count: z.number().int().nonnegative(),
    outcome: z.enum(['completed', 'cancelled', 'error']),
    read_doc_count: z.number().int().nonnegative(),
    read_paths_with_metadata: z.array(ReadPathWithMetadataSchema).max(10).optional(),
    read_tool_call_count: z.number().int().nonnegative(),
    search_call_count: z.number().int().nonnegative(),
    task_id: z.string().min(1),
    task_type: z.literal('query'),
    tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })
  .strict()

export type QueryCompletedProps = z.infer<typeof QueryCompletedSchema>
