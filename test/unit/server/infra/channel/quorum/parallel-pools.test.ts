import {expect} from 'chai'

import type {
  DispatchHandle,
  DispatchOneArgs,
  TerminalDelivery,
} from '../../../../../../src/server/core/interfaces/channel/i-channel-orchestrator.js'

import {
  QuorumDispatcher,
  type QuorumDispatcherOrchestratorPort,
} from '../../../../../../src/server/infra/channel/quorum/dispatcher.js'
import {CrdtUnionMergePolicy} from '../../../../../../src/server/infra/channel/quorum/merge-policy.js'
import {dispatchParallelPools} from '../../../../../../src/server/infra/channel/quorum/parallel-pools.js'

const FROZEN_ISO = '2026-05-18T00:30:00.000Z'

type Fixture = {
  readonly command: string
  readonly delayMs: number
  readonly delivery: TerminalDelivery
  readonly handle: string
}

function fixture(handle: string, command: string, finalAnswer: string, delayMs = 0): Fixture {
  return {
    command,
    delayMs,
    delivery: {
      artifactsTouched: [],
      deliveryId: `d-${handle}`,
      endedAt: FROZEN_ISO,
      finalAnswer,
      memberHandle: handle,
      state: 'completed',
      toolCallCount: 0,
    },
    handle,
  }
}

class DelayedOrchestrator implements QuorumDispatcherOrchestratorPort {
  public callLog: DispatchOneArgs[] = []
  private readonly perAgent: Map<string, Fixture>

  constructor(fixtures: Fixture[]) {
    this.perAgent = new Map(fixtures.map(f => [f.handle, f]))
  }

  async dispatchOne(args: DispatchOneArgs): Promise<DispatchHandle> {
    this.callLog.push(args)
    const fx = this.perAgent.get(args.memberHandle)
    if (fx === undefined) throw new Error(`no fixture for ${args.memberHandle}`)
    const terminal: Promise<TerminalDelivery> = new Promise(resolve => {
      setTimeout(() => resolve(fx.delivery), fx.delayMs)
    })
    return {deliveryId: fx.delivery.deliveryId, terminal, turnId: `turn-${args.memberHandle}`}
  }
}

function agentRef(f: Fixture): {handle: string; invocation: {command: string}} {
  return {handle: f.handle, invocation: {command: f.command}}
}

