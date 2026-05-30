import type {z} from 'zod'

import type {ElementNode, ValidationError, ValidationResult} from '../../../core/domain/render/element-types.js'

/**
 * Build an element validator from a tag name and a Zod attribute schema.
 *
 * Every element validator follows the same shape:
 *   1. Reject if `node.tagName` doesn't match the expected tag.
 *   2. Run the per-element Zod schema against `node.attributes`.
 *   3. Map any Zod issues to `ValidationError` records.
 *
 * Centralising the shape here means vocabulary expansion is purely
 * additive — each new element is a `schema.ts` + a one-line
 * `validator.ts` binding. No branching logic per element type
 * until/unless an element legitimately needs custom validation beyond
 * attributes.
 */
export function makeAttributeValidator(
  tagName: string,
  schema: z.ZodTypeAny,
): (node: ElementNode) => ValidationResult {
  return (node) => {
    if (node.tagName !== tagName) {
      const errors: ValidationError[] = [{
        field: 'tagName',
        message: `expected tagName "${tagName}", got "${node.tagName}"`,
      }]
      return {errors, valid: false}
    }

    const parsed = schema.safeParse(node.attributes)
    if (!parsed.success) {
      const errors: ValidationError[] = parsed.error.issues.map((issue) => ({
        field: issue.path.join('.') || 'attributes',
        message: issue.message,
      }))
      return {errors, valid: false}
    }

    return {valid: true}
  }
}
