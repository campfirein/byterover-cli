import {z} from 'zod'

/**
 * Zod schema for `<bv-changes>` attributes.
 *
 * Renders as `**Changes:**` inside the `## Raw Concept` section — a
 * list of changes (code, process, decision). Children should be `<li>`
 * items; the writer flattens them into a markdown list.
 */
export const BvChangesAttributesSchema = z.object({}).passthrough()
