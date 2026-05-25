// Phase 10 Slice 10.6 — strength profiles + tag-based matchmaking.
//
// `IMatchmaker.matchAgents` picks `targetSize` agents from a pool by scoring
// each candidate against the caller's needed tags. Scoring is
// `|agentStrengths ∩ neededTags|`; ties break deterministically by handle
// name so the result is stable across calls.
//
// Tier 1: hardcoded default profiles for known agents (kimi, codex, opencode,
// pi). Tier 2 will add a Zod-extensible `strengths: string[]` field on
// ChannelMember so per-channel overrides persist in meta.json. The
// matchmaker contract is stable across that addition — only the
// `resolveStrengths()` lookup widens.

import type {QuorumAgentRef} from './dispatcher.js'

// Default strength tags for known ACP agents. Observed across V1–V6 super-
// mario retests + Phase 10 channel work. Hidden behind `resolveStrengths`
// so per-channel overrides can plug in later.
const DEFAULT_STRENGTHS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ['@claude-code', ['planning', 'design-review', 'cross-cutting-refactor']],
  ['@codex', ['api-design', 'concurrency', 'static-analysis', 'type-safety']],
  ['@kimi', ['integration-bugs', 'multi-agent-coordination', 'protocol-correctness']],
  ['@opencode', ['rendering', 'ux', 'visual-design']],
  ['@pi', ['concurrency', 'reasoning', 'systems-design']],
])

export type StrengthAgent = QuorumAgentRef & {
  readonly strengths?: ReadonlyArray<string>
}

export type MatchAgentsArgs<T extends StrengthAgent> = {
  readonly neededTags: ReadonlyArray<string>
  readonly poolMembers: ReadonlyArray<T>
  readonly targetSize: number
}

export interface IMatchmaker {
  matchAgents<T extends StrengthAgent>(args: MatchAgentsArgs<T>): T[]
}

export class LocalMatchmaker implements IMatchmaker {
  matchAgents<T extends StrengthAgent>(args: MatchAgentsArgs<T>): T[] {
    if (args.targetSize <= 0) return []
    if (args.poolMembers.length === 0) return []

    const tagSet = new Set(args.neededTags.map(t => t.toLowerCase()))
    // No tag filtering — caller didn't specify needs. Return first targetSize
    // members in their input order (stable + predictable).
    if (tagSet.size === 0) {
      return args.poolMembers.slice(0, args.targetSize)
    }

    const scored = args.poolMembers
      .map(member => ({
        member,
        score: scoreAgainstTags(resolveStrengths(member), tagSet),
      }))
      .sort((a, b) => {
        // Primary: higher score wins.
        if (a.score !== b.score) return b.score - a.score
        // Tie-break: alphabetical handle for determinism (codex Q3
        // singleton-style: predictable ordering, no hidden RNG).
        return a.member.handle.localeCompare(b.member.handle)
      })

    return scored.slice(0, args.targetSize).map(s => s.member)
  }
}

export function resolveStrengths<T extends StrengthAgent>(agent: T): ReadonlyArray<string> {
  if (agent.strengths !== undefined && agent.strengths.length > 0) {
    return agent.strengths
  }

  return DEFAULT_STRENGTHS.get(agent.handle) ?? []
}

function scoreAgainstTags(strengths: ReadonlyArray<string>, neededTags: ReadonlySet<string>): number {
  let score = 0
  for (const tag of strengths) {
    if (neededTags.has(tag.toLowerCase())) score++
  }

  return score
}

export {DEFAULT_STRENGTHS}
