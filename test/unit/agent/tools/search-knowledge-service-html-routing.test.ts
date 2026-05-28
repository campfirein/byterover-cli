/**
 * Search service HTML-routing tests.
 *
 * The indexer dispatches on file extension when reading topic content:
 * `.html` files go through `readHtmlTopicSync` (entity-decoded inner
 * text + structured element list); `.md` files are passed verbatim to
 * the BM25 tokenizer for backward compatibility (e.g. `brv swarm`,
 * legacy projects).
 *
 * These tests cover:
 *   - HTML files are indexed (glob discovers them; the BM25 tokenizer
 *     sees inner text, not raw markup).
 *   - The `format` field on each result correctly reflects the source
 *     file's extension.
 *   - Mixed-format corpora produce unified ranked results.
 *   - The optional `elementHint` pre-filter restricts BM25 candidates
 *     to topics matching a `<bv-*>` shape.
 */

import {expect} from 'chai'
import {createSandbox, SinonStub} from 'sinon'

import type {IFileSystem} from '../../../../src/agent/core/interfaces/i-file-system.js'

import {createSearchKnowledgeService} from '../../../../src/agent/infra/tools/implementations/search-knowledge-service.js'

const HTML_TOPIC = `<bv-topic path="security/auth" title="JWT authentication" summary="JWT design and refresh flow">
  <bv-reason>Document JWT authentication design.</bv-reason>
  <bv-rule severity="must" id="r-1">Always validate signatures.</bv-rule>
  <bv-rule severity="should" id="r-2">Rotate signing keys every 30 days.</bv-rule>
  <bv-decision id="d-1">Use RS256 over HS256.</bv-decision>
</bv-topic>`

const MD_TOPIC = `# OAuth Authentication
This document describes the OAuth 2.0 authentication flow used in our application.
The flow involves redirect, user consent, and code exchange for tokens.`

