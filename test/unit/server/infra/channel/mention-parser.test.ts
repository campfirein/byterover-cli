import {expect} from 'chai'

import {parseMentions} from '../../../../../src/server/infra/channel/mention-parser.js'

// Slice 2.3 — `@<handle>` mention parser. Multi-mention aware; preserves the
// `@` prefix (canonical handle format from Phase 2). Pure function.

describe('parseMentions', () => {
  it('parses a single handle at word boundary', () => {
    expect(parseMentions('@mock hi')).to.deep.equal(['@mock'])
  })

  it('parses multiple handles and de-duplicates by handle', () => {
    expect(parseMentions('hi @mock and @other plus @mock again')).to.deep.equal([
      '@mock',
      '@other',
    ])
  })

  it('preserves the @ prefix in the output', () => {
    expect(parseMentions('@a')).to.deep.equal(['@a'])
  })

  it('ignores @ followed by whitespace (no handle)', () => {
    expect(parseMentions('email me @ work@x.com')).to.deep.equal([])
  })

  it('returns empty array when no handles present', () => {
    expect(parseMentions('plain text')).to.deep.equal([])
    expect(parseMentions('')).to.deep.equal([])
  })

  it('treats handles separated by punctuation as separate mentions', () => {
    expect(parseMentions('cc @a, @b and @c.')).to.deep.equal(['@a', '@b', '@c'])
  })

  it('preserves first-occurrence order on duplicates', () => {
    expect(parseMentions('@b @a @b @a')).to.deep.equal(['@b', '@a'])
  })
})
