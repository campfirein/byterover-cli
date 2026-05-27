import {expect} from 'chai'

import {hashProjectPath} from '../../../../src/server/utils/hash-path.js'

describe('hashProjectPath', () => {
  it('returns a 64-character lowercase hex sha256 digest', () => {
    const hash = hashProjectPath('/Users/test/project')
    expect(hash).to.match(/^[0-9a-f]{64}$/)
  })

  it('is deterministic — same input yields same hash', () => {
    const a = hashProjectPath('/Users/test/project')
    const b = hashProjectPath('/Users/test/project')
    expect(a).to.equal(b)
  })

  it('differs across different inputs', () => {
    const a = hashProjectPath('/Users/test/project')
    const b = hashProjectPath('/Users/test/other')
    expect(a).to.not.equal(b)
  })

  it('hashes the empty string without throwing', () => {
    const hash = hashProjectPath('')
    expect(hash).to.match(/^[0-9a-f]{64}$/)
  })

  it('treats trailing slash as a distinct path (verbatim hash, no normalization)', () => {
    const a = hashProjectPath('/Users/test/project')
    const b = hashProjectPath('/Users/test/project/')
    expect(a).to.not.equal(b)
  })
})
