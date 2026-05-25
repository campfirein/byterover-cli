import {z} from 'zod'

/**
 * Zod schema for `<bv-reason>` attributes.
 *
 * Renders as the `## Reason` body section in the .md writer — the
 * curate operation's "why" stated for a human reviewer. Has no
 * attributes; the body text is the rendered content.
 */
export const BvReasonAttributesSchema = z.object({}).passthrough()
