/**
 * bv-pattern validator tests.
 *
 * One pattern entry inside `## Raw Concept > Patterns`. Multiple
 * `<bv-pattern>` siblings are collected by the writer into a single
 * bullet list. Element text is the pattern itself; structured fields
 * live in attributes.
 *   - `flags`       — optional; e.g. "g", "im"
 *   - `description` — optional; what the pattern matches
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvPattern} from '../../../../../../src/server/infra/render/elements/bv-pattern/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-pattern'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-pattern validator', () => {
  describe('valid', () => {
    it('accepts an empty attribute set (pattern-only)', () => {
      expect(validateBvPattern(makeNode({})).valid).to.equal(true)
    })

    it('accepts flags + description together', () => {
      expect(validateBvPattern(makeNode({
        description: 'Match an email address',
        flags: 'gi',
      })).valid).to.equal(true)
    })

    it('accepts description only', () => {
      expect(validateBvPattern(makeNode({description: 'Match a URL'})).valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      expect(validateBvPattern(makeNode({flags: 'g', someFutureAttr: 'x'})).valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects wrong tag name', () => {
      const result = validateBvPattern(makeNode({}, 'bv-rule'))
      expect(result.valid).to.equal(false)
    })
  })
})
