/* eslint-disable camelcase */
import {z} from 'zod'

import {TASK_TYPE_VALUES} from '../task-types.js'

/**
 * Per related-path metadata. Each related entry is a project-relative
 * knowledge path captured from a read file's frontmatter `related` list,
 * carrying its own keywords / tags so PMs can see what the linked-from
 * topics actually cover.
 *
 * keywords / tags default to `[]` when the related file isn't on disk or
 * when analytics is disabled (no enrichment read happens). The shape is
 * structured here so a later FU can fill keywords/tags without a wire
 * format change.
 */
const RelatedPathWithMetadataSchema = z
  .object({
    keywords: z.array(z.string().max(256)).max(50),
    relative_path: z.string().min(1),
    tags: z.array(z.string().max(256)).max(50),
  })
  .strict()

/**
 * Per-file structure inside `query_completed.read_paths_with_metadata`.
 *
 * Review tightening (M14 follow-up):
 * - `absolute_path` → `relative_path` for privacy + portability
 * - `keywords` / `tags` are now required arrays (default `[]`) so the
 *   "field absent" wire shape goes away
 * - flat `related: string[]` → structured `related_paths: [{relative_path,
 *   keywords, tags}]` so each linked topic carries its own metadata
 */
const ReadPathWithMetadataSchema = z
  .object({
    keywords: z.array(z.string().max(256)).max(50),
    related_paths: z.array(RelatedPathWithMetadataSchema).max(50),
    relative_path: z.string().min(1),
    tags: z.array(z.string().max(256)).max(50),
  })
  .strict()

/**
 * Per-event schema for `query_completed`.
 *
 * Emitted by the daemon's `AnalyticsHook` (M12.2) at query task terminal
 * states (completed / cancelled / error). Carries duration, retrieval
 * tier hit, doc counts, and (M12.3) the per-file structure for the top-N
 * (max 10) files the agent read during the query.
 *
 * M14.2 migrated `task_type` from `z.literal('query')` to the canonical
 * `TASK_TYPE_VALUES` tuple so v4.0 tool-mode types (query-tool-mode)
 * round-trip the wire boundary. The hook is expected to only emit this
 * event for query flavors; the schema no longer structurally enforces
 * that and trusts the caller.
 */
export const QueryCompletedSchema = z
  .object({
    cache_hit: z.boolean(),
    duration_ms: z.number().int().nonnegative(),
    matched_doc_count: z.number().int().nonnegative(),
    outcome: z.enum(['completed', 'cancelled', 'error']),
    /** M16 follow-up: see task-created.ts for the rationale. */
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    read_doc_count: z.number().int().nonnegative(),
    read_paths_with_metadata: z.array(ReadPathWithMetadataSchema).max(10).optional(),
    read_tool_call_count: z.number().int().nonnegative(),
    search_call_count: z.number().int().nonnegative(),
    task_id: z.string().min(1),
    task_type: z.enum(TASK_TYPE_VALUES),
    tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })
  .strict()

export type QueryCompletedProps = z.infer<typeof QueryCompletedSchema>
