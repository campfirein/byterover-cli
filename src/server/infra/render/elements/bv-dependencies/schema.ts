import {z} from 'zod'

/**
 * Zod schema for `<bv-dependencies>` attributes.
 *
 * Renders as the `### Dependencies` subsection inside `## Narrative` —
 * dependencies, prerequisites, blockers, or relationship information.
 * No attributes.
 */
export const BvDependenciesAttributesSchema = z.object({}).passthrough()
