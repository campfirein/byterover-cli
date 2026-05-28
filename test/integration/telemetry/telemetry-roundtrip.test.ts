import {expect} from 'chai'
import {mkdir, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {CurateLogEntry} from '../../../src/server/core/domain/entities/curate-log-entry.js'
import type {QueryLogEntry} from '../../../src/server/core/domain/entities/query-log-entry.js'

import {FileCurateLogStore} from '../../../src/server/infra/storage/file-curate-log-store.js'
import {FileQueryLogStore} from '../../../src/server/infra/storage/file-query-log-store.js'

describe('Telemetry roundtrip (ENG-2741)', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = join(tmpdir(), `brv-telemetry-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tempDir, {recursive: true})
  })

  afterEach(async () => {
    await rm(tempDir, {force: true, recursive: true}).catch(() => {})
  })

  describe('QueryLogEntry', () => {
    it('round-trips all new telemetry fields through disk', async () => {
      const store = new FileQueryLogStore({baseDir: tempDir})
      const id = await store.getNextId()

      const entry: QueryLogEntry = {
        cacheCreationTokens: 50,
        cachedInputTokens: 200,
        completedAt: 1_700_000_001_000,
        format: 'markdown',
        id,
        inputTokens: 1000,
        matchedDocs: [{path: 'design/caching.md', score: 0.95, title: 'Caching'}],
        outputTokens: 250,
        query: 'how does caching work',
        response: 'Caching uses Redis...',
        searchMetadata: {resultCount: 1, topScore: 0.95, totalFound: 5},
        startedAt: 1_700_000_000_000,
        status: 'completed',
        taskId: 'task-abc',
        tier: 3,
        timing: {durationMs: 1200, llmMs: 950, searchMs: 80, totalMs: 1200},
      }

      await store.save(entry)
      const loaded = await store.getById(id)

      expect(loaded).to.not.be.undefined
      expect(loaded?.format).to.equal('markdown')
      expect(loaded?.inputTokens).to.equal(1000)
      expect(loaded?.outputTokens).to.equal(250)
      expect(loaded?.cachedInputTokens).to.equal(200)
      expect(loaded?.cacheCreationTokens).to.equal(50)
      expect(loaded?.timing).to.deep.equal({durationMs: 1200, llmMs: 950, searchMs: 80, totalMs: 1200})
    })

    it("populates 'html' format when produced by an HTML-aware detector path", async () => {
      const store = new FileQueryLogStore({baseDir: tempDir})
      const id = await store.getNextId()

      const entry: QueryLogEntry = {
        completedAt: 1_700_000_001_000,
        format: 'html',
        id,
        matchedDocs: [{path: 'design/caching.html', score: 0.9, title: 'Caching'}],
        query: 'how does caching work',
        response: '...',
        startedAt: 1_700_000_000_000,
        status: 'completed',
        taskId: 'task-html',
      }

      await store.save(entry)
      const loaded = await store.getById(id)

      expect(loaded?.format).to.equal('html')
    })

    it('parses back-compat entries (pre-ENG-2741, no new fields)', async () => {
      const store = new FileQueryLogStore({baseDir: tempDir})
      const id = 'qry-1700000000000'
      const oldFixture = {
        completedAt: 1_700_000_001_000,
        id,
        matchedDocs: [],
        query: 'old query',
        response: 'old response',
        startedAt: 1_700_000_000_000,
        status: 'completed',
        taskId: 'task-old',
        timing: {durationMs: 500},
      }
      await mkdir(join(tempDir, 'query-log'), {recursive: true})
      await writeFile(join(tempDir, 'query-log', `${id}.json`), JSON.stringify(oldFixture))

      const loaded = await store.getById(id)

      expect(loaded).to.not.be.undefined
      expect(loaded?.format).to.be.undefined
      expect(loaded?.inputTokens).to.be.undefined
      expect(loaded?.cachedInputTokens).to.be.undefined
      expect(loaded?.timing?.durationMs).to.equal(500)
      expect(loaded?.timing?.totalMs).to.be.undefined
    })

    it('writes entry without new fields and reads it back identically', async () => {
      const store = new FileQueryLogStore({baseDir: tempDir})
      const id = await store.getNextId()

      // startedAt = Date.now() so resolveStale doesn't rewrite this 'processing' entry as 'error'.
      // FileQueryLogStore.resolveStale flips entries older than STALE_PROCESSING_THRESHOLD_MS.
      const minimalEntry: QueryLogEntry = {
        id,
        matchedDocs: [],
        query: 'minimal',
        startedAt: Date.now(),
        status: 'processing',
        taskId: 'task-min',
      }

      await store.save(minimalEntry)
      const loaded = await store.getById(id)

      expect(loaded?.status).to.equal('processing')
      expect(loaded?.format).to.be.undefined
      expect(loaded?.inputTokens).to.be.undefined
    })
  })

  describe('CurateLogEntry', () => {
    it('round-trips all new telemetry fields through disk', async () => {
      const store = new FileCurateLogStore({baseDir: tempDir})
      const id = await store.getNextId()

      const entry: CurateLogEntry = {
        cacheCreationTokens: 100,
        cachedInputTokens: 500,
        completedAt: 1_700_000_005_000,
        format: 'markdown',
        id,
        input: {context: 'curated content'},
        inputTokens: 5000,
        operations: [],
        outputTokens: 1500,
        startedAt: 1_700_000_000_000,
        status: 'completed',
        summary: {added: 1, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: 'task-curate',
        timing: {llmMs: 4500, totalMs: 5000},
      }

      await store.save(entry)
      const loaded = await store.getById(id)

      expect(loaded).to.not.be.null
      expect(loaded?.format).to.equal('markdown')
      expect(loaded?.inputTokens).to.equal(5000)
      expect(loaded?.outputTokens).to.equal(1500)
      expect(loaded?.cachedInputTokens).to.equal(500)
      expect(loaded?.cacheCreationTokens).to.equal(100)
      expect(loaded?.timing).to.deep.equal({llmMs: 4500, totalMs: 5000})
    })

    it('parses back-compat entries (pre-ENG-2741, no new fields)', async () => {
      const store = new FileCurateLogStore({baseDir: tempDir})
      const id = 'cur-1700000000000'
      const oldFixture = {
        completedAt: 1_700_000_005_000,
        id,
        input: {context: 'old'},
        operations: [],
        startedAt: 1_700_000_000_000,
        status: 'completed',
        summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
        taskId: 'task-old',
      }
      await mkdir(join(tempDir, 'curate-log'), {recursive: true})
      await writeFile(join(tempDir, 'curate-log', `${id}.json`), JSON.stringify(oldFixture))

      const loaded = await store.getById(id)

      expect(loaded).to.not.be.null
      expect(loaded?.format).to.be.undefined
      expect(loaded?.inputTokens).to.be.undefined
      expect(loaded?.timing).to.be.undefined
    })
  })
})
