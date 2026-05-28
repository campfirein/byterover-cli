import {z} from 'zod'

/**
 * Zod schema for `<bv-decision>` attributes. Light validation;
 * `passthrough` tolerates unknown attributes (strict validation per
 * ADR-007 §13 is future work).
 */
export const BvDecisionAttributesSchema = z.object({
  id: z.string().min(1, {message: 'id must be non-empty if present'}).optional(),
}).passthrough()
