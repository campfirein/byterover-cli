import {expect} from 'chai'

import {decodeBase64Url, encodeBase64Url} from '../../../../src/server/utils/base64url.js'
import {encodeBase64Url as webuiEncodeBase64Url} from '../../../../src/webui/lib/base64url.js'

describe('server base64url', () => {
  const cases: Array<[string, string]> = [
    ['ASCII POSIX path', '/Users/foo/repo'],
    ['Windows path with backslashes', String.raw`C:\Users\foo\Projects\repo`],
    ['Path with non-ASCII (Cyrillic)', '/home/Müller/проекты/repo'],
    ['Path with CJK', '/Users/foo/日本語/repo'],
    ['Path with emoji', '/Users/foo/📁/repo'],
  ]

  for (const [label, input] of cases) {
    it(`round-trips ${label}`, () => {
      expect(decodeBase64Url(encodeBase64Url(input))).to.equal(input)
    })

    it(`agrees with the webui encoder for ${label}`, () => {
      expect(encodeBase64Url(input)).to.equal(webuiEncodeBase64Url(input))
    })
  }

  it('produces output without padding or non-URL-safe characters', () => {
    const encoded = encodeBase64Url('/Users/foo/+slash/and-equals=')
    expect(encoded).to.match(/^[\dA-Za-z\-_]+$/)
  })
})
