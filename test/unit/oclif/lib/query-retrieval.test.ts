/**
 * query-retrieval tests.
 *
 * Covers (1) the envelope-shape contract — wire keys + status values
 * are part of the public protocol once SKILL.md ships against this
 * shape; renaming any key is a breaking change — and (2) the file-IO
 * + render helper `readMatchContent`.
 *
 * The full `runRetrieval` flow is daemon-coupled (submits a
 * `query-tool-mode` task and consumes the envelope); that path is
 * exercised by the auto-test harness rather than mocked unit tests —
 * stubbing `waitForTaskCompletion` cleanly under ESM is awkward and
 * adds fragility without proportional coverage.
 */

import {expect} from 'chai'
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  type QueryToolModeEnvelope,
  type QueryToolModeMatchedDoc,
  readMatchContent,
} from '../../../../src/oclif/lib/query-retrieval.js'

describe('query-retrieval', () => {
  describe('envelope-shape contract', () => {
    it('admits an ok envelope with populated matchedDocs + metadata', () => {
      const envelope: QueryToolModeEnvelope = {
        matchedDocs: [
          {
            format: 'html',
            path: 'security/auth.html',
            // eslint-disable-next-line camelcase
            rendered_md: '# Authentication',
            score: 0.847,
            title: 'JWT authentication',
          },
          {
            format: 'markdown',
            path: 'legacy/notes.md',
            // eslint-disable-next-line camelcase
            rendered_md: '# Old notes',
            score: 0.412,
            title: 'Legacy notes',
          },
        ],
        metadata: {
          cacheHit: null,
          durationMs: 142,
          skippedSharedCount: 0,
          tier: 2,
          topScore: 0.847,
          totalFound: 2,
        },
        status: 'ok',
      }

      expect(envelope.status).to.equal('ok')
      expect(envelope.matchedDocs).to.have.lengthOf(2)
      expect(envelope.matchedDocs[0].format).to.equal('html')
      expect(envelope.matchedDocs[1].format).to.equal('markdown')
      expect(envelope.metadata.topScore).to.equal(0.847)
    })

    it('admits a no-matches envelope with empty matchedDocs', () => {
      const envelope: QueryToolModeEnvelope = {
        matchedDocs: [],
        metadata: {
          cacheHit: null,
          durationMs: 38,
          skippedSharedCount: 0,
          tier: 2,
          topScore: 0,
          totalFound: 0,
        },
        status: 'no-matches',
      }

      expect(envelope.status).to.equal('no-matches')
      expect(envelope.matchedDocs).to.deep.equal([])
      expect(envelope.metadata.totalFound).to.equal(0)
    })

    it('admits a cache-hit envelope with metadata.cacheHit set', () => {
      // Both `'exact'` (Tier 0) and `'fuzzy'` (Tier 1) are part of the
      // contract. The harness asserts that repeated queries surface
      // the hit so calling agents can decide whether to refresh.
      const exactHit: QueryToolModeMatchedDoc[] = []
      const envelope: QueryToolModeEnvelope = {
        matchedDocs: exactHit,
        metadata: {
          cacheHit: 'exact',
          durationMs: 3,
          skippedSharedCount: 0,
          tier: 0,
          topScore: 0,
          totalFound: 0,
        },
        status: 'ok',
      }

      expect(envelope.metadata.cacheHit).to.equal('exact')
      expect(envelope.metadata.tier).to.equal(0)
    })
  })

  describe('readMatchContent (T2 helper)', () => {
    let contextTreeRoot: string

    beforeEach(async () => {
      contextTreeRoot = await mkdtemp(join(tmpdir(), 'brv-query-retrieval-test-'))
    })

    afterEach(async () => {
      await rm(contextTreeRoot, {force: true, recursive: true})
    })

    it('returns html format with renderedContent != rawContent for a .html topic', async () => {
      const relPath = 'security/auth.html'
      const raw =
        '<bv-topic path="security/auth" title="JWT auth"><bv-fact subject="exp" value="24h">JWT expires in 24h</bv-fact></bv-topic>'
      await mkdir(join(contextTreeRoot, 'security'), {recursive: true})
      await writeFile(join(contextTreeRoot, relPath), raw, 'utf8')

      const result = await readMatchContent(contextTreeRoot, relPath)
      expect(result).to.not.be.undefined
      expect(result?.format).to.equal('html')
      expect(result?.rawContent).to.equal(raw)
      // Rendered markdown strips raw bv-* markup; the source bytes
      // must NOT pass through unchanged.
      expect(result?.renderedContent).to.not.equal(raw)
      expect(result?.renderedContent).to.not.include('<bv-topic')
    })

    it('returns markdown format with renderedContent === rawContent for a .md topic', async () => {
      const relPath = 'legacy/notes.md'
      const raw = '# Notes\n\nThis is legacy markdown.\n'
      await mkdir(join(contextTreeRoot, 'legacy'), {recursive: true})
      await writeFile(join(contextTreeRoot, relPath), raw, 'utf8')

      const result = await readMatchContent(contextTreeRoot, relPath)
      expect(result).to.not.be.undefined
      expect(result?.format).to.equal('markdown')
      expect(result?.rawContent).to.equal(raw)
      expect(result?.renderedContent).to.equal(raw)
    })

    it('treats .HTML (uppercase) as html', async () => {
      const relPath = 'caps/topic.HTML'
      const raw = '<bv-topic path="caps/topic" title="caps"></bv-topic>'
      await mkdir(join(contextTreeRoot, 'caps'), {recursive: true})
      await writeFile(join(contextTreeRoot, relPath), raw, 'utf8')

      const result = await readMatchContent(contextTreeRoot, relPath)
      expect(result?.format).to.equal('html')
    })

    it('returns undefined when the file does not exist', async () => {
      const result = await readMatchContent(contextTreeRoot, 'missing/topic.html')
      expect(result).to.be.undefined
    })

    it('returns undefined when the path resolves to a directory', async () => {
      await mkdir(join(contextTreeRoot, 'a-directory'), {recursive: true})
      const result = await readMatchContent(contextTreeRoot, 'a-directory')
      expect(result).to.be.undefined
    })
  })
})
