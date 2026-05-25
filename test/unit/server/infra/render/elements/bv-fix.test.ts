/**
 * bv-fix validator tests.
 *
 * A fix runbook entry. Optional attributes:
 *   - `id` — optional; non-empty string if present
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvFix} from '../../../../../../src/server/infra/render/elements/bv-fix/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-fix'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-fix validator', () => {
  describe('valid', () => {
    it('accepts an empty attribute set (all optional)', () => {
      expect(validateBvFix(makeNode({})).valid).to.equal(true)
    })

    it('accepts id only', () => {
      expect(validateBvFix(makeNode({id: 'fix-jwt-rotation-2026-04-30'})).valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      expect(validateBvFix(makeNode({id: 'f1', someFutureAttr: 'x'})).valid).to.equal(true)
    })

    it('accepts ids with mixed casing and dashes', () => {
      expect(validateBvFix(makeNode({id: 'F-001-RotateJWT'})).valid).to.equal(true)
    })

    it('accepts ids with numbers', () => {
      expect(validateBvFix(makeNode({id: 'f-2026-04-30'})).valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects empty id', () => {
      expect(validateBvFix(makeNode({id: ''})).valid).to.equal(false)
    })

    it('rejects wrong tag name', () => {
      const result = validateBvFix(makeNode({}, 'bv-bug'))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'tagName')).to.equal(true)
      }
    })
  })

  describe('error reporting', () => {
    it('returns at least one error on failure', () => {
      const result = validateBvFix(makeNode({id: ''}))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors).to.have.lengthOf.greaterThan(0)
      }
    })

    it('reports the id field name', () => {
      const result = validateBvFix(makeNode({id: ''}))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors[0].field).to.equal('id')
      }
    })

    it('reports a non-empty error message for tag mismatch', () => {
      const result = validateBvFix(makeNode({}, 'wrong-tag'))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors[0].message).to.include('tagName')
      }
    })
  })
})
