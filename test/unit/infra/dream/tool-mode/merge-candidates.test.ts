import {expect} from 'chai'
import sinon from 'sinon'

import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../../../../src/agent/infra/sandbox/tools-sdk.js'

import {
  findMergeCandidates,
  type MergeCandidateTopic,
} from '../../../../../src/server/infra/dream/tool-mode/merge-candidates.js'

function topic(overrides: Partial<MergeCandidateTopic>): MergeCandidateTopic {
  return {
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

describe('findMergeCandidates', () => {
  it('returns empty for fewer than two topics', async () => {
    const result = await findMergeCandidates({
      searchService: searchStubReturning({}),
      topics: [topic({path: 'a.html'})],
    })
    expect(result).to.deep.equal([])
  })

  it('returns a merge pair when two topics match above the default 0.85 threshold', async () => {
    const topics = [
      topic({path: 'redis/cache_settings.html', title: 'Redis cache'}),
      topic({path: 'redis/cache_config.html', title: 'Redis cache'}),
    ]
    const search = searchStubReturning({
      'Redis cache': [
        {path: 'redis/cache_settings.html', score: 0.92},
        {path: 'redis/cache_config.html', score: 0.92},
      ],
    })

    const result = await findMergeCandidates({searchService: search, topics})

    expect(result).to.have.length(1)
    expect(result[0].pair).to.deep.equal(['redis/cache_config.html', 'redis/cache_settings.html'])
    expect(result[0].score).to.be.closeTo(0.92, 0.001)
  })

  it('uses a higher default threshold than link (0.85): drops pairs at 0.7', async () => {
    const topics = [
      topic({path: 'a.html', title: 'A'}),
      topic({path: 'b.html', title: 'B'}),
    ]
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.7}],
      B: [{path: 'a.html', score: 0.7}],
    })

    const result = await findMergeCandidates({searchService: search, topics})

    expect(result).to.deep.equal([])
  })

  it('does NOT exclude already-linked pairs (linking is for distinct topics; merge is for duplicates)', async () => {
    const topics = [
      topic({path: 'a.html', title: 'A'}),
      topic({path: 'b.html', title: 'B'}),
    ]
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.9}],
      B: [{path: 'a.html', score: 0.9}],
    })

    const result = await findMergeCandidates({searchService: search, topics})

    // Merge generator has no awareness of the existing `related` attribute —
    // a near-duplicate that happens to already be linked is still a valid
    // merge candidate.
    expect(result).to.have.length(1)
  })

  it('excludes self-matches', async () => {
    const topics = [topic({path: 'a.html', title: 'A'})]
    const search = searchStubReturning({A: [{path: 'a.html', score: 0.99}]})

    const result = await findMergeCandidates({searchService: search, topics})
    expect(result).to.deep.equal([])
  })

  it('deduplicates symmetric pairs and keeps higher score', async () => {
    const topics = [
      topic({path: 'a.html', title: 'A'}),
      topic({path: 'b.html', title: 'B'}),
    ]
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.9}],
      B: [{path: 'a.html', score: 0.86}],
    })

    const result = await findMergeCandidates({searchService: search, topics})
    expect(result).to.have.length(1)
    expect(result[0].score).to.be.closeTo(0.9, 0.001)
  })

  it('respects maxCandidates cap, sorted by score desc', async () => {
    const topics = [
      topic({path: 'a.html', title: 'A'}),
      topic({path: 'b.html', title: 'B'}),
      topic({path: 'c.html', title: 'C'}),
    ]
    const search = searchStubReturning({
      A: [
        {path: 'b.html', score: 0.86},
        {path: 'c.html', score: 0.95},
      ],
      B: [
        {path: 'a.html', score: 0.86},
        {path: 'c.html', score: 0.88},
      ],
      C: [
        {path: 'a.html', score: 0.95},
        {path: 'b.html', score: 0.88},
      ],
    })

    const result = await findMergeCandidates({options: {maxCandidates: 2}, searchService: search, topics})
    expect(result).to.have.length(2)
    expect(result[0].pair).to.deep.equal(['a.html', 'c.html'])
    expect(result[1].pair).to.deep.equal(['b.html', 'c.html'])
  })

  it('includes both topics full HTML in each candidate (for agent merge authoring)', async () => {
    const topics = [
      {html: '<bv-topic path="a.html" title="A">aaa-body</bv-topic>', path: 'a.html', summary: '', title: 'A'},
      {html: '<bv-topic path="b.html" title="B">bbb-body</bv-topic>', path: 'b.html', summary: '', title: 'B'},
    ]
    const search = searchStubReturning({
      A: [{path: 'b.html', score: 0.95}],
      B: [{path: 'a.html', score: 0.95}],
    })

    const result = await findMergeCandidates({searchService: search, topics})
    expect(result[0].htmlA).to.contain('aaa-body')
    expect(result[0].htmlB).to.contain('bbb-body')
  })

  it('respects scope filter', async () => {
    const topics = [
      topic({path: 'redis/cache_a.html', title: 'cache A'}),
      topic({path: 'redis/cache_b.html', title: 'cache A'}),
      topic({path: 'other/cache_c.html', title: 'cache A'}),
    ]
    const search = searchStubReturning({
      'cache A': [
        {path: 'redis/cache_a.html', score: 0.95},
        {path: 'redis/cache_b.html', score: 0.95},
        {path: 'other/cache_c.html', score: 0.95},
      ],
    })

    const result = await findMergeCandidates({options: {scope: 'redis/'}, searchService: search, topics})
    expect(result).to.have.length(1)
    expect(result[0].pair).to.deep.equal(['redis/cache_a.html', 'redis/cache_b.html'])
  })
})
