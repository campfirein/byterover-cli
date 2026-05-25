import type {Finding, MergedQuorum} from '../../../core/domain/channel/quorum.js'
import type {MergeContext} from '../../../core/interfaces/channel/i-merge-policy.js'
import type {
  QuorumAgentRef,
  QuorumDispatchArgs,
  QuorumDispatcher,
} from './dispatcher.js'
import type {
  ClassifiableAgent,
} from './pools.js'

import {
  classifyAgent,
  makeLocalFirstPoolSelector,
  makeRemoteOnlyPoolSelector,
} from './pools.js'

// Phase 10 Slice 10.3 — local-first dispatch with remote escalation.
//
// Two-phase orchestration that runs ON TOP of `QuorumDispatcher` (codex Q7:
// dispatcher internals from 10.2 stay untouched). Phase 1 dispatches to
// local agents via `LocalFirstPoolSelector`; phase 2 escalates to remote
// agents if the configured trigger fires.
//
// Default escalation trigger is `empty-or-contradiction` (codex Q6):
//   - `agreed.length === 0` (no local consensus), OR
//   - `contradicted.length > 0` (local disagreement; remote diversity is
//     exactly the lever to break the tie).
//
// Codex C4 — the contradiction branch is wired but inert in Tier 1: the
// shipped `CrdtUnionMergePolicy` keeps `contradicted: []`, so the default
// trigger only fires on `empty` until Tier 2 lights up the contradiction
// detector. No code change in 10.3 needed when Tier 2 ships.

export type EscalationTrigger =
  | 'empty'
  | 'empty-or-contradiction'
  | 'low-confidence'
  | 'never'

export type LocalFirstOptions = {
  readonly escalateOn?: EscalationTrigger
  readonly localFirstNow?: () => Date
  readonly lowConfidenceThreshold?: number
  readonly treatMissingConfidenceAsHigh?: boolean
}

export type LocalFirstDispatchArgs = LocalFirstOptions & Omit<QuorumDispatchArgs, 'agents'> & {
  readonly agents: ReadonlyArray<ClassifiableAgent>
}

export type LocalFirstResult = {
  readonly escalated: boolean
  // Populated when remote escalation was attempted but failed (network
  // partition, remote daemon unavailable, etc). The local result is still
  // returned — kimi S5.2: do not lose local-pool findings on Phase 2 failure.
  readonly escalationError?: string
  readonly escalationReason?: 'contradicted' | 'empty' | 'low-confidence'
} & MergedQuorum

const DEFAULT_LOW_CONFIDENCE_THRESHOLD = 0.6

