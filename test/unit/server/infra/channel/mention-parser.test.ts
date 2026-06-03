import {expect} from 'chai'

import {parseMentions} from '../../../../../src/server/infra/channel/mention-parser.js'

describe('parseMentions', () => {
  it('extracts a leading @handle', () => {
    expect(parseMentions('@mock do the thing')).to.deep.equal(['@mock'])
  })

  it('dedupes in first-occurrence order', () => {
    expect(parseMentions('hey @a and @b then @a again')).to.deep.equal(['@a', '@b'])
  })

  it('returns an empty list when there are no mentions', () => {
    expect(parseMentions('no mentions here')).to.deep.equal([])
  })

  it('does not treat an email address as a mention', () => {
    expect(parseMentions('ping hoang@byterover.dev please')).to.deep.equal([])
  })
})
