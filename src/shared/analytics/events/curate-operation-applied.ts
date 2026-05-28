/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `curate_operation_applied`.
 *
 * Emitted by the daemon's `AnalyticsHook` (M12.2) once per successful curate
 * operation. Each operation carries the affected file's project-relative
 * path, its knowledge-tree address, review/impact metadata, and (M12.3) the
 * file's current-state frontmatter values for tags / keywords / related.
 *
 * Review tightening (M14 follow-up):
 * - `absolute_path` → `relative_path` for privacy + portability across hosts
 * - `keywords` / `tags` are now required arrays (default empty) so consumers
 *   don't have to special-case the "field absent" shape
 * - `related` stays optional and absent on DELETE / read-failure (file is
 *   gone or unreadable, no related-link source to harvest from)
 */
export const CurateOperationAppliedSchema = z
  .object({
    confidence: z.enum(['high', 'low']).optional(),
    impact: z.enum(['high', 'low']).optional(),
    keywords: z.array(z.string().max(256)).max(50),
    knowledge_path: z.string().min(1),
    needs_review: z.boolean(),
    operation_type: z.enum(['ADD', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT']),
    /** M16 follow-up: see task-created.ts for the rationale. */
    project_path_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    // TODO(M15.x): harmonise with the sibling `query_completed.read_paths_
    // _with_metadata[].related_paths` structured shape — current asymmetry
    // forces consumers to special-case parsing `related` between the two
    // events. Restructuring is its own ticket (consumer migration concern).
    related: z.array(z.string().max(256)).max(50).optional(),
    relative_path: z.string().min(1),
    tags: z.array(z.string().max(256)).max(50),
    task_id: z.string().min(1),
  })
  .strict()

export type CurateOperationAppliedProps = z.infer<typeof CurateOperationAppliedSchema>
