import {z} from 'zod'

/**
 * Zod schema for `<bv-task>` attributes.
 *
 * Renders as `**Task:**` inside the `## Raw Concept` section — the
 * subject/task this concept relates to. No attributes.
 */
export const BvTaskAttributesSchema = z.object({}).passthrough()
