import {makeAttributeValidator} from '../make-validator.js'
import {BvFixAttributesSchema} from './schema.js'

/**
 * Validate a `<bv-fix>` element node. Light validation; strict per
 * ADR-007 §13 is future work.
 */
export const validateBvFix = makeAttributeValidator('bv-fix', BvFixAttributesSchema)
