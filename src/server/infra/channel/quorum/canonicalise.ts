import {createHash} from 'node:crypto'

// Phase 10 Slice 10.1 — Tier 1 lexical canonicalisation for Finding.claimHash.
//
// Per codex Q8: equality only. Same canonical text → same sha256 → same bucket.
// Hash-prefix similarity is NOT a signal. Semantic / paraphrase-aware
// canonicalisation (lemma normalisation, contradiction detection) is a Tier 2
// concern and lives outside this module.

const LEADING_TRAILING_PUNCTUATION = /^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu

export function canonicaliseClaimText(claim: string): string {
  const normalised = claim.normalize('NFKC').toLowerCase()
  const collapsed = normalised.replaceAll(/\s+/g, ' ')
  const trimmed = collapsed.replaceAll(LEADING_TRAILING_PUNCTUATION, '')
  return trimmed
}

export function claimHash(canonical: string): string {
  return createHash('sha256').update(canonical).digest('hex')
}
