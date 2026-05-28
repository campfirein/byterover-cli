import {makeAttributeValidator} from '../make-validator.js'
import {BvStructureAttributesSchema} from './schema.js'

export const validateBvStructure = makeAttributeValidator('bv-structure', BvStructureAttributesSchema)
