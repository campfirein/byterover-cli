/**
 * Sample-topic round-trip test.
 *
 * Verifies that the element vocabulary, applied to a realistic topic
 * file, parses cleanly, validates per-element, and round-trips
 * (parse → walk → re-serialise) without semantic loss.
 *
 * Closest proxy for "could a real curated topic survive the pipeline?"
 * — useful as a pre-flight before the writer touches disk.
 */

import {expect} from 'chai'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import type {ElementName} from '../../../../../src/server/core/domain/render/element-types.js'

import {ELEMENT_NAMES} from '../../../../../src/server/core/domain/render/element-types.js'
import {ELEMENT_REGISTRY} from '../../../../../src/server/infra/render/elements/registry.js'
import {getInnerText, parseHtml, serializeHtml, walkElements} from '../../../../../src/server/infra/render/reader/html-parser.js'

const FIXTURE_PATH = join(process.cwd(), 'test/fixtures/render/sample-topic.html')

function loadFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8')
}

function isRegisteredElementName(tag: string): tag is ElementName {
  return (ELEMENT_NAMES as readonly string[]).includes(tag)
}

describe('sample-topic.html round-trip', () => {
  describe('parse', () => {
    it('parses without errors', () => {
      const html = loadFixture()
      expect(() => parseHtml(html)).to.not.throw()
    })

    it('contains exactly one bv-topic element', () => {
      const elements = walkElements(parseHtml(loadFixture()))
      const topics = elements.filter((e) => e.tagName === 'bv-topic')
      expect(topics).to.have.lengthOf(1)
    })

    it('contains every registered element type at least once', () => {
      const elements = walkElements(parseHtml(loadFixture()))
      const tagSet = new Set(elements.map((e) => e.tagName))
      for (const name of ELEMENT_NAMES) {
        expect(tagSet.has(name), `expected at least one ${name}`).to.equal(true)
      }
    })

    it('preserves the bv-topic frontmatter attributes', () => {
      const elements = walkElements(parseHtml(loadFixture()))
      const topic = elements.find((e) => e.tagName === 'bv-topic')!
      expect(topic.attributes.path).to.equal('security/auth')
      expect(topic.attributes.title).to.equal('Authentication and Authorization')
      expect(topic.attributes.tags).to.equal('security,authentication')
      expect(topic.attributes.keywords).to.include('jwt')
      expect(topic.attributes.related).to.include('@security/cookies')
    })

    it('does NOT carry runtime-signal attributes on bv-topic', () => {
      // importance/maturity/recency/updatedat live in the runtime-signal
      // sidecar store, not in topic file content. The fixture must not
      // re-introduce them.
      const elements = walkElements(parseHtml(loadFixture()))
      const topic = elements.find((e) => e.tagName === 'bv-topic')!
      for (const sidecar of ['importance', 'maturity', 'recency', 'updatedat']) {
        expect(topic.attributes[sidecar], `expected ${sidecar} to NOT appear on bv-topic`).to.equal(undefined)
      }
    })
  })

  describe('validate', () => {
    it('every bv-* element in the fixture passes its registered validator', () => {
      const elements = walkElements(parseHtml(loadFixture()))
      for (const el of elements) {
        if (!isRegisteredElementName(el.tagName)) continue
        const result = ELEMENT_REGISTRY[el.tagName].validator(el)
        expect(
          result.valid,
          `expected ${el.tagName} (id=${el.attributes.id ?? 'n/a'}) to validate; errors: ${JSON.stringify(result.valid ? [] : result.errors)}`,
        ).to.equal(true)
      }
    })
  })

  describe('round-trip (parse → serialize → re-parse)', () => {
    it('produces semantically equivalent output', () => {
      const original = parseHtml(loadFixture())
      const out = serializeHtml(original)
      const reparsed = parseHtml(out)

      const originalElements = walkElements(original)
      const reparsedElements = walkElements(reparsed)

      // Same element count after round-trip
      expect(reparsedElements.length).to.equal(originalElements.length)

      // Tag-name sequence preserved
      expect(reparsedElements.map((e) => e.tagName)).to.deep.equal(
        originalElements.map((e) => e.tagName),
      )
    })

    it('preserves attribute values across round-trip', () => {
      const original = parseHtml(loadFixture())
      const reparsed = parseHtml(serializeHtml(original))

      const originalTopic = walkElements(original).find((e) => e.tagName === 'bv-topic')!
      const reparsedTopic = walkElements(reparsed).find((e) => e.tagName === 'bv-topic')!
      expect(reparsedTopic.attributes).to.deep.equal(originalTopic.attributes)
    })

    it('preserves innerText (text content) across round-trip', () => {
      const original = parseHtml(loadFixture())
      const reparsed = parseHtml(serializeHtml(original))

      const originalText = getInnerText(original)
      const reparsedText = getInnerText(reparsed)

      // Whitespace may normalize, but every word from the original should remain
      const wordsOriginal = originalText.split(/\s+/).filter(Boolean)
      const reparsedSet = new Set(reparsedText.split(/\s+/).filter(Boolean))
      const missing = wordsOriginal.filter((w) => !reparsedSet.has(w))
      expect(missing, `words lost in round-trip: ${missing.join(', ')}`).to.have.lengthOf(0)
    })
  })

  describe('innerText for BM25', () => {
    it('contains expected substrings from each element type', () => {
      const elements = walkElements(parseHtml(loadFixture()))
      const topic = elements.find((e) => e.tagName === 'bv-topic')!
      const innerText = getInnerText(topic)

      // Sample of expected content from each element
      expect(innerText).to.include('401 Unauthorized')
      expect(innerText).to.include('RS256')
      expect(innerText).to.include('refresh')
      expect(innerText).to.include('logout')
    })
  })

  describe('renderable-MD coverage', () => {
    // The vocabulary's promise: every section the markdown writer
    // renders has a dedicated bv-* element. The fixture exercises that
    // by including every renderable section at least once.
    it('covers every renderable .md section via dedicated elements', () => {
      const elements = walkElements(parseHtml(loadFixture()))
      const tags = new Set(elements.map((e) => e.tagName))
      // Frontmatter mapping (attributes on bv-topic) is covered by the
      // 'preserves the bv-topic frontmatter attributes' test above.
      // Body sections live on dedicated elements:
      const renderableSections = [
        'bv-reason',         // ## Reason
        'bv-task',           // ## Raw Concept > Task
        'bv-changes',        // ## Raw Concept > Changes
        'bv-files',          // ## Raw Concept > Files
        'bv-flow',           // ## Raw Concept > Flow
        'bv-timestamp',      // ## Raw Concept > Timestamp
        'bv-author',         // ## Raw Concept > Author
        'bv-pattern',        // ## Raw Concept > Patterns (each pattern)
        'bv-structure',      // ## Narrative > Structure
        'bv-dependencies',   // ## Narrative > Dependencies
        'bv-highlights',     // ## Narrative > Highlights
        'bv-rule',           // ## Narrative > Rules (each rule)
        'bv-examples',       // ## Narrative > Examples
        'bv-diagram',        // ## Narrative > Diagrams (each diagram)
        'bv-fact',           // ## Facts (each fact)
      ]
      for (const tag of renderableSections) {
        expect(tags.has(tag), `expected ${tag} to cover its rendered section`).to.equal(true)
      }
    })
  })
})
