/* eslint-disable camelcase */
import {z} from 'zod'

/**
 * Per-event schema for `curate_operation_applied`.
 *
 * Emitted by the daemon's `AnalyticsHook` (M12.2) once per successful curate
 * operation. Each operation carries the affected file's absolute path, its
 * knowledge-tree address, review/impact metadata, and (M12.3) the file's
 * current-state frontmatter values for tags / keywords / related.
 *
 * All three frontmatter arrays are optional and absent on DELETE operations
 * (the file is gone post-op) and on read failures (defensive).
 */
export const CurateOperationAppliedSchema = z
  .object({
    absolute_path: z.string().min(1),
    confidence: z.enum(['high', 'low']).optional(),
    impact: z.enum(['high', 'low']).optional(),
    keywords: z.array(z.string().max(256)).max(50).optional(),
    knowledge_path: z.string().min(1),
    needs_review: z.boolean(),
    operation_type: z.enum(['ADD', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT']),
    related: z.array(z.string().max(256)).max(50).optional(),
    tags: z.array(z.string().max(256)).max(50).optional(),
    task_id: z.string().min(1),
  })
  .strict()

export type CurateOperationAppliedProps = z.infer<typeof CurateOperationAppliedSchema>
