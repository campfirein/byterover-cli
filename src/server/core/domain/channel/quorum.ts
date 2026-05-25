// Phase 10 Slice 10.1 — Finding / MergedQuorum domain types.
//
// `Finding` is the unit a single agent emits during quorum dispatch. Multiple
// agents emit findings; the merge policy buckets them by `claimHash`.
// `MergedQuorum` is the output of the merge.
//
// Per codex Q8: claimHash is for equality only — never prefix-similarity.
// Per codex Q2/Q8: schemaVersion is shipped in Tier 1 so a Tier-2 schema
// bump can gate without retrofitting Finding.

export const FINDING_SCHEMA_VERSION = '1.0.0' as const

export type EvidenceSpan = {
  readonly endLine?: number
  readonly excerpt: string
  readonly source: string
  readonly startLine?: number
}

export type Finding = {
  readonly agent: string
  readonly canonicalClaim: string
  readonly claim: string
  readonly claimHash: string

  readonly confidence?: number
  readonly emittedAt: string
  readonly evidence: EvidenceSpan[]

  readonly partitionKey?: string
  readonly role?: string

  readonly schemaVersion: string
  readonly sourceDeliveryId: string

  readonly sourceTurnId: string
}

export type MergedQuorum = {
  readonly agreed: Finding[]
  readonly contradicted: Array<{
    readonly positions: Finding[]
    readonly summary: string
  }>
  readonly coveredAgents: string[]
  readonly mergedAt: string
  readonly missingAgents: string[]
  readonly partial: boolean
  readonly pending: Finding[]
}
