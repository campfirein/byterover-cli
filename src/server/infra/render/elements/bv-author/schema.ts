import {z} from 'zod'

/**
 * Zod schema for `<bv-author>` attributes.
 *
 * Renders as `**Author:**` inside the `## Raw Concept` section — the
 * person or system identifier responsible for the concept. Free-form
 * string content.
 */
export const BvAuthorAttributesSchema = z.object({}).passthrough()
