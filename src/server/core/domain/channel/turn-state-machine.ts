import type {TurnDeliveryState, TurnState} from '../../../../shared/types/channel.js'

/**
 * Pure turn / delivery state machines per CHANNEL_PROTOCOL.md §4.5.
 *
 * Phase 1 only EXERCISES the passive-turn paths (`pending → completed` and
 * `pending → cancelled`); the full transition tables are defined here so
 * Phase 2 dispatch + Phase 3 multi-agent fan-out land additively without
 * re-touching this module.
 *
 * No IO, no side effects. Consumers call `isLegal*Transition()` for branching
 * logic and `assertLegal*Transition()` to throw on invariant violations
 * before persisting state.
 */

// ─── Turn-level transitions ─────────────────────────────────────────────────

const LEGAL_TURN_TRANSITIONS: ReadonlyMap<TurnState, ReadonlySet<TurnState>> = new Map([
  ['cancelled', new Set<TurnState>()],
  ['completed', new Set<TurnState>()],
  ['dispatched', new Set<TurnState>(['cancelled', 'completed'])],
  // (initial) → 'pending' is implicit (turn creation), not modelled here.
  ['pending', new Set<TurnState>(['cancelled', 'completed', 'dispatched'])],
])

export const TURN_TERMINAL_STATES: readonly TurnState[] = ['completed', 'cancelled']

export const isLegalTurnTransition = (from: TurnState, to: TurnState): boolean =>
  LEGAL_TURN_TRANSITIONS.get(from)?.has(to) ?? false

export const assertLegalTurnTransition = (from: TurnState, to: TurnState): void => {
  if (!isLegalTurnTransition(from, to)) {
    throw new Error(`Illegal turn transition: ${from} → ${to}`)
  }
}

// ─── Delivery-level transitions ─────────────────────────────────────────────

const LEGAL_DELIVERY_TRANSITIONS: ReadonlyMap<
  TurnDeliveryState,
  ReadonlySet<TurnDeliveryState>
> = new Map([
  ['awaiting_permission', new Set<TurnDeliveryState>(['cancelled', 'errored', 'streaming'])],
  ['cancelled', new Set<TurnDeliveryState>()],
  ['completed', new Set<TurnDeliveryState>()],
  ['dispatched', new Set<TurnDeliveryState>(['cancelled', 'errored', 'streaming'])],
  ['errored', new Set<TurnDeliveryState>()],
  // (initial) → 'queued' is implicit (turn dispatch creates the delivery).
  ['queued', new Set<TurnDeliveryState>(['cancelled', 'dispatched'])],
  ['streaming', new Set<TurnDeliveryState>(['awaiting_permission', 'cancelled', 'completed', 'errored'])],
])

export const TURN_DELIVERY_TERMINAL_STATES: readonly TurnDeliveryState[] = [
  'completed',
  'cancelled',
  'errored',
]

export const isLegalDeliveryTransition = (
  from: TurnDeliveryState,
  to: TurnDeliveryState,
): boolean => LEGAL_DELIVERY_TRANSITIONS.get(from)?.has(to) ?? false

export const assertLegalDeliveryTransition = (
  from: TurnDeliveryState,
  to: TurnDeliveryState,
): void => {
  if (!isLegalDeliveryTransition(from, to)) {
    throw new Error(`Illegal delivery transition: ${from} → ${to}`)
  }
}
