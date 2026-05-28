import {makeAttributeValidator} from '../make-validator.js'
import {BvReasonAttributesSchema} from './schema.js'

export const validateBvReason = makeAttributeValidator('bv-reason', BvReasonAttributesSchema)
