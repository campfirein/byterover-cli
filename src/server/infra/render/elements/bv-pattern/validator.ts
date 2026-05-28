import {makeAttributeValidator} from '../make-validator.js'
import {BvPatternAttributesSchema} from './schema.js'

export const validateBvPattern = makeAttributeValidator('bv-pattern', BvPatternAttributesSchema)
