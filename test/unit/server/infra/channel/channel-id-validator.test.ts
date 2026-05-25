import {expect} from 'chai'

import {
  CHANNEL_ID_PATTERN_STRING,
  isValidChannelId,
} from '../../../../../src/server/infra/channel/channel-id-validator.js'

// Phase 9.5.4 — shared channelId validation tests.

describe('isValidChannelId', () => {
  describe('valid channelIds', () => {
    for (const id of ['abc', 'a', 'cc-chat', 'my-channel', 'a1', '1a', 'a'.repeat(64)]) {
      it(`accepts "${id}"`, () => {
        expect(isValidChannelId(id)).to.equal(true)
      })
    }
  })

  describe('invalid channelIds', () => {
    for (const [id, reason] of [
      ['-starts-with-dash', 'starts with hyphen'],
      ['Uppercase', 'uppercase letter'],
      ['has space', 'contains space'],
      ['has_underscore', 'contains underscore'],
      ['a'.repeat(65), 'too long (65 chars)'],
      ['', 'empty string'],
      ['ALLCAPS', 'all uppercase'],
      ['has.dot', 'contains dot'],
    ] as [string, string][]) {
      it(`rejects "${id}" (${reason})`, () => {
        expect(isValidChannelId(id)).to.equal(false)
      })
    }
  })

  it('exports the pattern string for use in error messages', () => {
    expect(CHANNEL_ID_PATTERN_STRING).to.be.a('string')
    expect(CHANNEL_ID_PATTERN_STRING).to.include('^')
    expect(CHANNEL_ID_PATTERN_STRING).to.include('$')
  })
})
