import type {TurnEvent} from '../../shared/types/channel.js'

// Slice 8.9 — pure helpers extracted from `brv channel subscribe` so the
// filter / dedup / termination logic stays unit-testable without spinning up
// a daemon. Behaviour pinned by the codex plan review on 2026-05-15
// (turnId 8F2GbLBLghHtIp25qsb2b) and the implementation review at
// turnId RfdvMgmBjS8bSLGdKweXw (NUL-byte hygiene, P2 precedence).

// Dedup-key separator. ASCII Unit Separator (char code 31) cannot appear in
// turnId/memberHandle by construction. Codex impl-review flagged raw control
// bytes in source as poor hygiene; constructing the char from its code keeps
// the file ASCII-printable and grep-friendly.
const KEY_SEP = String.fromCodePoint(31)

export type SubscribeFilter = {
  kinds?: Set<string>
  roles?: Set<string>
  turn?: string
}

export function parseCommaSet(value?: string): Set<string> | undefined {
  if (value === undefined) return undefined
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (items.length === 0) return undefined
  return new Set(items)
}

export function matchesFilter(evt: TurnEvent, opts: SubscribeFilter): boolean {
  if (opts.turn !== undefined && evt.turnId !== opts.turn) return false
  if (opts.kinds !== undefined && !opts.kinds.has(evt.kind)) return false
  // Codex P2: turn-level events (memberHandle === null) pass the --roles
  // filter unconditionally, so a host using --roles still sees the overall
  // turn_state_change. Use --kinds to scope when this is unwanted.
  if (opts.roles !== undefined && evt.memberHandle !== null && evt.memberHandle !== undefined && !opts.roles.has(evt.memberHandle)) return false

  return true
}

export function isTerminalTurnEvent(evt: TurnEvent): boolean {
  return evt.kind === 'turn_state_change' && (evt.to === 'completed' || evt.to === 'cancelled')
}

export function isTerminalDeliveryEvent(evt: TurnEvent): boolean {
  return (
    evt.kind === 'delivery_state_change' &&
    (evt.to === 'completed' || evt.to === 'cancelled' || evt.to === 'errored')
  )
}

// Phase 10 Tier B1a (V6 run-2 evaluation §3a) — a delivery sitting in
// `awaiting_permission` is "blocked": it can only progress when a permission
// decision lands. For autonomous orchestrators that cannot answer
// permission prompts, treat this as count-eligible so a multi-agent gather
// doesn't deadlock when one delivery is permission-stalled.
export function isBlockedDeliveryEvent(evt: TurnEvent): boolean {
  return evt.kind === 'delivery_state_change' && evt.to === 'awaiting_permission'
}

// Active = the delivery is making progress (or will, given an in-flight
// scheduler). Used by the `--exit-on-permission-quorum` heuristic: if NO
// tracked delivery is in an active state AND at least one is blocked, the
// quorum gather can't make progress without human intervention.
const ACTIVE_DELIVERY_STATES: ReadonlySet<string> = new Set([
  'dispatched',
  'queued',
  'streaming',
])

export function isActiveDeliveryState(state: string): boolean {
  return ACTIVE_DELIVERY_STATES.has(state)
}

export function replayDedupKey(evt: TurnEvent): string {
  return `${evt.turnId}${KEY_SEP}${evt.seq}`
}

// Codex P3: `(turnId, memberHandle)` — two deliveries by the same member
// in the same turn count as one quorum unit. Returns undefined for turn-level
// events (memberHandle: null) since they don't represent member work.
export function countDedupKey(evt: TurnEvent): string | undefined {
  if (evt.memberHandle === null || evt.memberHandle === undefined) return undefined
  return `${evt.turnId}${KEY_SEP}${evt.memberHandle}`
}
