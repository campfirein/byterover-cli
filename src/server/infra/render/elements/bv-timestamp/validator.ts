import {makeAttributeValidator} from '../make-validator.js'
import {BvTimestampAttributesSchema} from './schema.js'

export const validateBvTimestamp = makeAttributeValidator('bv-timestamp', BvTimestampAttributesSchema)
