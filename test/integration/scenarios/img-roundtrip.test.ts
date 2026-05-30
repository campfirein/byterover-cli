/**
 * Integration test for ENG-3021 — `<img>` round-trips through the read +
 * BM25 index contract.
 *
 * Unit tests in `html-renderer.test.ts` and `html-reader.test.ts` lock the
 * individual functions. This file proves they compose: an `<img>`-bearing
 * HTML topic on disk produces (a) markdown image syntax when rendered for
 * `brv read`, and (b) BM25-discoverable text when its `imageContent` is
 * concatenated into the indexer's input.
 *
 * Out of scope: full daemon + transport orchestration. The auto-test
 * harness `local-auto-test/curate-tool-mode-e2e/run.mjs` exercises the
 * full real-CLI roundtrip; this test is the in-process counterpart.
 */

import {expect} from 'chai'
import MiniSearch from 'minisearch'
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readHtmlTopic} from '../../../src/server/infra/render/reader/html-reader.js'
import {renderHtmlTopicForLlm} from '../../../src/server/infra/render/reader/html-renderer.js'

const SAMPLE_TOPIC = `<bv-topic path="test/img" title="Diagram with image" summary="Verifies <img> survives read + query">
  <bv-reason>Want to keep architecture diagram URLs accessible after curate.</bv-reason>
  <bv-decision id="d-img1">The reference diagram for our system: <img src="https://example.com/architecture/service-mesh.png" alt="System architecture showing service mesh"/>. See the production-track for context.</bv-decision>
  <bv-fact subject="docs">Background docs live alongside the topic.</bv-fact>
</bv-topic>`

// Mirrors what `readIndexableContent` does in search-knowledge-service.ts —
// extracted so the index-side tests can share one composition path.
function buildIndexedContent(parsed: Awaited<ReturnType<typeof readHtmlTopic>>): string {
  const {keywords, related, summary, tags} = parsed.topicAttributes
  return [parsed.bodyText, summary, tags, keywords, related, parsed.imageContent]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
}

// Build a focused MiniSearch index over a single topic — the index-side
// tests share this so the "what does the BM25 contract see" wiring is
// asserted once. Default MiniSearch tokenizer (Unicode whitespace +
// punctuation split) matches the production indexer on this branch.
async function buildSingleTopicIndex(topicPath: string): Promise<MiniSearch> {
  const parsed = await readHtmlTopic(topicPath)
  const indexedContent = buildIndexedContent(parsed)
  const ms = new MiniSearch({
    fields: ['title', 'content', 'path'],
    idField: 'id',
  })
  ms.add({
    content: indexedContent,
    id: 1,
    path: 'test/img.html',
    title: parsed.topicAttributes.title ?? 'untitled',
  })
  return ms
}

describe('<img> roundtrip — render + index integration (ENG-3021)', () => {
  let projectRoot: string
  let topicPath: string

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'img-roundtrip-'))
    const dir = join(projectRoot, '.brv', 'context-tree', 'test')
    mkdirSync(dir, {recursive: true})
    topicPath = join(dir, 'img.html')
    writeFileSync(topicPath, SAMPLE_TOPIC, 'utf8')
  })

  afterEach(() => {
    if (existsSync(projectRoot)) rmSync(projectRoot, {force: true, recursive: true})
  })

  describe('read side (`brv read` path)', () => {
    it('renders the on-disk topic with the `<img>` as CommonMark `![alt](src)`', async () => {
      const read = await readHtmlTopic(topicPath)
      const rendered = renderHtmlTopicForLlm(SAMPLE_TOPIC)
      expect(rendered).to.include('![System architecture showing service mesh](https://example.com/architecture/service-mesh.png)')
      // Surrounding prose stays — the image is inline, not a replacement
      expect(rendered).to.include('The reference diagram for our system:')
      expect(rendered).to.include('See the production-track for context.')
      // imageContent is populated on the parsed result so the indexer can see it
      expect(read.imageContent).to.include('System architecture showing service mesh')
      expect(read.imageContent).to.include('https://example.com/architecture/service-mesh.png')
    })
  })

  describe('index side (`brv query` path)', () => {
    it('query for alt-text phrase ("service mesh") finds the topic — pre-fix this was 0 matches', async () => {
      // The motivating gap. The writer kept `<img alt="...service mesh"/>`
      // intact on disk, but `bodyText` (via `getInnerText`) returned
      // nothing for the void `<img>`. Without `imageContent`, the alt
      // phrase was unindexed and queries for it missed the topic.
      const ms = await buildSingleTopicIndex(topicPath)
      const results = ms.search('service mesh')
      expect(results.length, 'service-mesh query matches').to.be.greaterThan(0)
      expect(results[0].id).to.equal(1)
    })

    it('query for URL host ("example") finds the topic', async () => {
      // The BM25 tokenizer splits URLs on `/`, `:`, `.` so
      // `example.com` becomes two tokens `['example', 'com']` — both
      // present in the indexed content via `extractImageContent`.
      const ms = await buildSingleTopicIndex(topicPath)
      const results = ms.search('example')
      expect(results.length).to.be.greaterThan(0)
    })

    it('query for URL path segment ("service-mesh") finds the topic', async () => {
      const ms = await buildSingleTopicIndex(topicPath)
      const results = ms.search('service-mesh')
      expect(results.length).to.be.greaterThan(0)
    })

    it('query for surrounding prose ("reference diagram") still finds the topic — no regression', async () => {
      // Sanity check: `bodyText` extraction continues to surface the
      // prose around the image. The `<img>` fix is additive — it adds
      // image content to the index without affecting the existing
      // body-text extraction path.
      const ms = await buildSingleTopicIndex(topicPath)
      const results = ms.search('reference diagram')
      expect(results.length).to.be.greaterThan(0)
    })
  })

  describe('topic with no `<img>` is unaffected (regression guard)', () => {
    it('imageContent is empty and indexed content omits the trailing space', async () => {
      // A topic without any `<img>` should produce an indexed-content
      // string that's byte-identical to what the pre-fix indexer
      // produced (modulo the empty-string filter).
      const noImageTopic = '<bv-topic path="test/noimg" title="No image" summary="Plain"><bv-reason>r</bv-reason></bv-topic>'
      const noImageDir = join(projectRoot, '.brv', 'context-tree', 'test')
      const noImagePath = join(noImageDir, 'noimg.html')
      writeFileSync(noImagePath, noImageTopic, 'utf8')

      const parsed = await readHtmlTopic(noImagePath)
      expect(parsed.imageContent).to.equal('')

      const indexed = [parsed.bodyText, parsed.topicAttributes.summary, parsed.imageContent]
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .join(' ')

      expect(indexed).to.include('r')
      expect(indexed).to.include('Plain')
      expect(indexed).to.not.match(/\s\s+/) // no double spaces from empty imageContent
    })
  })
})
