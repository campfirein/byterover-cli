import {makeAttributeValidator} from '../make-validator.js'
import {BvHighlightsAttributesSchema} from './schema.js'

export const validateBvHighlights = makeAttributeValidator('bv-highlights', BvHighlightsAttributesSchema)