describe('Search Service HTML routing', () => {
  const sandbox = createSandbox()
  let fileSystemMock: IFileSystem
  let globFilesStub: SinonStub
  let listDirectoryStub: SinonStub
  let readFileStub: SinonStub

  beforeEach(() => {
    globFilesStub = sandbox.stub()
    listDirectoryStub = sandbox.stub()
    readFileStub = sandbox.stub()

    fileSystemMock = {
      editFile: sandbox.stub(),
      globFiles: globFilesStub,
      initialize: sandbox.stub(),
      listDirectory: listDirectoryStub,
      readFile: readFileStub,
      searchContent: sandbox.stub(),
      writeFile: sandbox.stub(),
    } as unknown as IFileSystem
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('extension-based dispatch', () => {
    beforeEach(() => {
      listDirectoryStub.resolves({count: 2, entries: [], tree: '', truncated: false})
      globFilesStub.resolves({
        files: [
          {
            isDirectory: false,
            modified: new Date('2026-04-27'),
            path: '/test/.brv/context-tree/security/auth.html',
            size: HTML_TOPIC.length,
          },
          {
            isDirectory: false,
            modified: new Date('2026-04-27'),
            path: '/test/.brv/context-tree/oauth.md',
            size: MD_TOPIC.length,
          },
        ],
        ignoredCount: 0,
        message: 'Found 2 files',
        totalFound: 2,
        truncated: false,
      })

      readFileStub.callsFake((filePath: string) => {
        if (filePath.endsWith('.html')) {
          return Promise.resolve({content: HTML_TOPIC, encoding: 'utf8', lines: 6, size: HTML_TOPIC.length, totalLines: 6, truncated: false})
        }

        if (filePath.endsWith('.md')) {
          return Promise.resolve({content: MD_TOPIC, encoding: 'utf8', lines: 3, size: MD_TOPIC.length, totalLines: 3, truncated: false})
        }

        return Promise.reject(new Error(`unexpected readFile: ${filePath}`))
      })
    })

    it('discovers and indexes HTML topic files alongside markdown', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      // Search for a term that appears only in the HTML topic's inner text.
      const result = await service.search('signatures')

      const htmlMatch = result.results.find((r) => r.path.endsWith('.html'))
      expect(htmlMatch, 'expected the HTML topic to appear in results').to.not.equal(undefined)
    })

    it('populates format="html" on results from .html files', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      const result = await service.search('JWT')

      const htmlMatch = result.results.find((r) => r.path.endsWith('.html'))
      expect(htmlMatch?.format).to.equal('html')
    })

    it('populates format="markdown" on results from .md files', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      const result = await service.search('OAuth authentication')

      const mdMatch = result.results.find((r) => r.path.endsWith('.md'))
      expect(mdMatch?.format).to.equal('markdown')
    })

    it('strips HTML markup before BM25 tokenization (raw tag names are not searchable)', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      // The HTML source contains `<bv-rule severity="must">` literally;
      // a search for "bv-rule" should NOT match that markup because
      // the indexer tokenises inner text only.
      const result = await service.search('bv-rule')

      const htmlMatch = result.results.find((r) => r.path.endsWith('.html'))
      expect(htmlMatch, 'HTML topic must not match raw markup').to.equal(undefined)
    })

    it('lifts the bv-topic title attribute as the document title', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      const result = await service.search('JWT')

      const htmlMatch = result.results.find((r) => r.path.endsWith('.html'))
      expect(htmlMatch?.title).to.equal('JWT authentication')
    })
  })

  describe('bv-topic attribute payload reaches BM25', () => {
    // The markdown corpus exposes summary/tags/keywords/related via
    // YAML frontmatter, which the indexer feeds into BM25 verbatim. The
    // HTML branch parses topic attributes off `<bv-topic>` and must
    // concatenate the same set into the BM25 input — otherwise a query
    // for a term living only in `summary=` of an HTML topic ranks far
    // below the equivalent MD topic.
    const FINGERPRINT = 'fingerprintqzz'
    const HTML_WITH_FINGERPRINT_IN_SUMMARY = `<bv-topic path="x" title="t" summary="${FINGERPRINT} appears only here">
  <bv-reason>body has nothing about that term</bv-reason>
</bv-topic>`

    beforeEach(() => {
      listDirectoryStub.resolves({count: 1, entries: [], tree: '', truncated: false})
      globFilesStub.resolves({
        files: [
          {
            isDirectory: false,
            modified: new Date('2026-04-27'),
            path: '/test/.brv/context-tree/x.html',
            size: HTML_WITH_FINGERPRINT_IN_SUMMARY.length,
          },
        ],
        ignoredCount: 0,
        message: 'Found 1 file',
        totalFound: 1,
        truncated: false,
      })
      readFileStub.resolves({
        content: HTML_WITH_FINGERPRINT_IN_SUMMARY,
        encoding: 'utf8',
        lines: 3,
        size: HTML_WITH_FINGERPRINT_IN_SUMMARY.length,
        totalLines: 3,
        truncated: false,
      })
    })

    it('surfaces an HTML topic when the query term lives only in the bv-topic summary attribute', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      const result = await service.search(FINGERPRINT)

      const htmlMatch = result.results.find((r) => r.path.endsWith('.html'))
      expect(htmlMatch, `expected fingerprint in summary= to be searchable`).to.not.equal(undefined)
    })
  })

  describe('title fallback', () => {
    it('falls back to the filename when bv-topic title is empty/whitespace', async () => {
      const HTML_BLANK_TITLE = '<bv-topic path="x" title="   "><bv-reason>tokens here</bv-reason></bv-topic>'

      listDirectoryStub.resolves({count: 1, entries: [], tree: '', truncated: false})
      globFilesStub.resolves({
        files: [
          {
            isDirectory: false,
            modified: new Date('2026-04-27'),
            path: '/test/.brv/context-tree/blank.html',
            size: HTML_BLANK_TITLE.length,
          },
        ],
        ignoredCount: 0,
        message: 'Found 1 file',
        totalFound: 1,
        truncated: false,
      })
      readFileStub.resolves({
        content: HTML_BLANK_TITLE,
        encoding: 'utf8',
        lines: 1,
        size: HTML_BLANK_TITLE.length,
        totalLines: 1,
        truncated: false,
      })

      const service = createSearchKnowledgeService(fileSystemMock)
      const result = await service.search('tokens')

      const htmlMatch = result.results.find((r) => r.path.endsWith('.html'))
      expect(htmlMatch?.title).to.equal('blank')
    })
  })

  describe('elementHint pre-filter', () => {
    beforeEach(() => {
      listDirectoryStub.resolves({count: 2, entries: [], tree: '', truncated: false})

      const HTML_WITH_RULE = `<bv-topic path="a" title="Has rule"><bv-reason>x</bv-reason><bv-rule severity="must">x</bv-rule></bv-topic>`
      const HTML_WITHOUT_RULE = `<bv-topic path="b" title="No rule"><bv-reason>x</bv-reason></bv-topic>`

      globFilesStub.resolves({
        files: [
          {isDirectory: false, modified: new Date('2026-01-01'), path: '/test/.brv/context-tree/a.html', size: HTML_WITH_RULE.length},
          {isDirectory: false, modified: new Date('2026-01-01'), path: '/test/.brv/context-tree/b.html', size: HTML_WITHOUT_RULE.length},
        ],
        ignoredCount: 0,
        message: 'Found 2 files',
        totalFound: 2,
        truncated: false,
      })

      readFileStub.callsFake((filePath: string) => {
        const content = filePath.endsWith('a.html') ? HTML_WITH_RULE : HTML_WITHOUT_RULE
        return Promise.resolve({content, encoding: 'utf8', lines: 1, size: content.length, totalLines: 1, truncated: false})
      })
    })

    it('returns no results when elementHint matches no topic', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      // bv-bug is not present in either fixture; the hint should
      // exclude every document from BM25 ranking.
      const result = await service.search('x', {
        elementHint: {tag: 'bv-bug'},
      })

      expect(result.results).to.have.lengthOf(0)
    })

    it('restricts BM25 candidates to topics matching the elementHint tag', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      const result = await service.search('x', {
        elementHint: {tag: 'bv-rule'},
      })

      // Only `a.html` has bv-rule; `b.html` should be filtered out
      // before BM25 ever sees it.
      expect(result.results).to.have.lengthOf(1)
      expect(result.results[0].path.endsWith('a.html')).to.equal(true)
    })

    it('restricts further by elementHint attribute=value', async () => {
      const service = createSearchKnowledgeService(fileSystemMock)
      const matchResult = await service.search('x', {
        elementHint: {attribute: 'severity', tag: 'bv-rule', value: 'must'},
      })
      expect(matchResult.results).to.have.lengthOf(1)
      expect(matchResult.results[0].path.endsWith('a.html')).to.equal(true)

      const noMatchResult = await service.search('x', {
        elementHint: {attribute: 'severity', tag: 'bv-rule', value: 'should'},
      })
      expect(noMatchResult.results).to.have.lengthOf(0)
    })
  })
})
