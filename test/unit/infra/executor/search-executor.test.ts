import {expect} from 'chai'
import sinon from 'sinon'

import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../../../src/agent/infra/sandbox/tools-sdk.js'

import {SearchExecutor} from '../../../../src/server/infra/executor/search-executor.js'

function makeSearchResult(count: number): SearchKnowledgeResult {
  return {
    message: `Found ${count} results`,
    results: Array.from({length: count}, (_, i) => ({
      excerpt: `Excerpt for result ${i + 1}`,
      path: `domain/topic-${i + 1}.md`,
      score: 0.9 - i * 0.1,
      title: `Topic ${i + 1}`,
    })),
    totalFound: count,
  }
}

function makeMockService(result: SearchKnowledgeResult): ISearchKnowledgeService {
  return {
    search: sinon.stub().resolves(result),
  }
}

describe('SearchExecutor', () => {
  it('passes query to search service and returns results', async () => {
    const result = makeSearchResult(3)
    const service = makeMockService(result)
    const executor = new SearchExecutor(service)

    const actual = await executor.execute({query: 'authentication'})

    expect((service.search as sinon.SinonStub).calledWith('authentication', {limit: 10})).to.be.true
    expect(actual).to.equal(result)
    expect(actual.results).to.have.length(3)
    expect(actual.totalFound).to.equal(3)
  })

  it('respects custom limit', async () => {
    const service = makeMockService(makeSearchResult(5))
    const executor = new SearchExecutor(service)

    await executor.execute({limit: 5, query: 'test'})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 5})).to.be.true
  })

  it('caps limit at 50', async () => {
    const service = makeMockService(makeSearchResult(0))
    const executor = new SearchExecutor(service)

    await executor.execute({limit: 100, query: 'test'})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 50})).to.be.true
  })

  it('floors limit at 1', async () => {
    const service = makeMockService(makeSearchResult(0))
    const executor = new SearchExecutor(service)

    await executor.execute({limit: 0, query: 'test'})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 1})).to.be.true
  })

  it('truncates fractional limit', async () => {
    const service = makeMockService(makeSearchResult(0))
    const executor = new SearchExecutor(service)

    await executor.execute({limit: 7.9, query: 'test'})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 7})).to.be.true
  })

  it('passes scope when provided', async () => {
    const service = makeMockService(makeSearchResult(1))
    const executor = new SearchExecutor(service)

    await executor.execute({query: 'test', scope: 'auth/'})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 10, scope: 'auth/'})).to.be.true
  })

  it('passes trailing-slash scope unchanged (normalization is service responsibility)', async () => {
    const service = makeMockService(makeSearchResult(1))
    const executor = new SearchExecutor(service)

    await executor.execute({query: 'test', scope: 'project/'})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 10, scope: 'project/'})).to.be.true
  })

  it('omits scope when not provided', async () => {
    const service = makeMockService(makeSearchResult(1))
    const executor = new SearchExecutor(service)

    await executor.execute({query: 'test'})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 10})).to.be.true
  })

  it('returns empty results for empty query without calling service', async () => {
    const service = makeMockService(makeSearchResult(1))
    const executor = new SearchExecutor(service)

    const actual = await executor.execute({query: ''})

    expect(actual.results).to.have.length(0)
    expect(actual.totalFound).to.equal(0)
    expect((service.search as sinon.SinonStub).called).to.be.false
  })

  it('returns empty results for whitespace-only query', async () => {
    const service = makeMockService(makeSearchResult(1))
    const executor = new SearchExecutor(service)

    const actual = await executor.execute({query: '   '})

    expect(actual.results).to.have.length(0)
    expect((service.search as sinon.SinonStub).called).to.be.false
  })

  it('trims whitespace-only scope to undefined', async () => {
    const service = makeMockService(makeSearchResult(1))
    const executor = new SearchExecutor(service)

    await executor.execute({query: 'test', scope: '  '})

    expect((service.search as sinon.SinonStub).calledWith('test', {limit: 10})).to.be.true
  })

  it('returns empty results when service finds nothing', async () => {
    const emptyResult = makeSearchResult(0)
    const service = makeMockService(emptyResult)
    const executor = new SearchExecutor(service)

    const actual = await executor.execute({query: 'nonexistent topic'})

    expect(actual.results).to.have.length(0)
    expect(actual.totalFound).to.equal(0)
  })

  it('propagates service errors', async () => {
    const service: ISearchKnowledgeService = {
      search: sinon.stub().rejects(new Error('index corrupted')),
    }
    const executor = new SearchExecutor(service)

    try {
      await executor.execute({query: 'test'})
      expect.fail('Should have thrown')
    } catch (error) {
      expect((error as Error).message).to.equal('index corrupted')
    }
  })

})
