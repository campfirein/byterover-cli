import {makeAttributeValidator} from '../make-validator.js'
import {BvDiagramAttributesSchema} from './schema.js'

export const validateBvDiagram = makeAttributeValidator('bv-diagram', BvDiagramAttributesSchema)
