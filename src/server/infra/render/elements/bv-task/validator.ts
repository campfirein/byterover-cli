import {makeAttributeValidator} from '../make-validator.js'
import {BvTaskAttributesSchema} from './schema.js'

export const validateBvTask = makeAttributeValidator('bv-task', BvTaskAttributesSchema)
