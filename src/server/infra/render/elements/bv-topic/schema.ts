import {z} from 'zod'

/**
 * Zod schema for `<bv-topic>` attributes.
 *
 * `<bv-topic>` carries the topic file's frontmatter as attributes. The
 * markdown writer maps these directly to YAML frontmatter on disk.
 *
 * Reserved attributes — `importance`, `maturity`, `recency`,
 * `createdat`, `updatedat` — are explicitly rejected by the schema so
 * the model gets a structured `attribute-validation` error instead of
 * silently passing them through to the writer's regex overlay. Per the
 * runtime-signals migration, ranking signals are sidecar state
 * (per-user, per-machine), not file content, and the system writes
 * timestamps — the LLM does not.
 *
 * `passthrough` remains for non-reserved unknown attributes: light
 * validation is permissive (parse-and-skip — no warning emitted).
 * Strict validation per ADR-007 §13 is future work.
 */
const RESERVED_TOPIC_ATTRIBUTES = ['importance', 'maturity', 'recency', 'createdat', 'updatedat'] as const

export const BvTopicAttributesSchema = z.object({
  // Comma-separated lists are the natural HTML-attribute encoding for
  // arrays. The writer splits on `,` and trims; empty list is `""`.
  keywords: z.string().optional(),
  path: z.string().min(1, {message: 'path is required and must be non-empty'}),
  related: z.string().optional(),
  summary: z.string().optional(),
  tags: z.string().optional(),
  title: z.string().min(1, {message: 'title is required and must be non-empty'}),
}).passthrough().superRefine((attrs, ctx) => {
  for (const key of RESERVED_TOPIC_ATTRIBUTES) {
    if (key in attrs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `\`${key}\` is system-managed and must not be set on <bv-topic>`,
        path: [key],
      })
    }
  }
})
