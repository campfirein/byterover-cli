import {expect} from 'chai'
import {createHash} from 'node:crypto'

import {
  canonicaliseClaimText,
  claimHash,
} from '../../../../../../src/server/infra/channel/quorum/canonicalise.js'

// Phase 10 Slice 10.1 — lexical normaliser + sha256 hasher for Finding.claimHash.
// Tier 1 ships pure equality; no prefix-similarity, no semantic comparison.

describe('quorum/canonicalise', () => {
describe('canonicaliseClaimText', () => {
  it('lowercases input', () => {
    expect(canonicaliseClaimText('Hello World')).to.equal('hello world')
  })

  it('collapses internal whitespace to single spaces', () => {
    expect(canonicaliseClaimText('hello    world')).to.equal('hello world')
    expect(canonicaliseClaimText('hello\t\nworld')).to.equal('hello world')
  })

  it('trims leading and trailing whitespace', () => {
    expect(canonicaliseClaimText('  hello world  ')).to.equal('hello world')
  })

  it('strips leading and trailing punctuation', () => {
    expect(canonicaliseClaimText('"Hello world."')).to.equal('hello world')
    expect(canonicaliseClaimText('!!hello world??')).to.equal('hello world')
    expect(canonicaliseClaimText(',,, hello world ;;;')).to.equal('hello world')
  })

  it('preserves internal punctuation', () => {
    expect(canonicaliseClaimText("it's a test, really.")).to.equal("it's a test, really")
  })

  it('NFKC-normalises compatibility characters', () => {
    const composed = canonicaliseClaimText('café')
    const decomposed = canonicaliseClaimText('café')
    expect(composed).to.equal(decomposed)
  })

  it('NFKC-normalises full-width digits to ASCII digits', () => {
    expect(canonicaliseClaimText('１２３')).to.equal('123')
  })

  it('returns identical canonical form for case + leading/trailing-punctuation + whitespace variants', () => {
    // Tier 1: lexical only. Same words, only differ in case + outer-padding
    // (whitespace or punctuation) → same canonical. Internal punctuation
    // intentionally stays distinguishing (see Tier 2 follow-up).
    const a = canonicaliseClaimText('Hello world')
    const b = canonicaliseClaimText('  hello  world  ')
    const c = canonicaliseClaimText('"HELLO WORLD!"')
    expect(a).to.equal(b)
    expect(b).to.equal(c)
  })

  it('returns empty string for input that is only whitespace + punctuation', () => {
    expect(canonicaliseClaimText('   ,!?  ')).to.equal('')
  })

  it('is idempotent: canon(canon(x)) === canon(x)', () => {
    const once = canonicaliseClaimText('  Hello, World!  ')
    const twice = canonicaliseClaimText(once)
    expect(twice).to.equal(once)
  })
})

describe('claimHash', () => {
  it('returns a stable sha256 hex of the canonical input', () => {
    const expected = createHash('sha256').update('hello world').digest('hex')
    expect(claimHash('hello world')).to.equal(expected)
  })

  it('is deterministic for the same canonical input', () => {
    const a = claimHash('hello world')
    const b = claimHash('hello world')
    expect(a).to.equal(b)
  })

  it('returns different hashes for different canonical strings', () => {
    expect(claimHash('hello world')).to.not.equal(claimHash('hello worlds'))
  })

  it('codex Q8 anti-test: hash-prefix collision does NOT collapse different canonicals', () => {
    // Two canonical strings with different content must produce different
    // full hashes — Tier 1 uses equality, never prefix similarity.
    const aHash = claimHash('alpha bravo charlie')
    const bHash = claimHash('alpha bravo delta')
    expect(aHash).to.not.equal(bHash)
    // Even if they happened to share a leading prefix, equality MUST be over
    // the full hex string; pin this by asserting the hashes are strict-not-equal
    // (not "startsWith" or similar).
    expect(aHash === bHash).to.equal(false)
  })

  it('produces a 64-character lowercase hex digest', () => {
    const h = claimHash('anything')
    expect(h).to.match(/^[0-9a-f]{64}$/)
  })
})
})
