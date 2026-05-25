import {expect} from 'chai'

import {
  type Finding,
  FINDING_SCHEMA_VERSION,
  type MergedQuorum,
} from '../../../../../../src/server/core/domain/channel/quorum.js'
import {type MergeContext} from '../../../../../../src/server/core/interfaces/channel/i-merge-policy.js'
import {
  canonicaliseClaimText,
  claimHash,
} from '../../../../../../src/server/infra/channel/quorum/canonicalise.js'
import {
  AdversarialFilterMergePolicy,
  CrdtUnionMergePolicy,
  MajorityMergePolicy,
} from '../../../../../../src/server/infra/channel/quorum/merge-policy.js'

const FROZEN_ISO = '2026-05-18T00:00:00.000Z'

function mkFinding(over: Partial<Finding> & {agent: string; claim: string;}): Finding {
  const canonical = canonicaliseClaimText(over.claim)
  return {
    agent: over.agent,
    canonicalClaim: canonical,
    claim: over.claim,
    claimHash: claimHash(canonical),
    confidence: over.confidence,
    emittedAt: over.emittedAt ?? FROZEN_ISO,
    evidence: over.evidence ?? [],
    partitionKey: over.partitionKey,
    role: over.role,
    schemaVersion: over.schemaVersion ?? FINDING_SCHEMA_VERSION,
    sourceDeliveryId: over.sourceDeliveryId ?? `delivery-${over.agent}`,
    sourceTurnId: over.sourceTurnId ?? `turn-${over.agent}`,
  }
}

function mkContext(over: Partial<MergeContext> = {}): MergeContext {
  return {
    channelId: 'ch-test',
    dispatchId: 'dispatch-1',
    expectedAgents: ['@a', '@b', '@c'],
    now: () => new Date(FROZEN_ISO),
    pool: 'local',
    quorumThreshold: 2,
    selectedAgents: ['@a', '@b', '@c'],
    taskSchemaHash: 'task-hash-v1',
    ...over,
  }
}

function stripVolatile(m: MergedQuorum): Omit<MergedQuorum, 'mergedAt'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {mergedAt, ...rest} = m
  return rest
}

