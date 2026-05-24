import {expect} from 'chai'
import {existsSync} from 'node:fs'
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import sinon from 'sinon'

import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../../../../src/agent/infra/sandbox/tools-sdk.js'

import {finalizeDreamSession, scanDreamCandidates} from '../../../../../src/server/infra/dream/tool-mode/dream-session.js'
import {createMockRuntimeSignalStore} from '../../../../helpers/mock-factories.js'

function searchStubReturning(map: Record<string, Array<{path: string; score: number}>>): ISearchKnowledgeService {
  return {
    refreshIndex: sinon.stub().resolves(),
    search: sinon.stub().callsFake(async (query: string): Promise<SearchKnowledgeResult> => {
      const hits = map[query] ?? []
      return {
        message: '',
        results: hits.map((h) => ({excerpt: '', path: h.path, score: h.score, title: h.path})),
        totalFound: hits.length,
      }
    }),
  }
}

describe('dream-session', () => {
describe('scanDreamCandidates', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `brv-dream-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(dir, {recursive: true})
  })

  afterEach(async () => {
    await rm(dir, {force: true, recursive: true})
  })

  it('returns a session id and empty candidate sets when context tree is empty', async () => {
    const result = await scanDreamCandidates({
      contextTreeRoot: dir,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      searchService: searchStubReturning({}),
    })

    expect(result.sessionId).to.match(/^[\da-f]{8}-[\da-f]{4}/i)
    expect(result.candidates.link).to.deep.equal([])
    expect(result.candidates.merge).to.deep.equal([])
    expect(result.candidates.prune).to.deep.equal([])
    expect(result.candidates.synthesize).to.deep.equal({domains: [], existingSyntheses: []})
  })

  it('surfaces link candidates for matching topics in two domains', async () => {
    await writeFile(
      join(dir, 'a.html'),
      '<bv-topic path="security/jwt" title="JWT" summary="auth"/>',
      'utf8',
    )
    await writeFile(
      join(dir, 'b.html'),
      '<bv-topic path="security/oauth" title="OAuth" summary="auth"/>',
      'utf8',
    )

    const result = await scanDreamCandidates({
      contextTreeRoot: dir,
      options: {kinds: ['link']},
      runtimeSignalStore: createMockRuntimeSignalStore(),
      searchService: searchStubReturning({
        JWT: [{path: 'b.html', score: 0.8}],
        OAuth: [{path: 'a.html', score: 0.8}],
      }),
    })

    expect(result.candidates.link).to.have.length(1)
    expect(result.candidates.link[0].pair).to.deep.equal(['a.html', 'b.html'])
  })

  it('only surfaces the kinds requested via options.kinds', async () => {
    await writeFile(join(dir, 'a.html'), '<bv-topic path="a" title="A"/>', 'utf8')
    await writeFile(join(dir, 'b.html'), '<bv-topic path="b" title="B"/>', 'utf8')

    const result = await scanDreamCandidates({
      contextTreeRoot: dir,
      options: {kinds: ['prune']},
      runtimeSignalStore: createMockRuntimeSignalStore(),
      searchService: searchStubReturning({}),
    })

    expect(result.candidates.link).to.deep.equal([])
    expect(result.candidates.merge).to.deep.equal([])
    // prune may or may not have entries based on signals; key is that link/merge are skipped
  })

  it('runs all four kinds when no kinds filter is given (default)', async () => {
    await writeFile(join(dir, 'a.html'), '<bv-topic path="a" title="A"/>', 'utf8')
    await writeFile(join(dir, 'b.html'), '<bv-topic path="b" title="B"/>', 'utf8')

    const result = await scanDreamCandidates({
      contextTreeRoot: dir,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      searchService: searchStubReturning({}),
    })

    // All four fields are present (even if empty)
    expect(result.candidates).to.have.keys('link', 'merge', 'prune', 'synthesize')
  })

  it('forces a search-service index refresh before generating candidates', async () => {
    // Tool-mode dream operates on a freshly-loaded topic set. Without an
    // explicit refresh, the search service can serve TTL-cached results
    // that pre-date the just-written seed files — surfacing zero
    // candidates on the first scan and warming up only on the second.
    // The refresh call must come from inside scanDreamCandidates so
    // every consumer (CLI, MCP, tests) gets fresh ranking on demand.
    await writeFile(join(dir, 'a.html'), '<bv-topic path="a" title="A"/>', 'utf8')

    const searchService = searchStubReturning({})
    await scanDreamCandidates({
      contextTreeRoot: dir,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      searchService,
    })

    expect(
      (searchService.refreshIndex as sinon.SinonStub).called,
      'scanDreamCandidates must call searchService.refreshIndex() to bypass TTL-stale cache',
    ).to.equal(true)
  })

  it('passes combineWith: "OR" to the search service for pair-discovery queries', async () => {
    // Dream pair-discovery queries by source title verbatim. AND-first
    // combine (the search-service default) collapses multi-word titles
    // like "Redis Caching Layer" to self-only matches, hiding legitimate
    // cross-pairs. Pair-discovery must opt into OR-combine for any-term
    // recall — verified here at the seam between dream-session and the
    // search service.
    await writeFile(join(dir, 'a.html'), '<bv-topic path="a" title="Alpha"/>', 'utf8')
    await writeFile(join(dir, 'b.html'), '<bv-topic path="b" title="Beta"/>', 'utf8')

    const searchService = searchStubReturning({})
    await scanDreamCandidates({
      contextTreeRoot: dir,
      options: {kinds: ['link', 'merge']},
      runtimeSignalStore: createMockRuntimeSignalStore(),
      searchService,
    })

    const searchStub = searchService.search as sinon.SinonStub
    expect(searchStub.called, 'expected search() to be invoked at least once').to.equal(true)
    for (const call of searchStub.getCalls()) {
      const opts = call.args[1]
      expect(
        opts?.combineWith,
        `every pair-discovery search call must pass combineWith: 'OR'; got ${JSON.stringify(opts)}`,
      ).to.equal('OR')
    }
  })
})

describe('finalizeDreamSession', () => {
  let dir: string

  beforeEach(async () => {
    dir = join(tmpdir(), `brv-dream-finalize-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(join(dir, '.brv', 'context-tree'), {recursive: true})
  })

  afterEach(async () => {
    await rm(dir, {force: true, recursive: true})
  })

  it('moves each named topic from context-tree to .brv/archive', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    await writeFile(join(ctRoot, 'foo.html'), '<bv-topic path="foo" title="F"/>', 'utf8')
    await writeFile(join(ctRoot, 'bar.html'), '<bv-topic path="bar" title="B"/>', 'utf8')

    const result = await finalizeDreamSession({
      archive: ['foo.html', 'bar.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(result.archived).to.deep.equal(['foo.html', 'bar.html'])
    expect(result.skipped).to.deep.equal([])

    expect(existsSync(join(ctRoot, 'foo.html'))).to.equal(false)
    expect(existsSync(join(ctRoot, 'bar.html'))).to.equal(false)
    expect(existsSync(join(dir, '.brv', 'archive', 'foo.html'))).to.equal(true)
    expect(existsSync(join(dir, '.brv', 'archive', 'bar.html'))).to.equal(true)
  })

  it('preserves the topic content in the archived file', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    const html = '<bv-topic path="foo" title="F">precious content</bv-topic>'
    await writeFile(join(ctRoot, 'foo.html'), html, 'utf8')

    await finalizeDreamSession({
      archive: ['foo.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    const archived = await readFile(join(dir, '.brv', 'archive', 'foo.html'), 'utf8')
    expect(archived).to.equal(html)
  })

  it('preserves nested directory structure under .brv/archive', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    await mkdir(join(ctRoot, 'security'), {recursive: true})
    await writeFile(join(ctRoot, 'security', 'old.html'), '<bv-topic path="security/old" title="O"/>', 'utf8')

    await finalizeDreamSession({
      archive: ['security/old.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(existsSync(join(dir, '.brv', 'archive', 'security', 'old.html'))).to.equal(true)
  })

  it('skips paths that no longer exist with reason="not-found"', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')

    const result = await finalizeDreamSession({
      archive: ['ghost.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(result.archived).to.deep.equal([])
    expect(result.skipped).to.deep.equal([{path: 'ghost.html', reason: 'not-found'}])
  })

  it('drops the sidecar entry for archived topics', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    await writeFile(join(ctRoot, 'foo.html'), '<bv-topic path="foo" title="F"/>', 'utf8')
    const store = createMockRuntimeSignalStore()
    await store.set('foo.html', (await store.get('foo.html')))

    await finalizeDreamSession({
      archive: ['foo.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: store,
      sessionId: 'sess-test',
    })

    const signals = await store.list()
    expect(signals.has('foo.html')).to.equal(false)
  })

  it('captures original content as previousTexts so undo can restore archives', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    const fooHtml = '<bv-topic path="foo" title="F">precious content here</bv-topic>'
    const barHtml = '<bv-topic path="bar" title="B">other content</bv-topic>'
    await writeFile(join(ctRoot, 'foo.html'), fooHtml, 'utf8')
    await writeFile(join(ctRoot, 'bar.html'), barHtml, 'utf8')

    const result = await finalizeDreamSession({
      archive: ['foo.html', 'bar.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(result.previousTexts).to.have.keys('foo.html', 'bar.html')
    expect(result.previousTexts['foo.html']).to.equal(fooHtml)
    expect(result.previousTexts['bar.html']).to.equal(barHtml)
  })

  it('captures pre-archive mtime and signals so undo can restore the observable state', async () => {
    // Without this metadata, undo restores the file body but resets mtime
    // to now and signals to defaults. A topic archived as low-importance
    // (15) or stale-mtime (>60d) would silently fall out of prune-candidate
    // range on the next scan because its observable state was lost.
    const ctRoot = join(dir, '.brv', 'context-tree')
    await writeFile(join(ctRoot, 'stale.html'), '<bv-topic path="stale" title="S"/>', 'utf8')

    // Backdate mtime to 70 days ago to mirror a real stale-mtime prune target.
    const seventyDaysAgoMs = Date.now() - 70 * 24 * 60 * 60 * 1000
    const seventyDaysAgo = new Date(seventyDaysAgoMs)
    const {utimes} = await import('node:fs/promises')
    await utimes(join(ctRoot, 'stale.html'), seventyDaysAgo, seventyDaysAgo)

    // Pre-seed the sidecar with non-default signals so we can verify capture.
    const store = createMockRuntimeSignalStore()
    await store.set('stale.html', {
      accessCount: 0,
      importance: 15,
      maturity: 'draft',
      recency: 1,
      updateCount: 0,
    })

    const result = await finalizeDreamSession({
      archive: ['stale.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: store,
      sessionId: 'sess-test',
    })

    expect(result.previousMtimes['stale.html']).to.be.closeTo(seventyDaysAgoMs, 2000)
    expect(result.previousSignals['stale.html']).to.deep.include({importance: 15, maturity: 'draft'})
  })

  it('omits previousTexts entries for paths that were skipped', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')

    const result = await finalizeDreamSession({
      archive: ['ghost.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(result.archived).to.deep.equal([])
    expect(result.previousTexts).to.deep.equal({})
  })

  it('reports reason="already-archived" when rename loses a concurrent-finalize race (ENOENT)', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    await writeFile(join(ctRoot, 'foo.html'), '<bv-topic path="foo" title="F"/>', 'utf8')

    // finalizeDreamSession does Promise.all internally over the archive
    // array. Listing the same path twice forces a real concurrent race:
    // both callbacks pass existsSync + readFile, then both attempt
    // rename — one wins (archived), one loses with ENOENT (should be
    // surfaced as 'already-archived' rather than the generic 'rename-failed').
    const result = await finalizeDreamSession({
      archive: ['foo.html', 'foo.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(result.archived).to.deep.equal(['foo.html'])
    expect(result.skipped).to.deep.equal([{path: 'foo.html', reason: 'already-archived'}])
  })

  it('rejects archive paths that escape the context tree with reason="unsafe-path"', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    // Place a sentinel file outside the context tree that an attacker would target.
    const sentinel = join(dir, 'outside.html')
    await writeFile(sentinel, '<bv-topic path="outside" title="O"/>', 'utf8')

    const result = await finalizeDreamSession({
      archive: ['../../outside.html', 'foo/../../escape.html'],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(result.archived).to.deep.equal([])
    expect(result.skipped).to.have.length(2)
    for (const s of result.skipped) {
      expect(s.reason).to.equal('unsafe-path')
    }

    // Sentinel must remain untouched.
    expect(existsSync(sentinel)).to.equal(true)
  })

  it('returns empty summary for an empty archive list', async () => {
    const ctRoot = join(dir, '.brv', 'context-tree')
    const result = await finalizeDreamSession({
      archive: [],
      brvDir: join(dir, '.brv'),
      contextTreeRoot: ctRoot,
      runtimeSignalStore: createMockRuntimeSignalStore(),
      sessionId: 'sess-test',
    })

    expect(result.archived).to.deep.equal([])
    expect(result.skipped).to.deep.equal([])
  })
})
})
