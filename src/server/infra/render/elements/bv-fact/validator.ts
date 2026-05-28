import {makeAttributeValidator} from '../make-validator.js'
import {BvFactAttributesSchema} from './schema.js'

export const validateBvFact = makeAttributeValidator('bv-fact', BvFactAttributesSchema)
