import {makeAttributeValidator} from '../make-validator.js'
import {BvRuleAttributesSchema} from './schema.js'

/**
 * Validate a `<bv-rule>` element node. Light validation; strict per
 * ADR-007 §13 is future work.
 */
export const validateBvRule = makeAttributeValidator('bv-rule', BvRuleAttributesSchema)
