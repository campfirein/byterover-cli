/**
 * bv-bug validator tests.
 *
 * A bug runbook entry. Optional attributes:
 *   - `id` — optional; non-empty string if present
 *   - `severity` — optional; one of {"low","medium","high","critical"}
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvBug} from '../../../../../../src/server/infra/render/elements/bv-bug/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-bug'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-bug validator', () => {
  describe('valid', () => {
    it('accepts an empty attribute set (all optional)', () => {
      expect(validateBvBug(makeNode({})).valid).to.equal(true)
    })

    it('accepts id only', () => {
      expect(validateBvBug(makeNode({id: 'auth-leak-2026-04'})).valid).to.equal(true)
    })

    it('accepts severity only ("critical")', () => {
      expect(validateBvBug(makeNode({severity: 'critical'})).valid).to.equal(true)
    })

    it('accepts severity "low"', () => {
      expect(validateBvBug(makeNode({severity: 'low'})).valid).to.equal(true)
    })

    it('accepts severity "medium"', () => {
      expect(validateBvBug(makeNode({severity: 'medium'})).valid).to.equal(true)
    })

    it('accepts severity "high"', () => {
      expect(validateBvBug(makeNode({severity: 'high'})).valid).to.equal(true)
    })

    it('accepts id + severity together', () => {
      expect(validateBvBug(makeNode({id: 'b1', severity: 'high'})).valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      expect(validateBvBug(makeNode({severity: 'high', someFutureAttr: 'x'})).valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects empty id', () => {
      expect(validateBvBug(makeNode({id: ''})).valid).to.equal(false)
    })

    it('rejects unknown severity value', () => {
      expect(validateBvBug(makeNode({severity: 'minor'})).valid).to.equal(false)
    })

    it('rejects severity in wrong case (case-sensitive enum)', () => {
      expect(validateBvBug(makeNode({severity: 'HIGH'})).valid).to.equal(false)
    })

    it('rejects wrong tag name', () => {
      const result = validateBvBug(makeNode({}, 'bv-fix'))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'tagName')).to.equal(true)
      }
    })
  })
})
