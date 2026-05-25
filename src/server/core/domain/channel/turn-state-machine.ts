import type {TurnDeliveryState, TurnState} from '../../../../shared/types/channel.js'

/**
 * Pure, side-effect-free finite state machine for the channel turn/delivery
 * lifecycle (M0-1). M0 only exercises the passive-turn transitions, but the
 * full transition table is defined here so M2 dispatch and M3 fan-out land
 * additively without re-touching this module. Terminal states are absorbing.
 */

// ─── Turn-level ─────────────────────────────────────────────────────────────

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

// ─── Delivery-level ─────────────────────────────────────────────────────────

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