export async function dispatchLocalFirst(
  dispatcher: QuorumDispatcher,
  args: LocalFirstDispatchArgs,
): Promise<LocalFirstResult> {
  const trigger = args.escalateOn ?? 'empty-or-contradiction'

  // Phase 1 — gather raw findings from local pool.
  const localSelector = makeLocalFirstPoolSelector<ClassifiableAgent>()
  const localPick = localSelector(args.agents as ClassifiableAgent[])
  const localGather = await dispatcher.gather({
    ...args,
    agents: localPick.selectedAgents as unknown as QuorumAgentRef[],
  })
  const localResult = mergeGather(localGather, localPick.pool, args)

  // No remote agents available → return local result regardless of trigger.
  const remoteAgents = args.agents.filter(a => classifyAgent(a) === 'remote')
  if (trigger === 'never' || remoteAgents.length === 0) {
    return {...localResult, escalated: false}
  }

  const reason = shouldEscalate(localResult, trigger, {
    lowConfidenceThreshold: args.lowConfidenceThreshold ?? DEFAULT_LOW_CONFIDENCE_THRESHOLD,
    treatMissingConfidenceAsHigh: args.treatMissingConfidenceAsHigh ?? false,
  })
  if (reason === undefined) {
    return {...localResult, escalated: false}
  }

  // Phase 2 — gather remote, merge once across BOTH pools' raw findings.
  // This preserves multi-agent attribution that would be lost by piping
  // representatives back through the merge policy.
  //
  // Kimi S5.2: a Phase 2 throw (network partition, remote unavailable) must
  // NOT lose the local Phase 1 result. Catch + return degraded mode with
  // `escalationError` populated.
  //
  // Kimi S5.1 (acknowledged Tier-1 limitation): local + remote gather run
  // sequentially. Cumulative latency can exceed the caller's timeoutMs.
  // Slice 10.5 (latency-grouped pools) ships parallel local + remote
  // dispatch with per-pool timeouts — this stacking goes away there.
  const remoteSelector = makeRemoteOnlyPoolSelector<ClassifiableAgent>()
  const remotePick = remoteSelector(args.agents as ClassifiableAgent[])
  let remoteGather: Awaited<ReturnType<QuorumDispatcher['gather']>>
  try {
    remoteGather = await dispatcher.gather({
      ...args,
      agents: remotePick.selectedAgents as unknown as QuorumAgentRef[],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ...localResult,
      escalated: true,
      escalationError: message,
      escalationReason: reason,
    }
  }

  const combinedPerAgent = new Map<string, Finding[]>()
  for (const [agent, findings] of localGather.perAgentFindings) {
    combinedPerAgent.set(agent, [...findings])
  }

  for (const [agent, findings] of remoteGather.perAgentFindings) {
    const existing = combinedPerAgent.get(agent) ?? []
    combinedPerAgent.set(agent, [...existing, ...findings])
  }

  const allExpected = [...new Set([...localGather.expectedAgents, ...remoteGather.expectedAgents])].sort()
  const allResponded = [...new Set([...localGather.respondedAgents, ...remoteGather.respondedAgents])].sort()

  const ctx: MergeContext = {
    channelId: args.channelId,
    dispatchId: args.dispatchId,
    expectedAgents: allExpected,
    now: args.localFirstNow ?? (() => new Date()),
    pool: 'mixed',
    quorumThreshold: args.quorumThreshold,
    selectedAgents: allResponded,
    taskSchemaHash: args.taskSchemaHash,
  }
  const combined = args.mergePolicy.merge(combinedPerAgent, ctx)
  return {...combined, escalated: true, escalationReason: reason}
}

function mergeGather(
  gather: Awaited<ReturnType<QuorumDispatcher['gather']>>,
  pool: 'local' | 'mixed' | 'remote',
  args: LocalFirstDispatchArgs,
): MergedQuorum {
  const ctx: MergeContext = {
    channelId: args.channelId,
    dispatchId: args.dispatchId,
    expectedAgents: gather.expectedAgents,
    now: args.localFirstNow ?? (() => new Date()),
    pool,
    quorumThreshold: args.quorumThreshold,
    selectedAgents: gather.respondedAgents,
    taskSchemaHash: args.taskSchemaHash,
  }
  return args.mergePolicy.merge(gather.perAgentFindings, ctx)
}

function shouldEscalate(
  localResult: MergedQuorum,
  trigger: EscalationTrigger,
  opts: {
    readonly lowConfidenceThreshold: number
    readonly treatMissingConfidenceAsHigh: boolean
  },
): LocalFirstResult['escalationReason'] | undefined {
  if (trigger === 'never') return undefined

  // Kimi S3: contradiction takes precedence over empty when both fire under
  // 'empty-or-contradiction'. A non-empty `contradicted` signals ACTIVE
  // disagreement (the system has positions; they're mutually exclusive),
  // which is a stronger escalation signal than the absence of information.
  if ((trigger === 'empty-or-contradiction' || trigger === 'low-confidence') && localResult.contradicted.length > 0) return 'contradicted'

  if ((trigger === 'empty' || trigger === 'empty-or-contradiction') && localResult.agreed.length === 0) return 'empty'

  if (trigger === 'low-confidence') {
    // Codex C3: minimum (not average) — average hides the weak claim we want
    // to catch. Missing confidence treated as low by default, configurable via
    // treatMissingConfidenceAsHigh.
    const confidences = localResult.agreed.map(f =>
      f.confidence ?? (opts.treatMissingConfidenceAsHigh ? 1 : 0),
    )
    if (confidences.length === 0) return undefined
    const minConf = Math.min(...confidences)
    if (minConf < opts.lowConfidenceThreshold) return 'low-confidence'
  }

  return undefined
}

