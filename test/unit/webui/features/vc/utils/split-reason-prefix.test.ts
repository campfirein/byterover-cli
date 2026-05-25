import {expect} from 'chai'

import {splitReasonPrefix} from '../../../../../../src/webui/features/vc/utils/split-reason-prefix'

describe('splitReasonPrefix', () => {
  it('joins source and action with a colon for dream/consolidate', () => {
    const result = splitReasonPrefix('[dream/consolidate] merged X and Y')
    expect(result).to.deep.equal({body: 'merged X and Y', prefix: 'dream:consolidate'})
  })

  it('joins source and action with a colon for dream/synthesize', () => {
    const result = splitReasonPrefix('[dream/synthesize] Generated synthesis draft')
    expect(result).to.deep.equal({body: 'Generated synthesis draft', prefix: 'dream:synthesize'})
  })

  it('joins source and action with a colon for dream/prune', () => {
    const result = splitReasonPrefix('[dream/prune] archived stale doc')
    expect(result).to.deep.equal({body: 'archived stale doc', prefix: 'dream:prune'})
  })

  it('returns prefix undefined and body unchanged when no bracketed prefix is present', () => {
    const result = splitReasonPrefix('Initial curation of CLI structure knowledge')
    expect(result).to.deep.equal({body: 'Initial curation of CLI structure knowledge', prefix: undefined})
  })

  it('handles an empty body after the bracket', () => {
    const result = splitReasonPrefix('[dream/consolidate]')
    expect(result).to.deep.equal({body: '', prefix: 'dream:consolidate'})
  })

  it('preserves multi-line bodies', () => {
    const result = splitReasonPrefix('[dream/consolidate] line one\nline two')
    expect(result).to.deep.equal({body: 'line one\nline two', prefix: 'dream:consolidate'})
  })

  it('does not match malformed prefixes (missing slash)', () => {
    const result = splitReasonPrefix('[dream] body')
    expect(result).to.deep.equal({body: '[dream] body', prefix: undefined})
  })

  it('does not match prefixes with nested slashes in the action segment', () => {
    const result = splitReasonPrefix('[dream/sub/action] body')
    expect(result).to.deep.equal({body: '[dream/sub/action] body', prefix: undefined})
  })
})
