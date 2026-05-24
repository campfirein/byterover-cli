import {expect} from 'chai'

import {decodeBase64Url, encodeBase64Url} from '../../../../src/webui/lib/base64url'

describe('webui base64url', () => {
  describe('round-trip', () => {
    const cases: Array<[string, string]> = [
      ['ASCII POSIX path', '/Users/foo/repo'],
      ['ASCII deep path', '/Users/ncnthien/Documents/projects/byterover-cli-worktree/ENG-2706'],
      ['Windows path with backslashes', String.raw`C:\Users\foo\Projects\repo`],
      ['Windows UNC path', String.raw`\\server\share\repo`],
      ['Path with spaces', '/Users/foo/My Projects/repo'],
      ['Path with non-ASCII (Cyrillic)', '/home/Müller/проекты/repo'],
      ['Path with CJK', '/Users/foo/日本語/repo'],
      ['Path with emoji', '/Users/foo/📁/repo'],
      ['Path with reserved URL chars', '/Users/foo/a+b/c?d&e=f/repo'],
    ]

    for (const [label, input] of cases) {
      it(`survives ${label}`, () => {
        const encoded = encodeBase64Url(input)
        expect(decodeBase64Url(encoded)).to.equal(input)
      })
    }
  })

  describe('output safety', () => {
    it('produces a string containing only URL-safe characters', () => {
      const encoded = encodeBase64Url('/Users/foo/+slash/and-equals=')
      expect(encoded).to.match(/^[\dA-Za-z\-_]+$/)
    })

    it('strips trailing = padding', () => {
      const encoded = encodeBase64Url('/a')
      expect(encoded.endsWith('=')).to.be.false
    })

    it('returns an empty string for empty input', () => {
      expect(encodeBase64Url('')).to.equal('')
      expect(decodeBase64Url('')).to.equal('')
    })
  })

  describe('decode tolerance', () => {
    it('decodes input without padding', () => {
      expect(decodeBase64Url(encodeBase64Url('/a'))).to.equal('/a')
    })
  })
})
