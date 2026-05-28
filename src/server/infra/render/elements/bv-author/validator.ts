import {makeAttributeValidator} from '../make-validator.js'
import {BvAuthorAttributesSchema} from './schema.js'

export const validateBvAuthor = makeAttributeValidator('bv-author', BvAuthorAttributesSchema)