describe('quorum/merge-policy', () => {
describe('CrdtUnionMergePolicy', () => {
  const policy = new CrdtUnionMergePolicy()

  it('has the expected name and minQuorum', () => {
    expect(policy.name).to.equal('crdt-union')
    expect(policy.minQuorum).to.equal(1)
  })

  it('buckets findings with the same canonical claim across agents into agreed', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'Token leak in auth.py'})]],
      ['@b', [mkFinding({agent: '@b', claim: '  token leak in auth.py  '})]],
    ])
    const result = policy.merge(perAgent, mkContext({expectedAgents: ['@a', '@b'], selectedAgents: ['@a', '@b']}))
    expect(result.agreed).to.have.lengthOf(1)
    expect(result.agreed[0].canonicalClaim).to.equal('token leak in auth.py')
    expect(result.pending).to.have.lengthOf(0)
    expect(result.contradicted).to.deep.equal([])
  })

  it('codex Q3: singleton claims land in pending, NEVER in agreed', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'Only one agent saw this'})]],
    ])
    const result = policy.merge(
      perAgent,
      mkContext({expectedAgents: ['@a'], quorumThreshold: 2, selectedAgents: ['@a']}),
    )
    expect(result.agreed).to.have.lengthOf(0)
    expect(result.pending).to.have.lengthOf(1)
    expect(result.pending[0].agent).to.equal('@a')
  })

  it('kimi R2: singleton at quorumThreshold=1 STILL lands in pending, not agreed', () => {
    // Codex Q3 literal text: "singletons land in `pending`, NEVER in
    // `agreed`" — even when there's only one agent's findings and the
    // threshold would otherwise permit it.
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'lone claim'})]],
    ])
    const result = policy.merge(
      perAgent,
      mkContext({expectedAgents: ['@a'], quorumThreshold: 1, selectedAgents: ['@a']}),
    )
    expect(result.agreed).to.have.lengthOf(0)
    expect(result.pending).to.have.lengthOf(1)
  })

  it('respects context.quorumThreshold for the agreed cut-off', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'shared claim'})]],
      ['@b', [mkFinding({agent: '@b', claim: 'shared claim'})]],
      ['@c', [mkFinding({agent: '@c', claim: 'shared claim'})]],
    ])
    const result = policy.merge(perAgent, mkContext({quorumThreshold: 3}))
    expect(result.agreed).to.have.lengthOf(1)
  })

  it('lands at pending when count is below threshold', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'shared claim'})]],
      ['@b', [mkFinding({agent: '@b', claim: 'shared claim'})]],
    ])
    const result = policy.merge(perAgent, mkContext({quorumThreshold: 3}))
    expect(result.agreed).to.have.lengthOf(0)
    expect(result.pending).to.have.lengthOf(1)
  })

  it('is order-independent: shuffling perAgentFindings produces identical MergedQuorum (modulo mergedAt)', () => {
    const findings: Array<[string, Finding[]]> = [
      ['@a', [mkFinding({agent: '@a', claim: 'one'}), mkFinding({agent: '@a', claim: 'two'})]],
      ['@b', [mkFinding({agent: '@b', claim: 'one'})]],
      ['@c', [mkFinding({agent: '@c', claim: 'three'}), mkFinding({agent: '@c', claim: 'one'})]],
    ]
    const ctx = mkContext()
    const forward = policy.merge(new Map(findings), ctx)
    const reversed = policy.merge(new Map([...findings].reverse()), ctx)
    expect(stripVolatile(forward)).to.deep.equal(stripVolatile(reversed))
  })

  it('is associative: merging in two halves matches merging all at once', () => {
    const ctx = mkContext({expectedAgents: ['@a', '@b', '@c'], selectedAgents: ['@a', '@b', '@c']})

    const a = mkFinding({agent: '@a', claim: 'apple'})
    const b1 = mkFinding({agent: '@b', claim: 'apple'})
    const b2 = mkFinding({agent: '@b', claim: 'banana'})
    const c = mkFinding({agent: '@c', claim: 'banana'})

    const whole = policy.merge(
      new Map<string, Finding[]>([
        ['@a', [a]],
        ['@b', [b1, b2]],
        ['@c', [c]],
      ]),
      ctx,
    )

    const left = policy.merge(
      new Map<string, Finding[]>([
        ['@a', [a]],
        ['@b', [b1, b2]],
      ]),
      mkContext({expectedAgents: ['@a', '@b'], selectedAgents: ['@a', '@b']}),
    )
    const right = policy.merge(
      new Map<string, Finding[]>([
        ['@b', [b1, b2]],
        ['@c', [c]],
      ]),
      mkContext({expectedAgents: ['@b', '@c'], selectedAgents: ['@b', '@c']}),
    )

    const wholeKeysAgreed = new Set(whole.agreed.map(f => f.canonicalClaim))
    const reunitedKeysAgreed = new Set([...left.agreed, ...right.agreed].map(f => f.canonicalClaim))
    expect([...wholeKeysAgreed].sort()).to.deep.equal([...reunitedKeysAgreed].sort())
  })

  it('partial-merge: omitting an expected agent populates missingAgents and sets partial true', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'shared'})]],
      ['@b', [mkFinding({agent: '@b', claim: 'shared'})]],
    ])
    const ctx = mkContext({
      expectedAgents: ['@a', '@b', '@c'],
      selectedAgents: ['@a', '@b'],
    })
    const result = policy.merge(perAgent, ctx)
    expect(result.partial).to.equal(true)
    expect(result.coveredAgents).to.deep.equal(['@a', '@b'])
    expect(result.missingAgents).to.deep.equal(['@c'])
  })

  it('non-partial when expected === selected', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'x'})]],
      ['@b', [mkFinding({agent: '@b', claim: 'x'})]],
    ])
    const ctx = mkContext({
      expectedAgents: ['@a', '@b'],
      selectedAgents: ['@a', '@b'],
    })
    const result = policy.merge(perAgent, ctx)
    expect(result.partial).to.equal(false)
    expect(result.missingAgents).to.deep.equal([])
  })

  it('claim-hash equality: identical canonical → same bucket', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'Hello, World!'})]],
      ['@b', [mkFinding({agent: '@b', claim: '  hello world  '})]],
      ['@c', [mkFinding({agent: '@c', claim: '"HELLO WORLD"'})]],
    ])
    const result = policy.merge(perAgent, mkContext({quorumThreshold: 2}))
    expect(result.agreed).to.have.lengthOf(1)
  })

  it('codex Q8 anti-test: different canonical claims stay in distinct buckets even when finding texts are similar', () => {
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'token leaks in src/auth.py'})]],
      ['@b', [mkFinding({agent: '@b', claim: 'token leaks in src/auth.ts'})]],
    ])
    const result = policy.merge(perAgent, mkContext({quorumThreshold: 2}))
    expect(result.agreed).to.have.lengthOf(0)
    expect(result.pending).to.have.lengthOf(2)
  })

  it('contradiction surfacing is deferred to Tier 2 — contradicted is always []', () => {
    // Even when agents emit hash-distinct claims, Tier 1 CrdtUnionMergePolicy
    // does not synthesise contradiction tuples — codex C4 + C6.
    const perAgent = new Map<string, Finding[]>([
      ['@a', [mkFinding({agent: '@a', claim: 'x is safe'})]],
      ['@b', [mkFinding({agent: '@b', claim: 'x is not safe'})]],
    ])
    const result = policy.merge(perAgent, mkContext({quorumThreshold: 2}))
    expect(result.contradicted).to.deep.equal([])
  })

  it('unions evidence spans across agents within the same bucket', () => {
    const perAgent = new Map<string, Finding[]>([
      [
        '@a',
        [
          mkFinding({
            agent: '@a',
            claim: 'risk in handler',
            evidence: [{excerpt: 'line1', source: 'auth.py', startLine: 1}],
          }),
        ],
      ],
      [
        '@b',
        [
          mkFinding({
            agent: '@b',
            claim: 'risk in handler',
            evidence: [{excerpt: 'line2', source: 'auth.py', startLine: 7}],
          }),
        ],
      ],
    ])
    const result = policy.merge(perAgent, mkContext({quorumThreshold: 2}))
    expect(result.agreed).to.have.lengthOf(1)
    expect(result.agreed[0].evidence).to.have.lengthOf(2)
    const excerpts = result.agreed[0].evidence.map(e => e.excerpt).sort()
    expect(excerpts).to.deep.equal(['line1', 'line2'])
  })

  it('kimi R3: agreed buckets are ordered by canonicalClaim (not by claimHash)', () => {
    // Sort by canonicalClaim → "alpha", "beta", "gamma" — predictable to
    // human readers, regardless of underlying sha256 ordering.
    const perAgent = new Map<string, Finding[]>([
      ['@a', [
        mkFinding({agent: '@a', claim: 'gamma'}),
        mkFinding({agent: '@a', claim: 'alpha'}),
        mkFinding({agent: '@a', claim: 'beta'}),
      ]],
      ['@b', [
        mkFinding({agent: '@b', claim: 'gamma'}),
        mkFinding({agent: '@b', claim: 'alpha'}),
        mkFinding({agent: '@b', claim: 'beta'}),
      ]],
    ])
    const ctx = mkContext({expectedAgents: ['@a', '@b'], quorumThreshold: 2, selectedAgents: ['@a', '@b']})
    const result = policy.merge(perAgent, ctx)
    expect(result.agreed.map(f => f.canonicalClaim)).to.deep.equal(['alpha', 'beta', 'gamma'])
  })

  it('kimi R1: same agent submitting multiple findings with identical claimHash produces stable representative', () => {
    // Without a tie-break on sourceDeliveryId, two findings from @a with the
    // same canonical claim would let pickContributors pick non-deterministically.
    const ctx = mkContext({expectedAgents: ['@a', '@b'], quorumThreshold: 2, selectedAgents: ['@a', '@b']})

    const f1 = mkFinding({agent: '@a', claim: 'shared', sourceDeliveryId: 'delivery-a-z'})
    const f2 = mkFinding({agent: '@a', claim: 'shared', sourceDeliveryId: 'delivery-a-a'})
    const f3 = mkFinding({agent: '@b', claim: 'shared'})

    const orderForward = policy.merge(
      new Map<string, Finding[]>([['@a', [f1, f2]], ['@b', [f3]]]),
      ctx,
    )
    const orderReversed = policy.merge(
      new Map<string, Finding[]>([['@a', [f2, f1]], ['@b', [f3]]]),
      ctx,
    )
    expect(orderForward.agreed[0].sourceDeliveryId).to.equal(orderReversed.agreed[0].sourceDeliveryId)
    expect(orderForward.agreed[0].sourceDeliveryId).to.equal('delivery-a-a')
  })

  it('mergedAt is stamped via context.now()', () => {
    const ctx = mkContext()
    const result = policy.merge(new Map(), ctx)
    expect(result.mergedAt).to.equal(FROZEN_ISO)
  })
})

