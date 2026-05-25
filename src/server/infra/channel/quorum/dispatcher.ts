import type {
  Finding,
  MergedQuorum,
} from '../../../core/domain/channel/quorum.js'
import type {
  DispatchHandle,
  DispatchOneArgs,
  TerminalDelivery,
} from '../../../core/interfaces/channel/i-channel-orchestrator.js'
import type {
  IMergePolicy,
  MergeContext,
} from '../../../core/interfaces/channel/i-merge-policy.js'

import {
  FINDING_SCHEMA_VERSION,
} from '../../../core/domain/channel/quorum.js'
import {
  canonicaliseClaimText,
  claimHash,
} from './canonicalise.js'

// Phase 10 Slice 10.2 — QuorumDispatcher.
//
// Daemon-side dispatcher that fan-outs to K agents via the orchestrator's
// internal `dispatchOne()` API (codex Q4: NO shell-out) and gathers terminal
// deliveries via each handle's `terminal` Promise (codex C5: no pub/sub —
// `TerminalDelivery` is the non-streaming contract). The Q8 follow-on
// "terminal-state-filtered gather" is enforced by the orchestrator inside
// `dispatchOne()`: the `terminal` Promise resolves ONLY for completed |
// errored | cancelled states.
//
// `PoolSelector` is a first-class seam (codex Q7) so Slice 10.3's local-first
// variant is an extension, not a refactor.
//
// `QuorumAgentRef` is the minimal shape the dispatcher actually reads. Slice
// 10.3+ can widen this (e.g. add `driverClass`, `latencyHintMs`) without
// breaking the dispatcher contract, since today only `handle` is touched.

export type QuorumAgentRef = {
  readonly handle: string
}

export type PoolSelector<T extends QuorumAgentRef = QuorumAgentRef> = (agents: T[]) => {
  pool: 'local' | 'mixed' | 'remote'
  selectedAgents: T[]
}

const defaultPoolSelector: PoolSelector = (agents) => ({
  pool: 'mixed',
  selectedAgents: agents,
})

export type QuorumDispatcherOrchestratorPort = {
  dispatchOne(args: DispatchOneArgs): Promise<DispatchHandle>
}

export type QuorumDispatchArgs = {
  readonly agents: QuorumAgentRef[]
  readonly channelId: string
  readonly dispatchId: string
  readonly idempotencyKey?: string
  readonly mergePolicy: IMergePolicy
  readonly projectRoot: string
  readonly prompt: string
  readonly quorumThreshold: number
  readonly suppressThoughts?: boolean
  readonly taskSchemaHash: string
  readonly timeoutMs: number
}

export type QuorumDispatcherDeps = {
  readonly now?: () => Date
  readonly orchestrator: QuorumDispatcherOrchestratorPort
  readonly poolSelector?: PoolSelector
}

type AgentResult =
  | {readonly delivery: TerminalDelivery; readonly memberHandle: string; readonly status: 'terminal'; readonly turnId: string}
  | {readonly errorMessage: string; readonly memberHandle: string; readonly status: 'failed-to-dispatch'}

// Phase 10 Slice 10.3 — raw gather output. Exposes per-agent findings + pool +
// expected/responded sets so callers (e.g. local-first orchestration) can do
// their own merge across multiple gather() invocations without re-piping
// representatives through a merge policy (which would lose multi-agent
// attribution).
export type GatherResult = {
  readonly expectedAgents: ReadonlyArray<string>
  readonly perAgentFindings: Map<string, Finding[]>
  readonly pool: 'local' | 'mixed' | 'remote'
  readonly respondedAgents: ReadonlyArray<string>
}

export class QuorumDispatcher {
  private readonly now: () => Date
  private readonly orchestrator: QuorumDispatcherOrchestratorPort
  private readonly poolSelector: PoolSelector

  constructor(deps: QuorumDispatcherDeps) {
    this.orchestrator = deps.orchestrator
    this.poolSelector = deps.poolSelector ?? defaultPoolSelector
    this.now = deps.now ?? (() => new Date())
  }

  async dispatch(args: QuorumDispatchArgs): Promise<MergedQuorum> {
    const gathered = await this.gather(args)
    const mergeContext: MergeContext = {
      channelId: args.channelId,
      dispatchId: args.dispatchId,
      expectedAgents: gathered.expectedAgents,
      now: this.now,
      pool: gathered.pool,
      quorumThreshold: args.quorumThreshold,
      selectedAgents: gathered.respondedAgents,
      taskSchemaHash: args.taskSchemaHash,
    }
    return args.mergePolicy.merge(gathered.perAgentFindings, mergeContext)
  }

