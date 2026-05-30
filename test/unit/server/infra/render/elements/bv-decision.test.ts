/**
 * bv-decision validator tests.
 *
 * A decision record. Optional attributes:
 *   - `id` — optional; non-empty string if present
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvDecision} from '../../../../../../src/server/infra/render/elements/bv-decision/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-decision'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-decision validator', () => {
  describe('valid', () => {
    it('accepts an empty attribute set (all optional)', () => {
      expect(validateBvDecision(makeNode({})).valid).to.equal(true)
    })

    it('accepts id only', () => {
      expect(validateBvDecision(makeNode({id: 'rs256-over-hs256'})).valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      expect(validateBvDecision(makeNode({id: 'd1', someFutureAttr: 'x'})).valid).to.equal(true)
    })

    it('accepts ids with mixed casing and dashes (no enforced format)', () => {
      expect(validateBvDecision(makeNode({id: 'D-001-AcceptRS256'})).valid).to.equal(true)
    })

    it('accepts ids with numbers', () => {
      expect(validateBvDecision(makeNode({id: 'd-2026-04-27'})).valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects empty id', () => {
      expect(validateBvDecision(makeNode({id: ''})).valid).to.equal(false)
    })

    it('rejects wrong tag name', () => {
      const result = validateBvDecision(makeNode({}, 'bv-rule'))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'tagName')).to.equal(true)
      }
    })
  })

  describe('error reporting', () => {
    it('returns a populated errors list on failure', () => {
      const result = validateBvDecision(makeNode({id: ''}))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors).to.have.lengthOf.greaterThan(0)
      }
    })

    it('reports the failing field name', () => {
      const result = validateBvDecision(makeNode({id: ''}))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors[0].field).to.equal('id')
      }
    })

    it('reports a non-empty error message', () => {
      const result = validateBvDecision(makeNode({}, 'wrong-tag'))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors[0].message).to.include('tagName')
      }
    })
  })
})
