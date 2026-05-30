import {z} from 'zod'

/**
 * Zod schema for `<bv-fact>` attributes.
 *
 * Renders as a `## Facts` list entry. Mirrors the existing structured-fact
 * model (statement / category / subject / value):
 *   <bv-fact subject="user_name" category="personal" value="Andy">
 *     My name is Andy.
 *   </bv-fact>
 * The element's text content is the canonical statement; attributes are
 * the structured extraction.
 */
export const BvFactAttributesSchema = z.object({
  category: z.enum([
    'personal',
    'project',
    'preference',
    'convention',
    'team',
    'environment',
    'other',
  ]).optional(),
  subject: z.string().optional(),
  value: z.string().optional(),
}).passthrough()
