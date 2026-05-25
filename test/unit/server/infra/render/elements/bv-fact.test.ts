/**
 * bv-fact validator tests.
 *
 * A structured fact entry. Mirrors the existing fact model:
 *   - `subject`  — optional; snake_case key (e.g., "user_name")
 *   - `category` — optional; one of {"personal","project","preference",
 *                  "convention","team","environment","other"}
 *   - `value`    — optional; the extracted value
 *
 * The element's text content is the canonical statement.
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {validateBvFact} from '../../../../../../src/server/infra/render/elements/bv-fact/validator.js'

function makeNode(attributes: Record<string, string>, tagName = 'bv-fact'): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('bv-fact validator', () => {
  describe('valid', () => {
    it('accepts an empty attribute set (statement-only fact)', () => {
      expect(validateBvFact(makeNode({})).valid).to.equal(true)
    })

    it('accepts every category-enum value', () => {
      for (const c of ['personal', 'project', 'preference', 'convention', 'team', 'environment', 'other']) {
        expect(validateBvFact(makeNode({category: c})).valid, `expected ${c} to be accepted`).to.equal(true)
      }
    })

    it('accepts subject + category + value together', () => {
      expect(validateBvFact(makeNode({
        category: 'project',
        subject: 'database_version',
        value: 'PostgreSQL 15',
      })).valid).to.equal(true)
    })

    it('tolerates unknown attributes (parse-and-skip — light validation)', () => {
      expect(validateBvFact(makeNode({category: 'project', someFutureAttr: 'x'})).valid).to.equal(true)
    })
  })

  describe('invalid', () => {
    it('rejects unknown category-enum value', () => {
      expect(validateBvFact(makeNode({category: 'critical'})).valid).to.equal(false)
    })

    it('rejects category in wrong case (case-sensitive enum)', () => {
      expect(validateBvFact(makeNode({category: 'Project'})).valid).to.equal(false)
    })

    it('rejects wrong tag name', () => {
      const result = validateBvFact(makeNode({}, 'bv-rule'))
      expect(result.valid).to.equal(false)
    })
  })
})
