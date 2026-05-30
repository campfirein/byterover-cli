/**
 * Type contract for the context-tree index vocabulary.
 *
 * The index (`index.html`) is a navigation artifact, NOT a knowledge
 * topic. Its element vocabulary is deliberately kept disjoint from the
 * topic vocabulary (`core/domain/render/element-types.ts`): the topic
 * validator, the BM25 indexer, and the query renderer all assume their
 * elements describe knowledge. Index elements describe navigation.
 *
 * Four elements:
 *   bv-index             — document root; project header.
 *   bv-index-domain      — one section per category/domain.
 *   bv-index-entry       — one per topic; carries the routing path.
 *   bv-index-description — freeform prose block (defined for forward
 *                          compatibility; the v1 generator emits none).
 */

import type {ElementNode, ValidationResult} from '../../../core/domain/render/element-types.js'

/** The closed index-element vocabulary. */
export const INDEX_ELEMENT_NAMES = [
  'bv-index',
  'bv-index-domain',
  'bv-index-entry',
  'bv-index-description',
] as const

export type IndexElementName = (typeof INDEX_ELEMENT_NAMES)[number]

/**
 * Per-element registry entry for the index vocabulary. Structurally a
 * mirror of the topic layer's `ElementSchema`, but `name` is typed to
 * `IndexElementName` so the two registries never silently merge.
 */
export type IndexElementSchema = {
  /** Allowed-children semantic hint. Informational. */
  allowedChildren: 'any' | 'block' | 'inline' | 'none'
  /** Human-readable description. */
  description: string
  name: IndexElementName
  /** Optional attribute names. Informational; the validator enforces. */
  optionalAttributes: readonly string[]
  /** Required attribute names. Informational; the validator enforces. */
  requiredAttributes: readonly string[]
  /** Validate an `ElementNode`'s tag name + attributes. */
  validator: (node: ElementNode) => ValidationResult
}

/** The full index-element registry — exactly one entry per `IndexElementName`. */
export type IndexElementRegistry = Readonly<Record<IndexElementName, IndexElementSchema>>
