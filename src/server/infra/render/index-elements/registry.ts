import type {IndexElementRegistry} from './types.js'

import {
  validateBvIndex,
  validateBvIndexDescription,
  validateBvIndexDomain,
  validateBvIndexEntry,
} from './validators.js'

/**
 * Index-element registry — single source of truth for the closed
 * `<bv-index*>` navigation vocabulary.
 *
 * Deliberately separate from the topic `ELEMENT_REGISTRY`. The index is
 * a navigation artifact, not a knowledge topic: it must not be
 * BM25-indexed, must not surface in `brv query`, and must not satisfy
 * `validateHtmlTopic`. Keeping a distinct registry means every
 * topic-vocabulary consumer sees exactly the topic element set, and
 * `validateHtmlIndex` sees exactly the index element set. The two
 * registries never merge.
 */
export const INDEX_ELEMENT_REGISTRY: IndexElementRegistry = {
  'bv-index': {
    allowedChildren: 'block',
    description:
      'Root container for the context-tree index. Carries the project header as ' +
      'attributes (project, generatedat, topiccount, domaincount). Exactly one per file.',
    name: 'bv-index',
    optionalAttributes: ['topiccount', 'domaincount'],
    requiredAttributes: ['project', 'generatedat'],
    validator: validateBvIndex,
  },
  'bv-index-description': {
    allowedChildren: 'any',
    description:
      'Freeform prose description. Project-level when a child of `<bv-index>`, ' +
      'domain-level when a child of `<bv-index-domain>`. Optional; the v1 ' +
      'generator emits none — defined for forward compatibility.',
    name: 'bv-index-description',
    optionalAttributes: [],
    requiredAttributes: [],
    validator: validateBvIndexDescription,
  },
  'bv-index-domain': {
    allowedChildren: 'block',
    description:
      'One section per top-level domain/category. `name` is the domain; `count` ' +
      'is the number of topics in it. Groups `<bv-index-entry>` children.',
    name: 'bv-index-domain',
    optionalAttributes: ['count'],
    requiredAttributes: ['name'],
    validator: validateBvIndexDomain,
  },
  'bv-index-entry': {
    allowedChildren: 'inline',
    description:
      'One per topic — the routing unit. `path` is the relative topic-file path ' +
      '(routing target); `title` is the topic title; `format` is `html` or ' +
      '`markdown`; `tags` is an optional comma-separated list. Text content is ' +
      "the topic's summary.",
    name: 'bv-index-entry',
    optionalAttributes: ['tags'],
    requiredAttributes: ['path', 'title', 'format'],
    validator: validateBvIndexEntry,
  },
}
