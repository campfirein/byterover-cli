import {z} from 'zod'

/**
 * Zod schema for `<bv-examples>` attributes.
 *
 * Renders as the `### Examples` subsection inside `## Narrative` —
 * worked examples, sample code, or scenario walkthroughs. No attributes.
 */
export const BvExamplesAttributesSchema = z.object({}).passthrough()
