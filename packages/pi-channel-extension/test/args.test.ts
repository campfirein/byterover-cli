import {expect} from 'chai'

import {parseArgs} from '../src/args.js'

describe('parseArgs', () => {
  it('splits whitespace-separated tokens', () => {
    expect(parseArgs('list a b')).to.deep.equal({
      flags: {},
      positional: ['a', 'b'],
      subcommand: 'list',
    })
  })

  it('groups double-quoted text into a single positional', () => {
    expect(parseArgs('mention pi-rev "@echo hi there"')).to.deep.equal({
      flags: {},
      positional: ['pi-rev', '@echo hi there'],
      subcommand: 'mention',
    })
  })

  it('honours \\" escapes inside a quoted token', () => {
    const parsed = parseArgs('mention pi "say \\"hello\\" please"')
    expect(parsed.subcommand).to.equal('mention')
    expect(parsed.positional).to.deep.equal(['pi', 'say "hello" please'])
  })

  it('honours \\\\ escape inside a quoted token', () => {
    const parsed = parseArgs('mention pi "path\\\\to\\\\thing"')
    expect(parsed.positional).to.deep.equal(['pi', 'path\\to\\thing'])
  })

  it('parses --flag value pairs', () => {
    expect(parseArgs('invite pi-rev @echo --profile echo')).to.deep.equal({
      flags: {profile: 'echo'},
      positional: ['pi-rev', '@echo'],
      subcommand: 'invite',
    })
  })

  it('treats lone --flag as boolean true', () => {
    expect(parseArgs('list --verbose')).to.deep.equal({
      flags: {verbose: 'true'},
      positional: [],
      subcommand: 'list',
    })
  })

  it('returns undefined subcommand on empty input', () => {
    expect(parseArgs('')).to.deep.equal({
      flags: {},
      positional: [],
      subcommand: undefined,
    })
  })
})
