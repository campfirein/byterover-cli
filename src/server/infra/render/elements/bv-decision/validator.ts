import {makeAttributeValidator} from '../make-validator.js'
import {BvDecisionAttributesSchema} from './schema.js'

/**
 * Validate a `<bv-decision>` element node. Light validation; strict
 * per ADR-007 §13 is future work.
 */
export const validateBvDecision = makeAttributeValidator('bv-decision', BvDecisionAttributesSchema)
