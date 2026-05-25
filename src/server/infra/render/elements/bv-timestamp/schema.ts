import {z} from 'zod'

/**
 * Zod schema for `<bv-timestamp>` attributes.
 *
 * Renders as `**Timestamp:**` inside the `## Raw Concept` section — the
 * date the concept's data represents (distinct from the file's
 * createdAt/updatedAt frontmatter, which is system-set). Free-form
 * string content (typically ISO-8601 or short date).
 */
export const BvTimestampAttributesSchema = z.object({}).passthrough()
