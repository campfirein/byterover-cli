import {z} from 'zod'

/**
 * Zod schema for `<bv-pattern>` attributes.
 *
 * Renders as a bullet entry inside `**Patterns:**` (under `## Raw Concept`).
 * The pattern itself is the element's text content; structured fields
 * (flags, description) are attributes. Multiple `<bv-pattern>` siblings
 * inside `<bv-topic>` are collected into a single bullet list.
 *
 *   <bv-pattern flags="g" description="Match an email">[\w.+-]+@[\w.-]+</bv-pattern>
 */
export const BvPatternAttributesSchema = z.object({
  description: z.string().optional(),
  flags: z.string().optional(),
}).passthrough()