  // Phase 10 Slice 10.3 — exposes raw per-agent findings without applying
  // the merge policy. Used by `dispatchLocalFirst` to combine two passes'
  // findings under a single merge invocation (preserves multi-agent
  // attribution that would be lost by piping representatives through merge
  // twice).
  async gather(args: QuorumDispatchArgs): Promise<GatherResult> {
    const {pool, selectedAgents} = this.poolSelector(args.agents)
    const expectedAgents = args.agents.map(a => a.handle)

    const results = await Promise.all(
      selectedAgents.map(async (member): Promise<AgentResult> => {
        try {
          const handle = await this.orchestrator.dispatchOne({
            channelId: args.channelId,
            idempotencyKey: args.idempotencyKey,
            memberHandle: member.handle,
            projectRoot: args.projectRoot,
            prompt: args.prompt,
            suppressThoughts: args.suppressThoughts,
            timeoutMs: args.timeoutMs,
          })
          const delivery = await handle.terminal
          return {delivery, memberHandle: member.handle, status: 'terminal', turnId: handle.turnId}
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return {errorMessage: message, memberHandle: member.handle, status: 'failed-to-dispatch'}
        }
      }),
    )

    const perAgentFindings = new Map<string, Finding[]>()
    const respondedAgents: string[] = []
    for (const result of results) {
      if (result.status !== 'terminal') continue
      // Phase 10 follow-up A2 — accept partial `finalAnswer` from
      // `errored` (e.g. CHANNEL_SYNC_TIMEOUT) deliveries as a recoverable
      // contribution. V6 retest exposed this: kimi streamed real JSON
      // findings but the sync-mode timeout dropped the buffered output
      // before the dispatcher could read it.
      const usable =
        (result.delivery.state === 'completed' && result.delivery.finalAnswer !== undefined) ||
        (result.delivery.state === 'errored' && result.delivery.finalAnswer !== undefined && result.delivery.finalAnswer !== '')
      if (!usable) continue
      const findings = extractFindings({
        agent: result.memberHandle,
        delivery: result.delivery,
        turnId: result.turnId,
      })
      perAgentFindings.set(result.memberHandle, findings)
      respondedAgents.push(result.memberHandle)
    }

    return {expectedAgents, perAgentFindings, pool, respondedAgents}
  }
}

function extractFindings(args: {
  readonly agent: string
  readonly delivery: TerminalDelivery
  readonly turnId: string
}): Finding[] {
  const {agent, delivery, turnId} = args
  const finalAnswer = delivery.finalAnswer ?? ''
  const parsed = tryParseJsonFindings(finalAnswer)
  if (parsed.length > 0) {
    return parsed.map(p => buildFinding({
      agent,
      claim: p.claim,
      confidence: p.confidence,
      delivery,
      evidence: p.evidence ?? [],
      now: delivery.endedAt,
      turnId,
    }))
  }

  // Codex Q5 Tier-1 fallback: whole-answer-as-single-finding.
  return [
    buildFinding({
      agent,
      claim: finalAnswer,
      delivery,
      evidence: [],
      now: delivery.endedAt,
      turnId,
    }),
  ]
}

type ParsedFinding = {
  readonly claim: string
  readonly confidence?: number
  readonly evidence?: Array<{
    readonly endLine?: number
    readonly excerpt: string
    readonly source: string
    readonly startLine?: number
  }>
}

const CODE_FENCE_PATTERN = /^```(?:json)?\s*|\s*```$/g

function tryParseJsonFindings(raw: string): ParsedFinding[] {
  // Kimi R4: strip ```json ... ``` code fences before JSON.parse. Agents
  // frequently emit fenced output even when instructed to return raw JSON.
  // This avoids unnecessary fall-back to whole-answer for fenced findings.
  const trimmed = raw.trim().replaceAll(CODE_FENCE_PATTERN, '').trim()
  if (trimmed === '' || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
    return []
  }

  try {
    const obj = JSON.parse(trimmed) as unknown
    const candidates: unknown =
      Array.isArray(obj) ? obj : (typeof obj === 'object' && obj !== null && 'findings' in obj ? (obj as {findings: unknown}).findings : undefined)
    if (!Array.isArray(candidates)) return []
    const out: ParsedFinding[] = []
    for (const c of candidates) {
      if (typeof c === 'object' && c !== null && 'claim' in c && typeof (c as {claim: unknown}).claim === 'string') {
        const candidate = c as {claim: string; confidence?: number; evidence?: unknown}
        const evidence = Array.isArray(candidate.evidence)
          ? candidate.evidence
              .filter((e): e is {excerpt: string; source: string} =>
                typeof e === 'object' && e !== null && typeof (e as {excerpt: unknown}).excerpt === 'string' && typeof (e as {source: unknown}).source === 'string')
              .map(e => ({excerpt: e.excerpt, source: e.source}))
          : undefined
        out.push({
          claim: candidate.claim,
          confidence: typeof candidate.confidence === 'number' ? candidate.confidence : undefined,
          evidence,
        })
      }
    }

    return out
  } catch {
    return []
  }
}

function buildFinding(args: {
  readonly agent: string
  readonly claim: string
  readonly confidence?: number
  readonly delivery: TerminalDelivery
  readonly evidence: Finding['evidence']
  readonly now: string
  readonly turnId: string
}): Finding {
  const canonical = canonicaliseClaimText(args.claim)
  return {
    agent: args.agent,
    canonicalClaim: canonical,
    claim: args.claim,
    claimHash: claimHash(canonical),
    confidence: args.confidence,
    emittedAt: args.now,
    evidence: args.evidence,
    schemaVersion: FINDING_SCHEMA_VERSION,
    sourceDeliveryId: args.delivery.deliveryId,
    sourceTurnId: args.turnId,
  }
}
