/**
 * Index-element validator tests.
 *
 * Four elements in the context-tree index vocabulary:
 *   bv-index             — root; required project + generatedat.
 *   bv-index-domain      — required name.
 *   bv-index-entry       — required path + title + format (html|markdown).
 *   bv-index-description — no attributes.
 */

import {expect} from 'chai'

import type {ElementNode} from '../../../../../../src/server/core/domain/render/element-types.js'

import {
  validateBvIndex,
  validateBvIndexDescription,
  validateBvIndexDomain,
  validateBvIndexEntry,
} from '../../../../../../src/server/infra/render/index-elements/validators.js'

function makeNode(tagName: string, attributes: Record<string, string>): ElementNode {
  return {attributes, children: [], tagName, type: 'element'}
}

describe('index-element validators', () => {
  describe('bv-index', () => {
    it('accepts the minimum: project + generatedat', () => {
      expect(
        validateBvIndex(makeNode('bv-index', {generatedat: '2026-05-20T03:30:00.000Z', project: 'research'})).valid,
      ).to.equal(true)
    })

    it('accepts topiccount + domaincount as digit strings', () => {
      expect(
        validateBvIndex(
          makeNode('bv-index', {
            domaincount: '3',
            generatedat: '2026-05-20T03:30:00.000Z',
            project: 'research',
            topiccount: '6',
          }),
        ).valid,
      ).to.equal(true)
    })

    it('rejects a missing project', () => {
      expect(validateBvIndex(makeNode('bv-index', {generatedat: '2026-05-20T03:30:00.000Z'})).valid).to.equal(false)
    })

    it('rejects a missing generatedat', () => {
      expect(validateBvIndex(makeNode('bv-index', {project: 'research'})).valid).to.equal(false)
    })

    it('rejects an empty project', () => {
      expect(
        validateBvIndex(makeNode('bv-index', {generatedat: '2026-05-20T03:30:00.000Z', project: ''})).valid,
      ).to.equal(false)
    })

    it('rejects a non-numeric topiccount', () => {
      expect(
        validateBvIndex(
          makeNode('bv-index', {generatedat: '2026-05-20T03:30:00.000Z', project: 'research', topiccount: 'six'}),
        ).valid,
      ).to.equal(false)
    })
  })

  describe('bv-index-domain', () => {
    it('accepts the minimum: name', () => {
      expect(validateBvIndexDomain(makeNode('bv-index-domain', {name: 'features'})).valid).to.equal(true)
    })

    it('accepts name + count', () => {
      expect(validateBvIndexDomain(makeNode('bv-index-domain', {count: '2', name: 'features'})).valid).to.equal(true)
    })

    it('rejects a missing name', () => {
      expect(validateBvIndexDomain(makeNode('bv-index-domain', {count: '2'})).valid).to.equal(false)
    })

    it('rejects a non-numeric count', () => {
      expect(validateBvIndexDomain(makeNode('bv-index-domain', {count: 'two', name: 'features'})).valid).to.equal(false)
    })
  })

  describe('bv-index-entry', () => {
    const valid = {format: 'html', path: 'features/auth.html', title: 'Auth'}

    it('accepts the minimum: path + title + format', () => {
      expect(validateBvIndexEntry(makeNode('bv-index-entry', valid)).valid).to.equal(true)
    })

    it('accepts format="markdown"', () => {
      expect(validateBvIndexEntry(makeNode('bv-index-entry', {...valid, format: 'markdown'})).valid).to.equal(true)
    })

    it('accepts an optional tags attribute', () => {
      expect(validateBvIndexEntry(makeNode('bv-index-entry', {...valid, tags: 'a,b,c'})).valid).to.equal(true)
    })

    it('rejects a missing path', () => {
      expect(validateBvIndexEntry(makeNode('bv-index-entry', {format: 'html', title: 'Auth'})).valid).to.equal(false)
    })

    it('rejects a missing title', () => {
      expect(
        validateBvIndexEntry(makeNode('bv-index-entry', {format: 'html', path: 'features/auth.html'})).valid,
      ).to.equal(false)
    })

    it('rejects an invalid format enum value', () => {
      expect(validateBvIndexEntry(makeNode('bv-index-entry', {...valid, format: 'pdf'})).valid).to.equal(false)
    })

    it('rejects a missing format', () => {
      expect(
        validateBvIndexEntry(makeNode('bv-index-entry', {path: 'features/auth.html', title: 'Auth'})).valid,
      ).to.equal(false)
    })
  })

  describe('bv-index-description', () => {
    it('accepts an empty attribute set', () => {
      expect(validateBvIndexDescription(makeNode('bv-index-description', {})).valid).to.equal(true)
    })

    it('tolerates unknown attributes (passthrough)', () => {
      expect(validateBvIndexDescription(makeNode('bv-index-description', {scope: 'project'})).valid).to.equal(true)
    })

    it('rejects a wrong tag name', () => {
      expect(validateBvIndexDescription(makeNode('bv-index', {})).valid).to.equal(false)
    })
  })
})
