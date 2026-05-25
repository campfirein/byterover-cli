import {z} from 'zod'

/**
 * Zod schema for `<bv-structure>` attributes.
 *
 * Renders as the `### Structure` subsection inside `## Narrative` —
 * structural or organizational documentation (file layout, process
 * hierarchy, timeline). No attributes.
 */
export const BvStructureAttributesSchema = z.object({}).passthrough()
