import {makeAttributeValidator} from '../make-validator.js'
import {BvBugAttributesSchema} from './schema.js'

/**
 * Validate a `<bv-bug>` element node. Light validation; strict per
 * ADR-007 §13 is future work.
 */
export const validateBvBug = makeAttributeValidator('bv-bug', BvBugAttributesSchema)
