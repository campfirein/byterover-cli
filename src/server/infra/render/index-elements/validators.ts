/**
 * Index-element validators. Each binds an attribute schema to the shared
 * `makeAttributeValidator` factory — the same factory the topic elements
 * use; it is element-agnostic (takes a tag name + a Zod schema).
 */

import {makeAttributeValidator} from '../elements/make-validator.js'
import {
  BvIndexAttributesSchema,
  BvIndexDescriptionAttributesSchema,
  BvIndexDomainAttributesSchema,
  BvIndexEntryAttributesSchema,
} from './schemas.js'

export const validateBvIndex = makeAttributeValidator('bv-index', BvIndexAttributesSchema)
export const validateBvIndexDomain = makeAttributeValidator('bv-index-domain', BvIndexDomainAttributesSchema)
export const validateBvIndexEntry = makeAttributeValidator('bv-index-entry', BvIndexEntryAttributesSchema)
export const validateBvIndexDescription = makeAttributeValidator(
  'bv-index-description',
  BvIndexDescriptionAttributesSchema,
)
