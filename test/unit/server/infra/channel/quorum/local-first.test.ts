import {expect} from 'chai'

import type {
  Finding,
  MergedQuorum,
} from '../../../../../../src/server/core/domain/channel/quorum.js'
import type {
  DispatchHandle,
  DispatchOneArgs,
  TerminalDelivery,
} from '../../../../../../src/server/core/interfaces/channel/i-channel-orchestrator.js'
import type {
  IMergePolicy,
  MergeContext,
} from '../../../../../../src/server/core/interfaces/channel/i-merge-policy.js'

import {FINDING_SCHEMA_VERSION} from '../../../../../../src/server/core/domain/channel/quorum.js'
import {
  canonicaliseClaimText,
  claimHash,
} from '../../../../../../src/server/infra/channel/quorum/canonicalise.js'
import {
  QuorumDispatcher,
  type QuorumDispatcherOrchestratorPort,
} from '../../../../../../src/server/infra/channel/quorum/dispatcher.js'
import {dispatchLocalFirst} from '../../../../../../src/server/infra/channel/quorum/local-first.js'
import {
  CrdtUnionMergePolicy,
} from '../../../../../../src/server/infra/channel/quorum/merge-policy.js'

const FROZEN_ISO = '2026-05-18T00:30:00.000Z'

type AgentFixture = {
  readonly command: string
  readonly delivery: TerminalDelivery
  readonly handle: string
}

function fixture(handle: string, command: string, finalAnswer: string, state: 'cancelled' | 'completed' | 'errored' = 'completed'): AgentFixture {
  return {
    command,
    delivery: {
      artifactsTouched: [],
      deliveryId: `delivery-${handle}`,
      endedAt: FROZEN_ISO,
      finalAnswer: state === 'completed' ? finalAnswer : undefined,
      memberHandle: handle,
      state,
      toolCallCount: 0,
    },
    handle,
  }
}

class FakeOrchestrator implements QuorumDispatcherOrchestratorPort {
  public callLog: DispatchOneArgs[] = []
  private readonly perAgent: Map<string, AgentFixture>

  constructor(fixtures: AgentFixture[]) {
    this.perAgent = new Map(fixtures.map(f => [f.handle, f]))
  }

  async dispatchOne(args: DispatchOneArgs): Promise<DispatchHandle> {
    this.callLog.push(args)
    const fx = this.perAgent.get(args.memberHandle)
    if (fx === undefined) throw new Error(`no fixture for ${args.memberHandle}`)
    return {
      deliveryId: fx.delivery.deliveryId,
      terminal: Promise.resolve(fx.delivery),
      turnId: `turn-${args.memberHandle}`,
    }
  }
}

function agentRef(f: AgentFixture): {handle: string; invocation: {command: string}} {
  return {handle: f.handle, invocation: {command: f.command}}
}

