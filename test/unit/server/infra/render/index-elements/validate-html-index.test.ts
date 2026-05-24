/**
 * validateHtmlIndex tests — the index document self-check.
 */

import {expect} from 'chai'

import {validateHtmlIndex} from '../../../../../../src/server/infra/render/index-elements/validate-html-index.js'

const VALID_INDEX = `<bv-index project="research" generatedat="2026-05-20T03:30:00.000Z" topiccount="2" domaincount="1">
  <bv-index-domain name="features" count="2">
    <bv-index-entry path="features/auth.html" title="Auth" format="html">Auth summary.</bv-index-entry>
    <bv-index-entry path="features/cache.md" title="Cache" format="markdown">Cache summary.</bv-index-entry>
  </bv-index-domain>
</bv-index>`

describe('validateHtmlIndex', () => {
  it('accepts a well-formed index document', () => {
    expect(validateHtmlIndex(VALID_INDEX).ok).to.equal(true)
  })

  it('accepts an empty index (no domains)', () => {
    const html = '<bv-index project="research" generatedat="2026-05-20T03:30:00.000Z" topiccount="0" domaincount="0"></bv-index>'
    expect(validateHtmlIndex(html).ok).to.equal(true)
  })

  it('accepts a project-level <bv-index-description>', () => {
    const html = `<bv-index project="research" generatedat="2026-05-20T03:30:00.000Z">
      <bv-index-description>A research knowledge base.</bv-index-description>
    </bv-index>`
    expect(validateHtmlIndex(html).ok).to.equal(true)
  })

  it('rejects a document with no <bv-index> root', () => {
    const result = validateHtmlIndex('<div>not an index</div>')
    expect(result.ok).to.equal(false)
    if (result.ok) return
    expect(result.errors[0].kind).to.equal('missing-bv-index')
  })

  it('rejects a <bv-index> nested below the document root (not a true root)', () => {
    const html = `<bv-index-domain name="x">
      <bv-index project="p" generatedat="2026-05-20T03:30:00.000Z"></bv-index>
    </bv-index-domain>`
    const result = validateHtmlIndex(html)
    expect(result.ok).to.equal(false)
    if (result.ok) return
    expect(result.errors[0].kind).to.equal('missing-bv-index')
  })

  it('rejects a document with two <bv-index> roots', () => {
    const html = `${VALID_INDEX}\n${VALID_INDEX}`
    const result = validateHtmlIndex(html)
    expect(result.ok).to.equal(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.kind === 'multiple-bv-index')).to.equal(true)
  })

  it('rejects a topic element inside an index (vocabularies do not mix)', () => {
    const html = `<bv-index project="research" generatedat="2026-05-20T03:30:00.000Z">
      <bv-topic path="x" title="y"></bv-topic>
    </bv-index>`
    const result = validateHtmlIndex(html)
    expect(result.ok).to.equal(false)
    if (result.ok) return
    const unknown = result.errors.find((e) => e.kind === 'unknown-index-element')
    expect(unknown).to.not.equal(undefined)
    expect((unknown as {tag: string}).tag).to.equal('bv-topic')
  })

  it('rejects an entry with a missing required attribute', () => {
    const html = `<bv-index project="research" generatedat="2026-05-20T03:30:00.000Z">
      <bv-index-domain name="features">
        <bv-index-entry path="features/auth.html" format="html">no title</bv-index-entry>
      </bv-index-domain>
    </bv-index>`
    const result = validateHtmlIndex(html)
    expect(result.ok).to.equal(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.kind === 'attribute-validation' && e.tag === 'bv-index-entry')).to.equal(true)
  })

  it('rejects an entry with an invalid format enum value', () => {
    const html = `<bv-index project="research" generatedat="2026-05-20T03:30:00.000Z">
      <bv-index-domain name="features">
        <bv-index-entry path="features/auth.html" title="Auth" format="pdf">bad format</bv-index-entry>
      </bv-index-domain>
    </bv-index>`
    expect(validateHtmlIndex(html).ok).to.equal(false)
  })

  it('tolerates plain HTML (ul, li) inside the index', () => {
    const html = `<bv-index project="research" generatedat="2026-05-20T03:30:00.000Z">
      <bv-index-description><ul><li>point one</li></ul></bv-index-description>
    </bv-index>`
    expect(validateHtmlIndex(html).ok).to.equal(true)
  })
})
