import {expect} from 'chai'
import sinon from 'sinon'

import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../../../../src/agent/infra/sandbox/tools-sdk.js'

import {
  findLinkCandidates,
  type LinkCandidateTopic,
} from '../../../../../src/server/infra/dream/tool-mode/link-candidates.js'

function topic(overrides: Partial<LinkCandidateTopic>): LinkCandidateTopic {
  return {
    alreadyLinkedTo: [],
    html: `<bv-topic path="${overrides.path ?? 'x.html'}" title="x"/>`,
    path: 'x.html',
    summary: '',
    title: 'x',
    ...overrides,
  }
}

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

describe('findLinkCandidates', () => {
  it('returns empty when there are no topics', async () => {
    const result = await findLinkCandidates({
      searchService: searchStubReturning({}),
      topics: [],
    })
    expect(result).to.deep.equal([])
  })

  it('returns a pair when two topics match above the score threshold', async () => {
    const topics = [
      topic({path: 'a.html', summary: 'auth', title: 'A'}),
      topic({path: 'b.html', summary: 'auth', title: 'B'}),
    ]
    // Search keys are title-only — summary is intentionally NOT appended
    // to the BM25 query, because doing so makes the query so specific
    // that BM25 ranks only the source topic itself.
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.72}],
      B: [{path: 'a.html', score: 0.72}],
    })

    const result = await findLinkCandidates({searchService: search, topics})

    expect(result).to.have.length(1)
    expect(result[0].pair).to.deep.equal(['a.html', 'b.html'])
    expect(result[0].score).to.be.closeTo(0.72, 0.001)
  })

  it('uses title only (not title+summary) as the BM25 query — regression for over-specific query bug', async () => {
    const topics = [
      topic({path: 'a.html', summary: 'this whole long summary would over-specify the query', title: 'JWT'}),
      topic({path: 'b.html', summary: 'unrelated summary text', title: 'OAuth'}),
    ]
    const stub = sinon.stub<[string, ...unknown[]], Promise<SearchKnowledgeResult>>()
    stub.callsFake(async (): Promise<SearchKnowledgeResult> => ({
      message: '',
      results: [{excerpt: '', path: 'b.html', score: 0.8, title: 'b'}],
      totalFound: 1,
    }))
    const search: ISearchKnowledgeService = {refreshIndex: sinon.stub().resolves(), search: stub}

    await findLinkCandidates({searchService: search, topics})

    // Each topic's search call should pass title only, no summary tokens.
    const calledQueries = stub.getCalls().map((c) => c.args[0])
    expect(calledQueries).to.include('JWT')
    expect(calledQueries).to.include('OAuth')
    for (const q of calledQueries) {
      expect(q).to.not.match(/summary/i, `query "${q}" should not contain summary tokens`)
    }
  })

  it('drops pairs whose score is below the threshold', async () => {
    const topics = [
      topic({path: 'a.html', title: 'A'}),
      topic({path: 'b.html', title: 'B'}),
    ]
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.4}],
      B: [{path: 'a.html', score: 0.4}],
    })

    const result = await findLinkCandidates({
      options: {scoreThreshold: 0.5},
      searchService: search,
      topics,
    })

    expect(result).to.deep.equal([])
  })

  it('excludes self-matches', async () => {
    const topics = [topic({path: 'a.html', title: 'A'})]
    const search = searchStubReturning({
      A: [{path: 'a.html', score: 0.99}],
    })

    const result = await findLinkCandidates({searchService: search, topics})

    expect(result).to.deep.equal([])
  })

  it('excludes pairs that are already linked (via bv-topic related attr)', async () => {
    const topics = [
      topic({alreadyLinkedTo: ['b.html'], path: 'a.html', title: 'A'}),
      topic({alreadyLinkedTo: ['a.html'], path: 'b.html', title: 'B'}),
    ]
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.8}],
      B: [{path: 'a.html', score: 0.8}],
    })

    const result = await findLinkCandidates({searchService: search, topics})

    expect(result).to.deep.equal([])
  })

  it('deduplicates symmetric pairs (A→B and B→A become one pair)', async () => {
    const topics = [
      topic({path: 'a.html', title: 'A'}),
      topic({path: 'b.html', title: 'B'}),
    ]
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.8}],
      B: [{path: 'a.html', score: 0.6}],
    })

    const result = await findLinkCandidates({searchService: search, topics})

    expect(result).to.have.length(1)
    // Keeps the higher score of the two symmetric hits
    expect(result[0].score).to.be.closeTo(0.8, 0.001)
  })

  it('respects maxCandidates by returning highest-scored pairs first', async () => {
    const topics = [
      topic({path: 'a.html', title: 'A'}),
      topic({path: 'b.html', title: 'B'}),
      topic({path: 'c.html', title: 'C'}),
    ]
    const search = searchStubReturning({
      A: [
        {path: 'b.html', score: 0.55},
        {path: 'c.html', score: 0.95},
      ],
      B: [
        {path: 'a.html', score: 0.55},
        {path: 'c.html', score: 0.75},
      ],
      C: [
        {path: 'a.html', score: 0.95},
        {path: 'b.html', score: 0.75},
      ],
    })

    const result = await findLinkCandidates({
      options: {maxCandidates: 2},
      searchService: search,
      topics,
    })

    expect(result).to.have.length(2)
    // Top two by score: A↔C (0.95) and B↔C (0.75)
    expect(result[0].pair).to.deep.equal(['a.html', 'c.html'])
    expect(result[1].pair).to.deep.equal(['b.html', 'c.html'])
  })

  it('filters topics by scope prefix when provided', async () => {
    const topics = [
      topic({path: 'security/a.html', title: 'A'}),
      topic({path: 'security/b.html', title: 'B'}),
      topic({path: 'other/c.html', title: 'C'}),
    ]
    const search = searchStubReturning({
      A: [
        {path: 'security/b.html', score: 0.8},
        {path: 'other/c.html', score: 0.9},
      ],
      B: [
        {path: 'security/a.html', score: 0.8},
        {path: 'other/c.html', score: 0.85},
      ],
    })

    const result = await findLinkCandidates({
      options: {scope: 'security/'},
      searchService: search,
      topics,
    })

    // Only security/a.html ↔ security/b.html should appear; other/c.html
    // is outside the scope so it's neither searched from nor included as a hit.
    expect(result).to.have.length(1)
    expect(result[0].pair).to.deep.equal(['security/a.html', 'security/b.html'])
  })

  it('includes both topics full HTML in the returned candidate', async () => {
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.8}],
      B: [{path: 'a.html', score: 0.8}],
    })

    const result = await findLinkCandidates({
      searchService: search,
      topics: [
        {alreadyLinkedTo: [], html: '<bv-topic path="a.html" title="A">aaa</bv-topic>', path: 'a.html', summary: '', title: 'A'},
        {alreadyLinkedTo: [], html: '<bv-topic path="b.html" title="B">bbb</bv-topic>', path: 'b.html', summary: '', title: 'B'},
      ],
    })

    expect(result[0].htmlA).to.contain('aaa')
    expect(result[0].htmlB).to.contain('bbb')
  })
})
