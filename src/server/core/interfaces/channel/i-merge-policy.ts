import type {Finding, MergedQuorum} from '../../domain/channel/quorum.js'

// Phase 10 Slice 10.1 — IMergePolicy contract.
//
// Codex Q1 + C1: merge() takes a MergeContext so Tier 3 features (adversarial
// roles, learned weights, trust metadata) plug in without retrofitting Finding
// or the interface. Tier 1 populates the minimum (channelId, dispatchId,
// taskSchemaHash, pool, expectedAgents, selectedAgents, quorumThreshold, now);
// later tiers fill in perAgentRole / perAgentWeight / perAgentTrust /
// perAgentPool / lowConfidenceThreshold as their features come online.
//
// expectedAgents + selectedAgents are required (codex C1): without them
// merge() cannot honestly compute missingAgents or partial.

export type MergeContext = {
  readonly channelId: string
  readonly dispatchId: string
  readonly expectedAgents: ReadonlyArray<string>

  readonly lowConfidenceThreshold?: number
  readonly now: () => Date
  readonly perAgentPool?: ReadonlyMap<string, 'local' | 'remote'>
  readonly perAgentRole?: ReadonlyMap<string, string>

  readonly perAgentTrust?: ReadonlyMap<string, 'untrusted' | 'verified'>
  readonly perAgentWeight?: ReadonlyMap<string, number>

  readonly pool: 'local' | 'mixed' | 'remote'
  readonly quorumThreshold: number
  readonly selectedAgents: ReadonlyArray<string>

  readonly taskSchemaHash: string
}

export interface IMergePolicy {
  merge(perAgentFindings: Map<string, Finding[]>, context: MergeContext): MergedQuorum
  readonly minQuorum: number
  readonly name: string
}

// Codex Q2 + C2: Tier-3 signed-output support is a signed ENVELOPE around a
// canonical PAYLOAD OBJECT carrying provenance (schema + task + channel +
// dispatch). Per-batch (not per-finding) — codex C2.

export type SignedFindingsPayload = {
  readonly channelId: string
  readonly dispatchId: string
  readonly findings: ReadonlyArray<Finding>
  readonly schemaVersion: string
  readonly taskSchemaHash: string
}

export type SignedFindings = {
  readonly canonicalPayloadJson: string
  readonly publicKey: string
  readonly signature: string
}
