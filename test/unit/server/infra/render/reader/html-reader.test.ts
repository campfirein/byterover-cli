/**
 * html-reader tests.
 *
 * Two surfaces:
 *   - `readHtmlTopicSync(html)` — pure function, no I/O. Used in unit
 *     tests and by the search service's in-process indexer.
 *   - `readHtmlTopic(filePath)` — fs-backed wrapper.
 *
 * The reader is forgiving on malformed input (parse5's design); the
 * tests assert the BM25-ready text, the structural element list, and
 * the bv-topic frontmatter all surface as expected on representative
 * inputs.
 */

import {expect} from 'chai'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readHtmlTopic, readHtmlTopicSync} from '../../../../../../src/server/infra/render/reader/html-reader.js'

describe('html-reader', () => {
  describe('readHtmlTopicSync', () => {
    it('extracts BM25-ready bodyText from a topic', () => {
      const html = `<bv-topic path="security/auth" title="JWT Auth">
  <bv-reason>Document JWT design.</bv-reason>
  <bv-rule severity="must">Always validate signatures.</bv-rule>
</bv-topic>`
      const result = readHtmlTopicSync(html)
      expect(result.bodyText).to.include('Document JWT design.')
      expect(result.bodyText).to.include('Always validate signatures.')
    })

    it('decodes HTML entities in bodyText (parse5 handles entities)', () => {
      const html = '<bv-topic path="x" title="t"><bv-rule>Use &amp; not &lt;</bv-rule></bv-topic>'
      const result = readHtmlTopicSync(html)
      expect(result.bodyText).to.include('Use & not <')
    })

    it('lifts bv-topic frontmatter attributes', () => {
      const html = `<bv-topic path="security/auth" title="JWT" summary="Auth design" tags="security,jwt" keywords="jwt,token" related="@security/oauth">
  <bv-reason>x</bv-reason>
</bv-topic>`
      const result = readHtmlTopicSync(html)
      expect(result.topicAttributes.path).to.equal('security/auth')
      expect(result.topicAttributes.title).to.equal('JWT')
      expect(result.topicAttributes.summary).to.equal('Auth design')
      expect(result.topicAttributes.tags).to.equal('security,jwt')
      expect(result.topicAttributes.keywords).to.equal('jwt,token')
      expect(result.topicAttributes.related).to.equal('@security/oauth')
    })

    it('produces a flat list of every typed bv-* element in document order', () => {
      const html = `<bv-topic path="x" title="t">
  <bv-reason>r</bv-reason>
  <bv-rule severity="must" id="r-1">rule one</bv-rule>
  <bv-rule severity="should" id="r-2">rule two</bv-rule>
  <bv-decision id="d-1">decision</bv-decision>
</bv-topic>`
      const result = readHtmlTopicSync(html)
      const tags = result.elements.map((e) => e.tag)
      expect(tags).to.deep.equal(['bv-topic', 'bv-reason', 'bv-rule', 'bv-rule', 'bv-decision'])
    })

    it('preserves attribute maps on each element entry', () => {
      const html = '<bv-topic path="x" title="t"><bv-rule severity="must" id="r-1">x</bv-rule></bv-topic>'
      const result = readHtmlTopicSync(html)
      const rule = result.elements.find((e) => e.tag === 'bv-rule')
      expect(rule).to.not.equal(undefined)
      expect(rule!.attributes.severity).to.equal('must')
      expect(rule!.attributes.id).to.equal('r-1')
    })

    it('skips unknown bv-* elements (closed vocabulary)', () => {
      const html = '<bv-topic path="x" title="t"><bv-not-a-thing></bv-not-a-thing></bv-topic>'
      const result = readHtmlTopicSync(html)
      const tags = result.elements.map((e) => e.tag)
      expect(tags).to.not.include('bv-not-a-thing')
    })

    it('returns empty topicAttributes when no bv-topic root is present', () => {
      const result = readHtmlTopicSync('<p>no bv-topic here</p>')
      expect(Object.keys(result.topicAttributes)).to.have.lengthOf(0)
    })

    it('does not throw on malformed HTML (parse5 is forgiving)', () => {
      // Unclosed bv-topic, mismatched nesting — parse5 returns a best-effort tree.
      expect(() => readHtmlTopicSync('<bv-topic path="x" title="t"><bv-rule>unclosed')).to.not.throw()
    })

    it('does not double-count nested bv-* elements (depth-first walk visits each once)', () => {
      // bv-topic is the root; bv-decision contains a bv-rule. Both should
      // appear in the elements list, each exactly once.
      const html = `<bv-topic path="x" title="t">
  <bv-decision id="d-1">
    <bv-rule severity="must">nested rule</bv-rule>
  </bv-decision>
</bv-topic>`
      const result = readHtmlTopicSync(html)
      const ruleCount = result.elements.filter((e) => e.tag === 'bv-rule').length
      expect(ruleCount).to.equal(1)
    })

    it('lifts attributes off the FIRST bv-topic encountered, not the first non-empty one', () => {
      // Malformed input: a zero-attribute `<bv-topic>` followed by a
      // sibling that carries attributes. The contract says topic
      // attributes are lifted off the root — so the empty map wins.
      // Without this guarantee, downstream consumers (BM25 title hint,
      // element-axis index keys) silently disagree about which root
      // they're describing.
      const html = '<bv-topic></bv-topic><bv-topic path="b" title="second"></bv-topic>'
      const result = readHtmlTopicSync(html)
      expect(Object.keys(result.topicAttributes)).to.have.lengthOf(0)
    })
  })

  describe('readHtmlTopic (FS-backed wrapper)', () => {
    it('round-trips through the filesystem and returns the parsed shape', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'html-reader-fs-'))
      const path = join(dir, 'topic.html')
      try {
        await writeFile(
          path,
          '<bv-topic path="x" title="t" summary="s"><bv-rule severity="must">r</bv-rule></bv-topic>',
          'utf8',
        )
        const result = await readHtmlTopic(path)
        expect(result.topicAttributes.title).to.equal('t')
        expect(result.topicAttributes.summary).to.equal('s')
        expect(result.elements.map((e) => e.tag)).to.deep.equal(['bv-topic', 'bv-rule'])
        expect(result.bodyText).to.include('r')
      } finally {
        await rm(dir, {force: true, recursive: true})
      }
    })
  })
})
