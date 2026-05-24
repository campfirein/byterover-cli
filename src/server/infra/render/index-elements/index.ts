/**
 * Public surface for the context-tree index vocabulary.
 *
 * The index (`index.html`) is a navigation artifact with its own
 * 4-element vocabulary, disjoint from the topic vocabulary. Task 2's
 * `IndexGenerator` and any future consumer import from here.
 */

export {INDEX_ELEMENT_REGISTRY} from './registry.js'
export {
  BvIndexAttributesSchema,
  BvIndexDescriptionAttributesSchema,
  BvIndexDomainAttributesSchema,
  BvIndexEntryAttributesSchema,
} from './schemas.js'
export {INDEX_ELEMENT_NAMES, type IndexElementName, type IndexElementRegistry, type IndexElementSchema} from './types.js'
export {
  type IndexValidationError,
  type IndexValidationResult,
  validateHtmlIndex,
} from './validate-html-index.js'
