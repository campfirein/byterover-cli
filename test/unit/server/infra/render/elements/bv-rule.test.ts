/**
 * bv-rule validator tests.
 *
 * A rule statement. Optional attributes:
 *   - `severity` — optional; one of {"info","must","should"}
 *   - `id` — optional; non-empty string if present
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvRule} from '../../../../../../src/server/infra/render/elements/bv-rule/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-rule'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-rule validator', () => {
  describe('valid', () => {
    it('accepts an empty attribute set (all optional)', () => {
      expect(validateBvRule(makeNode({})).valid).to.equal(true)
    })

    it('accepts severity="must"', () => {
      expect(validateBvRule(makeNode({severity: 'must'})).valid).to.equal(true)
    })

    it('accepts severity="info"', () => {
      expect(validateBvRule(makeNode({severity: 'info'})).valid).to.equal(true)
    })

    it('accepts severity="should"', () => {
      expect(validateBvRule(makeNode({severity: 'should'})).valid).to.equal(true)
    })

    it('accepts id only', () => {
      expect(validateBvRule(makeNode({id: 'r-jwt-401'})).valid).to.equal(true)
    })

    it('accepts severity + id together', () => {
      expect(validateBvRule(makeNode({id: 'r-jwt-401', severity: 'must'})).valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      expect(validateBvRule(makeNode({severity: 'must', someFutureAttr: 'x'})).valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects unknown severity value', () => {
      const result = validateBvRule(makeNode({severity: 'critical'}))
      expect(result.valid).to.equal(false)
    })

    it('rejects empty id', () => {
      const result = validateBvRule(makeNode({id: ''}))
      expect(result.valid).to.equal(false)
    })

    it('rejects severity in wrong case (case-sensitive enum)', () => {
      const result = validateBvRule(makeNode({severity: 'MUST'}))
      expect(result.valid).to.equal(false)
    })

    it('rejects wrong tag name', () => {
      const result = validateBvRule(makeNode({}, 'bv-decision'))
      expect(result.valid).to.equal(false)
      if (!result.valid) {
        expect(result.errors.some((e) => e.field === 'tagName')).to.equal(true)
      }
    })
  })
})
