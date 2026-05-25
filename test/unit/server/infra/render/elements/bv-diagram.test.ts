/**
 * bv-diagram validator tests.
 *
 * Preserves a diagram (mermaid / plantuml / ascii / dot) verbatim.
 *   - `type`  — optional; one of {"mermaid","plantuml","ascii","dot",
 *               "graphviz","other"}
 *   - `title` — optional; caption string
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvDiagram} from '../../../../../../src/server/infra/render/elements/bv-diagram/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-diagram'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-diagram validator', () => {
  describe('valid', () => {
    it('accepts an empty attribute set', () => {
      expect(validateBvDiagram(makeNode({})).valid).to.equal(true)
    })

    it('accepts every type-enum value', () => {
      for (const t of ['mermaid', 'plantuml', 'ascii', 'dot', 'graphviz', 'other']) {
        expect(validateBvDiagram(makeNode({type: t})).valid, `expected ${t} to be accepted`).to.equal(true)
      }
    })

    it('accepts type + title together', () => {
      expect(validateBvDiagram(makeNode({title: 'Authentication Flow', type: 'mermaid'})).valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      expect(validateBvDiagram(makeNode({someFutureAttr: 'x', type: 'mermaid'})).valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects unknown type-enum value', () => {
      expect(validateBvDiagram(makeNode({type: 'sequence'})).valid).to.equal(false)
    })

    it('rejects type in wrong case (case-sensitive enum)', () => {
      expect(validateBvDiagram(makeNode({type: 'Mermaid'})).valid).to.equal(false)
    })

    it('rejects wrong tag name', () => {
      const result = validateBvDiagram(makeNode({}, 'bv-rule'))
      expect(result.valid).to.equal(false)
    })
  })
})
