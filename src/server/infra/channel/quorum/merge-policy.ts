import type {Finding, MergedQuorum} from '../../../core/domain/channel/quorum.js'
import type {IMergePolicy, MergeContext} from '../../../core/interfaces/channel/i-merge-policy.js'

// Phase 10 Slice 10.1 — Tier 1 default merge policy + Tier 2/3 scaffolds.
//
// CrdtUnionMergePolicy is a commutative + associative merge over findings,
// bucketed by claimHash. Singletons land in pending (codex Q3). Contradiction
// detection is deferred to Tier 2 — Tier 1's contradicted[] is always []
// (codex C4 + C6 — the policy keeps the invariant).

export class NotImplementedError extends Error {
  constructor(name: string) {
    super(`NotImplemented: ${name} is a scaffold for Tier 2/3 wiring.`)
    this.name = 'NotImplementedError'
  }
}

function unionEvidence(into: Finding['evidence'], from: Finding['evidence']): Finding['evidence'] {
  // Kimi R1: collision-proof dedupe key — JSON.stringify cannot be smuggled
  // into via separator-injection (any U+241F separator scheme can).
  const seen = new Set<string>()
  const out: Finding['evidence'] = []
  for (const span of [...into, ...from]) {
    const key = JSON.stringify([span.source, span.startLine ?? null, span.endLine ?? null, span.excerpt])
    if (!seen.has(key)) {
      seen.add(key)
      out.push(span)
    }
  }

  return out
}

function pickContributors(bucket: Finding[]): Finding {
  // Surface a deterministic representative finding for the bucket. Sort
  // primarily by agent (so we show a real agent's wording), tie-break on
  // sourceDeliveryId so multiple findings from the same agent with the same
  // claimHash still produce a stable representative — kimi R1.
  const sorted = [...bucket].sort((a, b) => {
    const byAgent = a.agent.localeCompare(b.agent)
    if (byAgent !== 0) return byAgent
    return a.sourceDeliveryId.localeCompare(b.sourceDeliveryId)
  })
  const representative = sorted[0]
  let evidence: Finding['evidence'] = []
  for (const f of sorted) {
    evidence = unionEvidence(evidence, f.evidence)
  }

  return {
    ...representative,
    evidence,
  }
}

export class CrdtUnionMergePolicy implements IMergePolicy {
  readonly minQuorum = 1
  readonly name = 'crdt-union'

  merge(perAgentFindings: Map<string, Finding[]>, context: MergeContext): MergedQuorum {
    const buckets = new Map<string, {agents: Set<string>; findings: Finding[];}>()

    const sortedAgents = [...perAgentFindings.keys()].sort((a, b) => a.localeCompare(b))
    for (const agent of sortedAgents) {
      const findings = perAgentFindings.get(agent) ?? []
      for (const f of findings) {
        const existing = buckets.get(f.claimHash)
        if (existing) {
          existing.findings.push(f)
          existing.agents.add(agent)
        } else {
          buckets.set(f.claimHash, {agents: new Set([agent]), findings: [f]})
        }
      }
    }

    const agreed: Finding[] = []
    const pending: Finding[] = []
    // Kimi R3+R5: iterate sorted entries() so we can drop the non-null
    // assertion AND order output by human-meaningful canonicalClaim
    // (tie-break on claimHash for determinism).
    const orderedBuckets = [...buckets.values()]
      .map(b => ({agents: b.agents, representative: pickContributors(b.findings)}))
      .sort((a, b) => {
        const byClaim = a.representative.canonicalClaim.localeCompare(b.representative.canonicalClaim)
        if (byClaim !== 0) return byClaim
        return a.representative.claimHash.localeCompare(b.representative.claimHash)
      })
    for (const {agents, representative} of orderedBuckets) {
      // Kimi R2: singleton claims (only one agent) ALWAYS land in pending,
      // even at quorumThreshold=1 — per codex Q3, "singletons land in
      // `pending`, NEVER in `agreed`."
      if (agents.size === 1) {
        pending.push(representative)
        continue
      }

      if (agents.size >= context.quorumThreshold) {
        agreed.push(representative)
      } else {
        pending.push(representative)
      }
    }

    const expected = new Set(context.expectedAgents)
    const selected = new Set(context.selectedAgents)
    const coveredAgents = [...selected].sort()
    const missingAgents = [...expected].filter(a => !selected.has(a)).sort()
    const partial = missingAgents.length > 0

    return {
      agreed,
      contradicted: [],
      coveredAgents,
      mergedAt: context.now().toISOString(),
      missingAgents,
      partial,
      pending,
    }
  }
}

export class MajorityMergePolicy implements IMergePolicy {
  readonly minQuorum = 1
  readonly name = 'majority'

  merge(_perAgentFindings: Map<string, Finding[]>, _context: MergeContext): MergedQuorum {
    throw new NotImplementedError('MajorityMergePolicy')
  }
}

export class AdversarialFilterMergePolicy implements IMergePolicy {
  readonly minQuorum = 2
  readonly name = 'adversarial-filter'

  merge(_perAgentFindings: Map<string, Finding[]>, _context: MergeContext): MergedQuorum {
    throw new NotImplementedError('AdversarialFilterMergePolicy')
  }
}
