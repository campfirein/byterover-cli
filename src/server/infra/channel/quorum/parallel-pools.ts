import type {Finding, MergedQuorum} from '../../../core/domain/channel/quorum.js'
import type {MergeContext} from '../../../core/interfaces/channel/i-merge-policy.js'
import type {
  QuorumAgentRef,
  QuorumDispatchArgs,
  QuorumDispatcher,
} from './dispatcher.js'
import type {ClassifiableAgent} from './pools.js'

import {
  
  makeLocalOnlyPoolSelector,
  makeRemoteOnlyPoolSelector,
} from './pools.js'

// Phase 10 Slice 10.5 — latency-grouped pools (parallel dispatch).
//
// The Moshpit lesson: pools matchmake INDEPENDENTLY. Local-pool dispatch never
// includes remote agents and vice versa. Both pools run in parallel under
// their own timeout budgets, so a slow remote can't stall fast local work.
// Final result is a single CRDT merge across both pools' raw findings.
//
// Compared with Slice 10.3's `dispatchLocalFirst`:
//   * sequential (local → trigger-check → maybe remote)
//   * cumulative latency = local + remote when escalation fires
//   * remote latency only paid when local consensus fails (cost-optimal)
//
// Slice 10.5's `dispatchParallelPools`:
//   * concurrent (local || remote)
//   * wall-clock latency = max(local, remote)
//   * remote latency always paid (latency-optimal)
//
// Use parallel when you want predictable wall-clock; use local-first when
// remote is expensive (network egress, model cost, rate limits).

const DEFAULT_LOCAL_TIMEOUT_MS = 5000
const DEFAULT_REMOTE_TIMEOUT_MS = 30_000

export type PoolBudgetOptions = {
  readonly localTimeoutMs?: number
  readonly parallelNow?: () => Date
  readonly remoteTimeoutMs?: number
}

export type ParallelPoolsDispatchArgs = Omit<QuorumDispatchArgs, 'agents'> & PoolBudgetOptions & {
  readonly agents: ReadonlyArray<ClassifiableAgent>
}

export type ParallelPoolsResult = {
  // Per-pool outcome. `'completed'` if the gather resolved within its budget,
  // `'timed-out'` if it didn't, `'errored'` for other gather failures, and
  // `'skipped'` when the pool had no candidate agents.
  readonly localPoolOutcome: 'completed' | 'errored' | 'skipped' | 'timed-out'
  readonly localTimeoutMs: number
  // Composition tag matching MergeContext.pool — `mixed` when both pools
  // contributed findings, otherwise the single pool that did.
  readonly pool: 'local' | 'mixed' | 'remote'
  readonly remotePoolOutcome: 'completed' | 'errored' | 'skipped' | 'timed-out'
  readonly remoteTimeoutMs: number
} & MergedQuorum

type PoolGatherOutcome =
  | {readonly errorMessage?: string; readonly status: 'errored' | 'skipped' | 'timed-out'}
  | {readonly gather: Awaited<ReturnType<QuorumDispatcher['gather']>>; readonly status: 'completed'}