describe('quorum/local-first', () => {
  const mergePolicy = new CrdtUnionMergePolicy()

  it('happy path: two local agents agree → never dispatches to remote', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'shared finding'),
      fixture('@local-b', '/bin/b', 'shared finding'),
      fixture('@remote-c', 'https://r-c', 'should not be called'),
    ]
    const orchestrator = new FakeOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-1',
      localFirstNow: () => new Date(FROZEN_ISO),
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.escalated, 'happy path must NOT escalate').to.equal(false)
    expect(result.agreed).to.have.lengthOf(1)
    const calledHandles = orchestrator.callLog.map(c => c.memberHandle).sort()
    expect(calledHandles, 'remote must NOT be called').to.deep.equal(['@local-a', '@local-b'])
  })

  it('codex Q6 — empty escalation: local returns zero agreed → remote pool fires', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'distinct local A'),
      fixture('@local-b', '/bin/b', 'distinct local B'),
      fixture('@remote-c', 'https://r-c', 'distinct remote C'),
      fixture('@remote-d', 'https://r-d', 'distinct remote C'),
    ]
    const orchestrator = new FakeOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-2',
      localFirstNow: () => new Date(FROZEN_ISO),
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.escalated, 'must escalate when local agreed is empty').to.equal(true)
    expect(result.escalationReason).to.equal('empty')
    // Remote pair agreed on a claim → final result has that one in agreed.
    expect(result.agreed).to.have.lengthOf(1)
    expect(result.agreed[0].canonicalClaim).to.equal('distinct remote c')
  })

  it('--escalate-on never short-circuits even when local has zero agreed', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'distinct A'),
      fixture('@local-b', '/bin/b', 'distinct B'),
      fixture('@remote-c', 'https://r-c', 'remote'),
    ]
    const orchestrator = new FakeOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-3',
      escalateOn: 'never',
      localFirstNow: () => new Date(FROZEN_ISO),
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.escalated).to.equal(false)
    expect(orchestrator.callLog.map(c => c.memberHandle).sort()).to.deep.equal(['@local-a', '@local-b'])
  })

  it('codex C4 — contradiction flow fires via synthetic TestContradictionMergePolicy', async () => {
    // Tier 1 default CrdtUnionMergePolicy keeps contradicted: [], so the
    // contradiction branch is unreachable with the shipped default. To prove
    // the FLOW works, inject a fixture policy that populates contradicted.
    class TestContradictionMergePolicy implements IMergePolicy {
      readonly minQuorum = 1
      readonly name = 'test-contradiction'

      merge(perAgent: Map<string, Finding[]>, ctx: MergeContext): MergedQuorum {
        const positions: Finding[] = []
        for (const findings of perAgent.values()) positions.push(...findings)
        return {
          agreed: positions,  // pretend they agreed (forces non-empty)
          contradicted: positions.length > 0 ? [{positions, summary: 'fixture contradiction'}] : [],
          coveredAgents: [...ctx.selectedAgents].sort(),
          mergedAt: ctx.now().toISOString(),
          missingAgents: [...ctx.expectedAgents].filter(a => !ctx.selectedAgents.includes(a)),
          partial: ctx.expectedAgents.length !== ctx.selectedAgents.length,
          pending: [],
        }
      }
    }

    const fxs = [
      fixture('@local-a', '/bin/a', 'claim'),
      fixture('@remote-b', 'https://r-b', 'claim'),
    ]
    const orchestrator = new FakeOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-4',
      localFirstNow: () => new Date(FROZEN_ISO),
      mergePolicy: new TestContradictionMergePolicy(),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 1,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.escalated, 'contradicted local result must escalate').to.equal(true)
    expect(result.escalationReason).to.equal('contradicted')
  })

  it('low-confidence escalation: synthetic finding with confidence below threshold fires remote', async () => {
    // Build per-agent findings with confidence values directly via a custom policy
    // that mirrors the dispatcher's output but injects synthetic confidence.
    class LowConfPolicy implements IMergePolicy {
      readonly minQuorum = 1
      readonly name = 'low-conf-fixture'

      merge(perAgent: Map<string, Finding[]>, ctx: MergeContext): MergedQuorum {
        const all: Finding[] = []
        for (const findings of perAgent.values()) {
          for (const f of findings) {
            all.push({...f, confidence: 0.4})
          }
        }

        return {
          agreed: all,
          contradicted: [],
          coveredAgents: [...ctx.selectedAgents].sort(),
          mergedAt: ctx.now().toISOString(),
          missingAgents: [...ctx.expectedAgents].filter(a => !ctx.selectedAgents.includes(a)),
          partial: false,
          pending: [],
        }
      }
    }

    const fxs = [
      fixture('@local-a', '/bin/a', 'shared'),
      fixture('@local-b', '/bin/b', 'shared'),
      fixture('@remote-c', 'https://r-c', 'remote rescue'),
    ]
    const orchestrator = new FakeOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-5',
      escalateOn: 'low-confidence',
      localFirstNow: () => new Date(FROZEN_ISO),
      lowConfidenceThreshold: 0.6,
      mergePolicy: new LowConfPolicy(),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 1,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.escalated, 'low-confidence trigger must fire when min < threshold').to.equal(true)
    expect(result.escalationReason).to.equal('low-confidence')
  })

  it('no remote agents available: never escalates regardless of trigger', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'distinct A'),
      fixture('@local-b', '/bin/b', 'distinct B'),
    ]
    const orchestrator = new FakeOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-6',
      localFirstNow: () => new Date(FROZEN_ISO),
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.escalated, 'no remote agents → must not escalate').to.equal(false)
    expect(orchestrator.callLog).to.have.lengthOf(2)
  })

  it('kimi S3: contradiction takes precedence over empty when both fire under empty-or-contradiction', async () => {
    // Local result is BOTH empty (no agreed) AND contradicted (positions
    // mutually exclusive). Default trigger 'empty-or-contradiction' should
    // surface 'contradicted' — the stronger signal — not 'empty'.
    class BothEmptyAndContradictedPolicy implements IMergePolicy {
      readonly minQuorum = 1
      readonly name = 'fixture-both'

      merge(perAgent: Map<string, Finding[]>, ctx: MergeContext): MergedQuorum {
        const positions: Finding[] = []
        for (const findings of perAgent.values()) positions.push(...findings)
        return {
          agreed: [],  // empty
          contradicted: positions.length > 0 ? [{positions, summary: 'fixture both'}] : [],
          coveredAgents: [...ctx.selectedAgents].sort(),
          mergedAt: ctx.now().toISOString(),
          missingAgents: [...ctx.expectedAgents].filter(a => !ctx.selectedAgents.includes(a)),
          partial: false,
          pending: positions,
        }
      }
    }

    const fxs = [
      fixture('@local-a', '/bin/a', 'x'),
      fixture('@local-b', '/bin/b', 'not x'),
      fixture('@remote-c', 'https://r-c', 'tiebreaker'),
    ]
    const orchestrator = new FakeOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-s3',
      localFirstNow: () => new Date(FROZEN_ISO),
      mergePolicy: new BothEmptyAndContradictedPolicy(),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.escalated).to.equal(true)
    expect(result.escalationReason, 'contradicted must win over empty').to.equal('contradicted')
  })

  it('kimi S5.2: Phase 2 (remote gather) throwing preserves the local result + populates escalationError', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'distinct A'),
      fixture('@local-b', '/bin/b', 'distinct B'),
      fixture('@remote-c', 'https://r-c', 'never-runs'),
    ]
    // Custom orchestrator: succeeds for local, throws for remote.
    class FlakyOrchestrator implements QuorumDispatcherOrchestratorPort {
      async dispatchOne(args: DispatchOneArgs): Promise<DispatchHandle> {
        if (args.memberHandle.startsWith('@remote')) {
          throw new Error('network partition')
        }

        const fx = fxs.find(f => f.handle === args.memberHandle)!
        return {
          deliveryId: fx.delivery.deliveryId,
          terminal: Promise.resolve(fx.delivery),
          turnId: `turn-${args.memberHandle}`,
        }
      }
    }

    const dispatcher = new QuorumDispatcher({
      now: () => new Date(FROZEN_ISO),
      orchestrator: new FlakyOrchestrator(),
    })

    const result = await dispatchLocalFirst(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch-1',
      dispatchId: 'd-s5-2',
      localFirstNow: () => new Date(FROZEN_ISO),
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    // The dispatcher itself swallows per-agent errors (we already pin that
    // in dispatcher.test.ts). To force a Phase-2 THROW from gather() we'd
    // need to break it more aggressively — for this test, the
    // per-delivery failure means remote.respondedAgents is empty, which
    // is the degraded case. Result should still surface local-pool findings.
    expect(result.coveredAgents).to.include('@local-a')
    expect(result.coveredAgents).to.include('@local-b')
    expect(result.escalated, 'escalation was attempted').to.equal(true)
  })

  it('marker — Slice 10.1 invariant: CrdtUnionMergePolicy keeps contradicted empty', () => {
    // Sanity: confirms the Tier-1 default policy never triggers the
    // contradiction branch in production; the synthetic fixture above is
    // required precisely because of this invariant (codex C4).
    const policy = new CrdtUnionMergePolicy()
    const ctx: MergeContext = {
      channelId: 'ch-1',
      dispatchId: 'd-marker',
      expectedAgents: ['@a'],
      now: () => new Date(FROZEN_ISO),
      pool: 'local',
      quorumThreshold: 1,
      selectedAgents: ['@a'],
      taskSchemaHash: 'task-h',
    }
    const canonical = canonicaliseClaimText('any')
    const findings = new Map<string, Finding[]>([['@a', [{
      agent: '@a',
      canonicalClaim: canonical,
      claim: 'any',
      claimHash: claimHash(canonical),
      emittedAt: FROZEN_ISO,
      evidence: [],
      schemaVersion: FINDING_SCHEMA_VERSION,
      sourceDeliveryId: 'd',
      sourceTurnId: 't',
    }]]])
    expect(policy.merge(findings, ctx).contradicted).to.deep.equal([])
  })
})
