import {z} from 'zod'

/**
 * Zod schema for `<bv-files>` attributes.
 *
 * Renders as `**Files:**` inside the `## Raw Concept` section — a list
 * of related source files, documents, URLs, or references. Children
 * should be `<li>` items.
 */
export const BvFilesAttributesSchema = z.object({}).passthrough()
