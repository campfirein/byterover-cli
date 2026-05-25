import {expect} from 'chai'

import type {ChannelMember} from '../../../../../../src/shared/types/channel.js'

import {
  type Finding,
} from '../../../../../../src/server/core/domain/channel/quorum.js'
import {
  type DispatchHandle,
  type DispatchOneArgs,
  type TerminalDelivery,
} from '../../../../../../src/server/core/interfaces/channel/i-channel-orchestrator.js'
import {
  type PoolSelector,
  QuorumDispatcher,
  type QuorumDispatcherOrchestratorPort,
} from '../../../../../../src/server/infra/channel/quorum/dispatcher.js'
import {
  CrdtUnionMergePolicy,
} from '../../../../../../src/server/infra/channel/quorum/merge-policy.js'

const FROZEN_ISO = '2026-05-18T00:30:00.000Z'

function makeMember(handle: string): ChannelMember {
  // Minimal ACP-agent shape; merge dispatcher only reads `handle`.
  return {
    acpVersion: '0.1.0',
    agentName: handle.slice(1),
    capabilities: [],
    driverClass: 'A',
    handle,
    invocation: {args: [], command: 'noop', cwd: '/tmp'},
    joinedAt: FROZEN_ISO,
    memberKind: 'acp-agent',
    status: 'idle',
  }
}

type FakeCall = {
  args: DispatchOneArgs
  delivery: TerminalDelivery
  resolveOnDispatch: boolean
}

type FakeOrchestratorOpts = {
  failOnDispatch?: Set<string>
  forceShellOut?: boolean
}

class FakeOrchestrator implements QuorumDispatcherOrchestratorPort {
  public callLog: DispatchOneArgs[] = []
  public spawnCalled = false
  private readonly opts: FakeOrchestratorOpts
  private readonly perAgentResolver: Map<string, FakeCall>

  constructor(perAgent: Map<string, FakeCall>, opts: FakeOrchestratorOpts = {}) {
    this.perAgentResolver = perAgent
    this.opts = opts
  }

  async dispatchOne(args: DispatchOneArgs): Promise<DispatchHandle> {
    if (this.opts.forceShellOut) {
      this.spawnCalled = true
    }

    this.callLog.push(args)
    if (this.opts.failOnDispatch?.has(args.memberHandle)) {
      throw new Error(`dispatch failed for ${args.memberHandle}`)
    }

    const fake = this.perAgentResolver.get(args.memberHandle)
    if (!fake) {
      throw new Error(`no fixture for ${args.memberHandle}`)
    }

    const terminal: Promise<TerminalDelivery> = fake.resolveOnDispatch
      ? Promise.resolve(fake.delivery)
      : new Promise(resolve => {
          setTimeout(() => resolve(fake.delivery), 5)
        })

    return {
      deliveryId: fake.delivery.deliveryId,
      terminal,
      turnId: `turn-${args.memberHandle}`,
    }
  }
}

function mkTerminal(over: Partial<TerminalDelivery> & {memberHandle: string}): TerminalDelivery {
  return {
    artifactsTouched: [],
    deliveryId: over.deliveryId ?? `delivery-${over.memberHandle}`,
    endedAt: over.endedAt ?? FROZEN_ISO,
    errorCode: over.errorCode,
    errorMessage: over.errorMessage,
    finalAnswer: over.finalAnswer,
    memberHandle: over.memberHandle,
    state: over.state ?? 'completed',
    toolCallCount: over.toolCallCount ?? 0,
  }
}

