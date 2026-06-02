/* eslint-disable camelcase */
import {expect} from 'chai'

import {
  isQueryToolModeType,
  parseQueryToolModeResult,
  queryToolModeRowTitle,
} from '../../../../../../src/webui/features/tasks/utils/query-tool-mode-results.js'

const doc = (overrides: Record<string, unknown> = {}) => ({
  format: 'html',
  path: 'analytics/lifecycle_pipeline.html',
  rendered_md: '# Analytics Lifecycle Pipeline\n\nBody text.',
  score: 0.85,
  title: 'Analytics Lifecycle Pipeline',
  ...overrides,
})

describe('query-tool-mode result parser', () => {
  describe('isQueryToolModeType', () => {
    it('matches query-tool-mode', () => {
      expect(isQueryToolModeType('query-tool-mode')).to.equal(true)
    })

    it('does not match the LLM query type', () => {
      expect(isQueryToolModeType('query')).to.equal(false)
    })

    it('does not match unrelated task types', () => {
      expect(isQueryToolModeType('curate-tool-mode')).to.equal(false)
    })
  })

  describe('parseQueryToolModeResult', () => {
    it('parses a tool-mode result with matched docs', () => {
      const content = JSON.stringify({matchedDocs: [doc()], metadata: {}, status: 'ok'})
      const parsed = parseQueryToolModeResult(content)
      if (!parsed) throw new Error('expected parsed docs')

      expect(parsed).to.have.lengthOf(1)
      const [first] = parsed
      expect(first.title).to.equal('Analytics Lifecycle Pipeline')
      expect(first.path).to.equal('analytics/lifecycle_pipeline.html')
      expect(first.score).to.equal(0.85)
      expect(first.rendered_md).to.contain('Analytics Lifecycle Pipeline')
    })

    it('keeps multiple matched docs in order', () => {
      const content = JSON.stringify({
        matchedDocs: [doc({path: 'a', title: 'A'}), doc({path: 'b', title: 'B'})],
        status: 'ok',
      })
      const parsed = parseQueryToolModeResult(content)
      if (!parsed) throw new Error('expected parsed docs')

      expect(parsed.map((entry) => entry.title)).to.deep.equal(['A', 'B'])
    })

    it('returns an empty array for a no-matches result', () => {
      const content = JSON.stringify({matchedDocs: [], metadata: {}, status: 'no-matches'})
      expect(parseQueryToolModeResult(content)).to.deep.equal([])
    })

    it('drops entries that are missing a required field', () => {
      const content = JSON.stringify({
        matchedDocs: [
          doc(),
          {path: 'x', score: 0.1},
          {score: 0.2, title: 'no path'},
          {path: 'y', title: 'no score'},
        ],
        status: 'ok',
      })
      const parsed = parseQueryToolModeResult(content)
      if (!parsed) throw new Error('expected parsed docs')

      expect(parsed).to.have.lengthOf(1)
    })

    it('returns undefined for malformed JSON', () => {
      expect(parseQueryToolModeResult('not-json{')).to.equal(undefined)
    })

    it('returns undefined when matchedDocs is missing', () => {
      expect(parseQueryToolModeResult(JSON.stringify({status: 'ok'}))).to.equal(undefined)
    })

    it('returns undefined when matchedDocs is not an array', () => {
      expect(parseQueryToolModeResult(JSON.stringify({matchedDocs: 'nope'}))).to.equal(undefined)
    })

    it('returns undefined for a non-object payload', () => {
      expect(parseQueryToolModeResult(JSON.stringify('a string'))).to.equal(undefined)
    })
  })

  describe('queryToolModeRowTitle', () => {
    it('returns the decoded query from an encoded payload', () => {
      const content = JSON.stringify({limit: 10, query: 'agent loop and computer use automation'})
      expect(queryToolModeRowTitle(content)).to.equal('agent loop and computer use automation')
    })

    it('returns undefined when query is missing', () => {
      expect(queryToolModeRowTitle(JSON.stringify({limit: 10}))).to.equal(undefined)
    })

    it('returns undefined for malformed JSON', () => {
      expect(queryToolModeRowTitle('not-json{')).to.equal(undefined)
    })

    it('returns undefined for a non-object payload', () => {
      expect(queryToolModeRowTitle(JSON.stringify('a string'))).to.equal(undefined)
    })
  })
})
