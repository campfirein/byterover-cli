import {makeAttributeValidator} from '../make-validator.js'
import {BvDependenciesAttributesSchema} from './schema.js'

export const validateBvDependencies = makeAttributeValidator('bv-dependencies', BvDependenciesAttributesSchema)