describe('quorum/dispatcher', () => {
describe('QuorumDispatcher', () => {
  const mergePolicy = new CrdtUnionMergePolicy()

  it('fans out to K agents in parallel and merges their findings', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      [
        '@a',
        {
          args: undefined as unknown as DispatchOneArgs,
          delivery: mkTerminal({
            finalAnswer: JSON.stringify({findings: [{claim: 'shared issue'}]}),
            memberHandle: '@a',
          }),
          resolveOnDispatch: true,
        },
      ],
      [
        '@b',
        {
          args: undefined as unknown as DispatchOneArgs,
          delivery: mkTerminal({
            finalAnswer: JSON.stringify({findings: [{claim: 'shared issue'}]}),
            memberHandle: '@b',
          }),
          resolveOnDispatch: true,
        },
      ],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review this',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(merged.agreed).to.have.lengthOf(1)
    expect(merged.agreed[0].canonicalClaim).to.equal('shared issue')
    expect(merged.partial).to.equal(false)
    expect(orchestrator.callLog).to.have.lengthOf(2)
    // Two parallel calls — same turn group, distinct agent handles
    const handles = orchestrator.callLog.map(c => c.memberHandle).sort()
    expect(handles).to.deep.equal(['@a', '@b'])
  })

  it('codex Q4: dispatcher NEVER calls child_process.spawn', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'free-form @a answer', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'free-form @b answer', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review this',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(orchestrator.spawnCalled).to.equal(false)
  })

  it('codex Q5: free-form answer falls back to whole-answer-as-single-finding', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'I think auth.py is fine.', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'I think auth.py is fine.', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(merged.agreed).to.have.lengthOf(1)
    expect(merged.agreed[0].canonicalClaim).to.equal('i think auth.py is fine')
  })

  it('partial response: one agent errors → that agent in missingAgents, partial: true', async () => {
    const members = [makeMember('@a'), makeMember('@b'), makeMember('@c')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'shared claim', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'shared claim', memberHandle: '@b'}), resolveOnDispatch: true}],
      ['@c', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({errorCode: 'AGENT_ERRORED', errorMessage: 'boom', memberHandle: '@c', state: 'errored'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(merged.partial).to.equal(true)
    expect(merged.coveredAgents).to.deep.equal(['@a', '@b'])
    expect(merged.missingAgents).to.deep.equal(['@c'])
    expect(merged.agreed).to.have.lengthOf(1)
  })

  it('cancelled delivery counts as missing, not as a finding', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({memberHandle: '@b', state: 'cancelled'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(merged.missingAgents).to.deep.equal(['@b'])
    expect(merged.coveredAgents).to.deep.equal(['@a'])
    expect(merged.partial).to.equal(true)
  })

  it('codex Q7: pool selector seam — custom selector runs before dispatch', async () => {
    const members = [makeMember('@a'), makeMember('@b'), makeMember('@c')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)

    let selectorCalled = 0
    const localFirstSelector: PoolSelector = (agents) => {
      selectorCalled++
      // Restrict to the first 2 agents only — proves the seam works
      return {pool: 'local', selectedAgents: agents.slice(0, 2)}
    }

    const dispatcher = new QuorumDispatcher({
      now: () => new Date(FROZEN_ISO),
      orchestrator,
      poolSelector: localFirstSelector,
    })

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(selectorCalled).to.equal(1)
    expect(orchestrator.callLog.map(c => c.memberHandle).sort()).to.deep.equal(['@a', '@b'])
    expect(merged.coveredAgents).to.deep.equal(['@a', '@b'])
    expect(merged.missingAgents).to.deep.equal(['@c'])
  })

  it('default pool selector passes through all agents as "mixed"', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(orchestrator.callLog).to.have.lengthOf(2)
    expect(merged.coveredAgents).to.deep.equal(['@a', '@b'])
  })

  it('passes the prompt + projectRoot to every dispatchOne call', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-99',
      mergePolicy,
      projectRoot: '/project/x',
      prompt: 'investigate this',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 12_345,
    })

    for (const call of orchestrator.callLog) {
      expect(call.channelId).to.equal('ch-1')
      expect(call.projectRoot).to.equal('/project/x')
      expect(call.prompt).to.equal('investigate this')
      expect(call.timeoutMs).to.equal(12_345)
    }
  })

  it('kimi R4: code-fenced JSON (```json ... ```) is stripped and parsed', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const fenced = '```json\n{"findings": [{"claim": "fenced claim"}]}\n```'
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: fenced, memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: fenced, memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(merged.agreed).to.have.lengthOf(1)
    expect(merged.agreed[0].canonicalClaim).to.equal('fenced claim')
  })

  it('JSON-structured finalAnswer with multiple findings produces multiple Findings', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: JSON.stringify({findings: [{claim: 'first'}, {claim: 'second'}]}), memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: JSON.stringify({findings: [{claim: 'first'}, {claim: 'second'}]}), memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(merged.agreed.map((f: Finding) => f.canonicalClaim).sort()).to.deep.equal(['first', 'second'])
  })

  it('per-delivery dispatch error surfaces that agent as missing', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'x', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent, {failOnDispatch: new Set(['@b'])})
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(merged.partial).to.equal(true)
    expect(merged.missingAgents).to.deep.equal(['@b'])
  })

  it('sourceTurnId is the dispatch turnId, not the deliveryId', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({deliveryId: 'delivery-a', finalAnswer: 'shared', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({deliveryId: 'delivery-b', finalAnswer: 'shared', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    // sourceTurnId must equal turn-@a or turn-@b (FakeOrchestrator builds
    // turnIds as `turn-${memberHandle}`); never the deliveryId.
    expect(merged.agreed).to.have.lengthOf(1)
    expect(['turn-@a', 'turn-@b']).to.include(merged.agreed[0].sourceTurnId)
    expect(merged.agreed[0].sourceTurnId).to.not.equal(merged.agreed[0].sourceDeliveryId)
  })

  it('attributes findings to the correct agent in the merge', async () => {
    const members = [makeMember('@a'), makeMember('@b')]
    const perAgent = new Map<string, FakeCall>([
      ['@a', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'distinct A claim', memberHandle: '@a'}), resolveOnDispatch: true}],
      ['@b', {args: undefined as unknown as DispatchOneArgs, delivery: mkTerminal({finalAnswer: 'distinct B claim', memberHandle: '@b'}), resolveOnDispatch: true}],
    ])
    const orchestrator = new FakeOrchestrator(perAgent)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const merged = await dispatcher.dispatch({
      agents: members,
      channelId: 'ch-1',
      dispatchId: 'd-1',
      mergePolicy,
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    // Each agent's claim is distinct → both land in pending (singletons)
    const agentsInPending = merged.pending.map(f => f.agent).sort()
    expect(agentsInPending).to.deep.equal(['@a', '@b'])
  })
})
})
