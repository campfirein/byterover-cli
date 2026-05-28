/**
 * Element registry tests.
 *
 * The registry is the single source of truth for the closed `<bv-*>`
 * vocabulary. Every consumer (curate writer, query reader, prompt
 * template generator) walks the registry generically. Vocabulary
 * expansion is purely additive — new entries only.
 */

import {expect} from 'chai'

import type {ElementName, ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {ELEMENT_NAMES} from '../../../../../../src/server/core/domain/render/element-types.js'
import {ELEMENT_REGISTRY} from '../../../../../../src/server/infra/render/elements/registry.js'

function makeNode(tagName: string, attributes: Record<string, string> = {}): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('ELEMENT_REGISTRY', () => {
  describe('shape', () => {
    it('contains exactly the registered vocabulary', () => {
      expect(Object.keys(ELEMENT_REGISTRY)).to.have.lengthOf(ELEMENT_NAMES.length)
    })

    it('has one entry per `ElementName` listed in `ELEMENT_NAMES`', () => {
      for (const name of ELEMENT_NAMES) {
        expect(ELEMENT_REGISTRY[name], `expected entry for ${name}`).to.not.equal(undefined)
      }
    })

    it('every entry exposes `name`, `validator`, `description`, `requiredAttributes`, `optionalAttributes`, `allowedChildren`', () => {
      for (const name of ELEMENT_NAMES) {
        const entry = ELEMENT_REGISTRY[name]
        expect(entry.name).to.equal(name)
        expect(typeof entry.validator).to.equal('function')
        expect(typeof entry.description).to.equal('string')
        expect(entry.description.length).to.be.greaterThan(0)
        expect(Array.isArray(entry.requiredAttributes)).to.equal(true)
        expect(Array.isArray(entry.optionalAttributes)).to.equal(true)
        expect(['any', 'block', 'inline', 'none']).to.include(entry.allowedChildren)
      }
    })
  })

  describe('validators are wired correctly', () => {
    it('bv-topic validator accepts a valid bv-topic node', () => {
      const result = ELEMENT_REGISTRY['bv-topic'].validator(makeNode('bv-topic', {path: 'x', title: 't'}))
      expect(result.valid).to.equal(true)
    })

    it('bv-topic validator rejects a wrong-tag node', () => {
      const result = ELEMENT_REGISTRY['bv-topic'].validator(makeNode('bv-rule'))
      expect(result.valid).to.equal(false)
    })

    it('bv-rule validator accepts an empty bv-rule node', () => {
      const result = ELEMENT_REGISTRY['bv-rule'].validator(makeNode('bv-rule'))
      expect(result.valid).to.equal(true)
    })

    it('bv-decision validator accepts a bv-decision node with id', () => {
      const result = ELEMENT_REGISTRY['bv-decision'].validator(makeNode('bv-decision', {id: 'd1'}))
      expect(result.valid).to.equal(true)
    })

    it('bv-bug validator accepts a bv-bug node with severity', () => {
      const result = ELEMENT_REGISTRY['bv-bug'].validator(makeNode('bv-bug', {severity: 'high'}))
      expect(result.valid).to.equal(true)
    })

    it('bv-fix validator accepts a bv-fix node', () => {
      const result = ELEMENT_REGISTRY['bv-fix'].validator(makeNode('bv-fix'))
      expect(result.valid).to.equal(true)
    })

    it('every registered validator accepts an empty node of its own tag', () => {
      // Smoke test that the registry is wired tag-to-validator correctly
      // and that every validator's "minimum viable node" passes its own
      // schema. bv-topic is excluded — it requires `path` + `title`.
      for (const name of ELEMENT_NAMES) {
        if (name === 'bv-topic') continue
        const result = ELEMENT_REGISTRY[name].validator(makeNode(name))
        expect(result.valid, `expected ${name} to accept its own empty node`).to.equal(true)
      }
    })

    it('every registered validator rejects a wrong-tag node (tag-name guard)', () => {
      for (const name of ELEMENT_NAMES) {
        const result = ELEMENT_REGISTRY[name].validator(makeNode('mismatched-tag'))
        expect(result.valid, `expected ${name} validator to reject mismatched-tag`).to.equal(false)
      }
    })
  })

  describe('metadata for downstream consumers', () => {
    it('bv-topic declares `path` and `title` as required attributes', () => {
      expect(ELEMENT_REGISTRY['bv-topic'].requiredAttributes).to.include('path')
      expect(ELEMENT_REGISTRY['bv-topic'].requiredAttributes).to.include('title')
    })

    it('bv-topic declares `summary`, `tags`, `keywords`, `related` as optional', () => {
      for (const attr of ['summary', 'tags', 'keywords', 'related']) {
        expect(ELEMENT_REGISTRY['bv-topic'].optionalAttributes, `expected ${attr} to be optional`).to.include(attr)
      }
    })

    it('bv-topic does NOT declare runtime signals (importance/maturity/recency/updatedat) as schema attributes', () => {
      // These are sidecar state per the runtime-signals migration.
      const allDeclared = [
        ...ELEMENT_REGISTRY['bv-topic'].requiredAttributes,
        ...ELEMENT_REGISTRY['bv-topic'].optionalAttributes,
      ]
      for (const sidecarField of ['importance', 'maturity', 'recency', 'updatedat']) {
        expect(allDeclared, `expected ${sidecarField} to NOT be a schema attribute`).to.not.include(sidecarField)
      }
    })

    it('bv-rule declares `severity` as an optional attribute', () => {
      expect(ELEMENT_REGISTRY['bv-rule'].optionalAttributes).to.include('severity')
    })

    it('bv-bug declares `severity` as an optional attribute', () => {
      expect(ELEMENT_REGISTRY['bv-bug'].optionalAttributes).to.include('severity')
    })

    it('every element has a non-trivial description for the prompt template generator', () => {
      for (const name of ELEMENT_NAMES) {
        expect(ELEMENT_REGISTRY[name].description.length).to.be.greaterThan(20)
      }
    })
  })

  describe('readonly contract', () => {
    it('registry is structurally Readonly<Record<ElementName, ElementSchema>>', () => {
      // Compile-time guard via the type. Runtime sanity check: keys are exactly ELEMENT_NAMES.
      const keys = Object.keys(ELEMENT_REGISTRY).sort() as ElementName[]
      const expected = [...ELEMENT_NAMES].sort()
      expect(keys).to.deep.equal(expected)
    })
  })
})
