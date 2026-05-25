import {makeAttributeValidator} from '../make-validator.js'
import {BvFlowAttributesSchema} from './schema.js'

export const validateBvFlow = makeAttributeValidator('bv-flow', BvFlowAttributesSchema)
