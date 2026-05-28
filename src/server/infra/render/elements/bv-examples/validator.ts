import {makeAttributeValidator} from '../make-validator.js'
import {BvExamplesAttributesSchema} from './schema.js'

export const validateBvExamples = makeAttributeValidator('bv-examples', BvExamplesAttributesSchema)
