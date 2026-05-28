import {z} from 'zod'

/**
 * Zod schema for `<bv-flow>` attributes.
 *
 * Renders as `**Flow:**` inside the `## Raw Concept` section — the
 * process flow, workflow, or sequence of steps. No attributes.
 */
export const BvFlowAttributesSchema = z.object({}).passthrough()