describe('MajorityMergePolicy (scaffold)', () => {
  it('throws NotImplementedError when merge() is called', () => {
    const policy = new MajorityMergePolicy()
    expect(policy.name).to.equal('majority')
    expect(() => policy.merge(new Map(), mkContext())).to.throw(/NotImplemented/)
  })
})

describe('AdversarialFilterMergePolicy (scaffold)', () => {
  it('throws NotImplementedError when merge() is called', () => {
    const policy = new AdversarialFilterMergePolicy()
    expect(policy.name).to.equal('adversarial-filter')
    expect(() => policy.merge(new Map(), mkContext())).to.throw(/NotImplemented/)
  })
})

describe('FINDING_SCHEMA_VERSION gate (synthetic Tier-2 bump)', () => {
  it("differs from a forward-incompatible 'tier-2' version constant — pins gating", () => {
    // Synthetic bump scenario: if Tier 2 changes schema to '2.0.0', existing
    // Tier-1 findings carry FINDING_SCHEMA_VERSION = '1.0.0' and a future
    // gate will reject them. Tier 1 only owns the version constant + field
    // presence; gate enforcement is Tier 2's job.
    expect(FINDING_SCHEMA_VERSION).to.equal('1.0.0')
    const tier2Version = '2.0.0'
    expect(FINDING_SCHEMA_VERSION).to.not.equal(tier2Version)
  })
})
})