export async function dispatchParallelPools(
  dispatcher: QuorumDispatcher,
  args: ParallelPoolsDispatchArgs,
): Promise<ParallelPoolsResult> {
  const localTimeoutMs = args.localTimeoutMs ?? DEFAULT_LOCAL_TIMEOUT_MS
  const remoteTimeoutMs = args.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS

  const localSelector = makeLocalOnlyPoolSelector<ClassifiableAgent>()
  const remoteSelector = makeRemoteOnlyPoolSelector<ClassifiableAgent>()
  const localPick = localSelector(args.agents as ClassifiableAgent[])
  const remotePick = remoteSelector(args.agents as ClassifiableAgent[])

  // Promise.all so both pools settle before merge. Each gather is wrapped in
  // a Promise.race against its per-pool timeout so a slow pool can't stall
  // the other one's already-completed result indefinitely.
  const [local, remote] = await Promise.all([
    gatherWithBudget(dispatcher, args, localPick.selectedAgents, localTimeoutMs),
    gatherWithBudget(dispatcher, args, remotePick.selectedAgents, remoteTimeoutMs),
  ])

  // Merge once across BOTH pools' raw findings (preserves multi-agent
  // attribution that piping representatives through merge twice would lose).
  const combined = new Map<string, Finding[]>()
  let allExpected: ReadonlyArray<string> = []
  let allResponded: ReadonlyArray<string> = []

  if (local.status === 'completed') {
    for (const [agent, findings] of local.gather.perAgentFindings) {
      combined.set(agent, [...(combined.get(agent) ?? []), ...findings])
    }

    allExpected = [...allExpected, ...local.gather.expectedAgents]
    allResponded = [...allResponded, ...local.gather.respondedAgents]
  }

  if (remote.status === 'completed') {
    for (const [agent, findings] of remote.gather.perAgentFindings) {
      combined.set(agent, [...(combined.get(agent) ?? []), ...findings])
    }

    allExpected = [...allExpected, ...remote.gather.expectedAgents]
    allResponded = [...allResponded, ...remote.gather.respondedAgents]
  }

  // expectedAgents for the merge is the FULL set the caller asked for —
  // including agents whose pool errored or timed out. The merge engine
  // computes missingAgents = expected ∖ responded.
  const allArgsHandles = args.agents.map(a => a.handle)
  const expectedFinal = [...new Set([...allArgsHandles, ...allExpected])].sort()
  const respondedFinal = [...new Set(allResponded)].sort()

  const pool: 'local' | 'mixed' | 'remote' = localPoolPresent(local) && remotePoolPresent(remote)
    ? 'mixed'
    : localPoolPresent(local) ? 'local' : 'remote'

  const ctx: MergeContext = {
    channelId: args.channelId,
    dispatchId: args.dispatchId,
    expectedAgents: expectedFinal,
    now: args.parallelNow ?? (() => new Date()),
    pool,
    quorumThreshold: args.quorumThreshold,
    selectedAgents: respondedFinal,
    taskSchemaHash: args.taskSchemaHash,
  }
  const merged = args.mergePolicy.merge(combined, ctx)

  return {
    ...merged,
    localPoolOutcome: local.status,
    localTimeoutMs,
    pool,
    remotePoolOutcome: remote.status,
    remoteTimeoutMs,
  }
}

async function gatherWithBudget(
  dispatcher: QuorumDispatcher,
  args: ParallelPoolsDispatchArgs,
  selectedAgents: ReadonlyArray<ClassifiableAgent>,
  timeoutMs: number,
): Promise<PoolGatherOutcome> {
  if (selectedAgents.length === 0) {
    return {status: 'skipped'}
  }

  const gatherArgs: QuorumDispatchArgs = {
    ...args,
    agents: selectedAgents as unknown as QuorumAgentRef[],
    timeoutMs,
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<{readonly status: 'timed-out'}>(resolve => {
    timer = setTimeout(() => {
      resolve({status: 'timed-out'})
    }, timeoutMs)
  })

  try {
    const gatherPromise = dispatcher.gather(gatherArgs).then(gather => ({gather, status: 'completed' as const}))
    const winner = await Promise.race([gatherPromise, timeoutPromise])
    if (winner.status === 'timed-out') {
      return winner
    }

    return winner
  } catch (error) {
    return {
      errorMessage: error instanceof Error ? error.message : String(error),
      status: 'errored',
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function localPoolPresent(outcome: PoolGatherOutcome): boolean {
  return outcome.status === 'completed'
}

function remotePoolPresent(outcome: PoolGatherOutcome): boolean {
  return outcome.status === 'completed'
}

// Re-export for convenience; `classifyAgent` is the same one Slice 10.3 uses.


export {classifyAgent} from './pools.js'