describe('quorum/parallel-pools', () => {
  const mergePolicy = new CrdtUnionMergePolicy()

  it('runs local + remote pools concurrently — wall clock = max(local, remote)', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'shared', 50),
      fixture('@local-b', '/bin/b', 'shared', 50),
      fixture('@remote-c', 'https://r-c', 'shared', 80),
      fixture('@remote-d', 'https://r-d', 'shared', 80),
    ]
    const orchestrator = new DelayedOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const start = Date.now()
    const result = await dispatchParallelPools(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch',
      dispatchId: 'd-1',
      localTimeoutMs: 500,
      mergePolicy,
      parallelNow: () => new Date(FROZEN_ISO),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      remoteTimeoutMs: 500,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })
    const elapsed = Date.now() - start

    // Wall clock should be ~max(80, 80) = 80ms, definitely < 130 (= 50 + 80 sequential).
    expect(elapsed, `parallel should finish in max(local, remote), not sum — got ${elapsed}ms`).to.be.lessThan(130)
    expect(result.localPoolOutcome).to.equal('completed')
    expect(result.remotePoolOutcome).to.equal('completed')
    expect(result.pool).to.equal('mixed')
    // All 4 agents agreed on 'shared' → bucket size 4 ≥ threshold 2 → agreed.
    expect(result.agreed).to.have.lengthOf(1)
    expect(result.partial).to.equal(false)
  })

  it('slow remote times out without blocking local — local result still returned', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'local-finding', 30),
      fixture('@local-b', '/bin/b', 'local-finding', 30),
      fixture('@remote-c', 'https://r-c', 'never-arrives', 5000),
    ]
    const orchestrator = new DelayedOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchParallelPools(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch',
      dispatchId: 'd-2',
      localTimeoutMs: 200,
      mergePolicy,
      parallelNow: () => new Date(FROZEN_ISO),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      remoteTimeoutMs: 100,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.localPoolOutcome).to.equal('completed')
    expect(result.remotePoolOutcome).to.equal('timed-out')
    expect(result.pool).to.equal('local')
    expect(result.agreed.map(f => f.canonicalClaim)).to.deep.equal(['local-finding'])
    expect(result.missingAgents).to.include('@remote-c')
    expect(result.partial).to.equal(true)
  })

  it('skips remote pool entirely when no remote agents exist', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'finding', 10),
      fixture('@local-b', '/bin/b', 'finding', 10),
    ]
    const orchestrator = new DelayedOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchParallelPools(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch',
      dispatchId: 'd-3',
      mergePolicy,
      parallelNow: () => new Date(FROZEN_ISO),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.localPoolOutcome).to.equal('completed')
    expect(result.remotePoolOutcome).to.equal('skipped')
    expect(result.pool).to.equal('local')
    expect(result.agreed).to.have.lengthOf(1)
  })

  it('skips local pool entirely when no local agents exist', async () => {
    const fxs = [
      fixture('@remote-a', 'https://r-a', 'finding', 10),
      fixture('@remote-b', 'https://r-b', 'finding', 10),
    ]
    const orchestrator = new DelayedOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchParallelPools(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch',
      dispatchId: 'd-4',
      mergePolicy,
      parallelNow: () => new Date(FROZEN_ISO),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.localPoolOutcome).to.equal('skipped')
    expect(result.remotePoolOutcome).to.equal('completed')
    expect(result.pool).to.equal('remote')
    expect(result.agreed).to.have.lengthOf(1)
  })

  it('both pools time out → partial: true with all agents in missingAgents', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'x', 5000),
      fixture('@remote-c', 'https://r-c', 'x', 5000),
    ]
    const orchestrator = new DelayedOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchParallelPools(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch',
      dispatchId: 'd-5',
      localTimeoutMs: 50,
      mergePolicy,
      parallelNow: () => new Date(FROZEN_ISO),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 1,
      remoteTimeoutMs: 50,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.localPoolOutcome).to.equal('timed-out')
    expect(result.remotePoolOutcome).to.equal('timed-out')
    expect(result.agreed).to.have.lengthOf(0)
    expect(result.missingAgents.sort()).to.deep.equal(['@local-a', '@remote-c'])
    expect(result.partial).to.equal(true)
  })

  it('default per-pool timeouts: 5s local / 30s remote when not specified', async () => {
    const fxs = [fixture('@local-a', '/bin/a', 'x', 10)]
    const orchestrator = new DelayedOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchParallelPools(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch',
      dispatchId: 'd-6',
      mergePolicy,
      parallelNow: () => new Date(FROZEN_ISO),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 1,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.localTimeoutMs).to.equal(5000)
    expect(result.remoteTimeoutMs).to.equal(30_000)
  })

  it('cross-pool merge: local + remote agree on same claim → one merged finding with all contributors', async () => {
    const fxs = [
      fixture('@local-a', '/bin/a', 'cross-pool claim', 20),
      fixture('@remote-b', 'https://r-b', 'cross-pool claim', 30),
    ]
    const orchestrator = new DelayedOrchestrator(fxs)
    const dispatcher = new QuorumDispatcher({now: () => new Date(FROZEN_ISO), orchestrator})

    const result = await dispatchParallelPools(dispatcher, {
      agents: fxs.map(f => agentRef(f)),
      channelId: 'ch',
      dispatchId: 'd-7',
      localTimeoutMs: 500,
      mergePolicy,
      parallelNow: () => new Date(FROZEN_ISO),
      projectRoot: '/tmp/p',
      prompt: 'review',
      quorumThreshold: 2,
      remoteTimeoutMs: 500,
      taskSchemaHash: 'task-h',
      timeoutMs: 60_000,
    })

    expect(result.pool).to.equal('mixed')
    expect(result.agreed).to.have.lengthOf(1)
    expect(result.agreed[0].canonicalClaim).to.equal('cross-pool claim')
  })
})
