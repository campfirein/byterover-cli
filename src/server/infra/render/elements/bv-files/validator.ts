import {makeAttributeValidator} from '../make-validator.js'
import {BvFilesAttributesSchema} from './schema.js'

export const validateBvFiles = makeAttributeValidator('bv-files', BvFilesAttributesSchema)
