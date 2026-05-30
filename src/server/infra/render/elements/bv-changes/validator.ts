import {makeAttributeValidator} from '../make-validator.js'
import {BvChangesAttributesSchema} from './schema.js'

export const validateBvChanges = makeAttributeValidator('bv-changes', BvChangesAttributesSchema)
