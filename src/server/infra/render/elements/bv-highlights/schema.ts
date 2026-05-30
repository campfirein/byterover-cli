import {z} from 'zod'

/**
 * Zod schema for `<bv-highlights>` attributes.
 *
 * Renders as the `### Highlights` subsection inside `## Narrative` —
 * key highlights, capabilities, deliverables, or notable outcomes.
 * No attributes.
 */
export const BvHighlightsAttributesSchema = z.object({}).passthrough()
