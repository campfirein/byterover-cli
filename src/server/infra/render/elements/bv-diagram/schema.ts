import {z} from 'zod'

/**
 * Zod schema for `<bv-diagram>` attributes.
 *
 * Renders verbatim into the `### Diagrams` subsection — preserves
 * mermaid / plantuml / ascii / dot diagrams character-for-character
 * (per the curate detail-preservation contract). The `type` attribute
 * tells the writer which fenced-code-block language tag to emit.
 */
export const BvDiagramAttributesSchema = z.object({
  title: z.string().optional(),
  type: z.enum(['mermaid', 'plantuml', 'ascii', 'dot', 'graphviz', 'other']).optional(),
}).passthrough()
