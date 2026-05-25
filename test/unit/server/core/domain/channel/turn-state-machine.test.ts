import {expect} from 'chai'

import {
  assertLegalDeliveryTransition,
  assertLegalTurnTransition,
  isLegalDeliveryTransition,
  isLegalTurnTransition,
  TURN_DELIVERY_TERMINAL_STATES,
  TURN_TERMINAL_STATES,
} from '../../../../../../src/server/core/domain/channel/turn-state-machine.js'

// Slice 1.3 — pure FSM per CHANNEL_PROTOCOL.md §4.5.
//
// Phase 1 only EXERCISES the passive-turn transitions (`pending → completed`
// and `pending → cancelled`), but the FSM defines the FULL transition table
// so Phase 2 dispatch + Phase 3 multi-agent fan-out land additively without
// re-touching this module.
describe('TurnStateMachine', () => {
describe('turn-level transitions', () => {
  it('accepts pending → completed (passive channel:post finalisation)', () => {
    expect(isLegalTurnTransition('pending', 'completed')).to.equal(true)
  })

  it('accepts pending → dispatched (channel:mention dispatches resolved mentions)', () => {
    expect(isLegalTurnTransition('pending', 'dispatched')).to.equal(true)
  })

  it('accepts pending → cancelled (full-turn cancel before dispatch)', () => {
    expect(isLegalTurnTransition('pending', 'cancelled')).to.equal(true)
  })

  it('accepts dispatched → completed (all deliveries terminal, not cancel-targeted)', () => {
    expect(isLegalTurnTransition('dispatched', 'completed')).to.equal(true)
  })

  it('accepts dispatched → cancelled (full-turn cancel with all deliveries settled)', () => {
    expect(isLegalTurnTransition('dispatched', 'cancelled')).to.equal(true)
  })

  it('rejects pending → pending (self-loop is not a transition)', () => {
    expect(isLegalTurnTransition('pending', 'pending')).to.equal(false)
  })

  it('rejects pending → dispatched-after-completed paths', () => {
    expect(isLegalTurnTransition('completed', 'dispatched')).to.equal(false)
    expect(isLegalTurnTransition('cancelled', 'dispatched')).to.equal(false)
  })

  it('exposes the terminal turn states for finalisation checks', () => {
    expect(TURN_TERMINAL_STATES).to.include.members(['completed', 'cancelled'])
    expect(TURN_TERMINAL_STATES).to.not.include('pending')
    expect(TURN_TERMINAL_STATES).to.not.include('dispatched')
  })

  it('assertLegalTurnTransition throws for illegal transitions and is silent for legal ones', () => {
    expect(() => assertLegalTurnTransition('pending', 'completed')).to.not.throw()
    expect(() => assertLegalTurnTransition('completed', 'pending')).to.throw(/transition/i)
  })
})

describe('delivery-level transitions', () => {
  it('accepts queued → dispatched (driver received session/prompt)', () => {
    expect(isLegalDeliveryTransition('queued', 'dispatched')).to.equal(true)
  })

  it('accepts queued → cancelled (cancel before prompt dispatched)', () => {
    expect(isLegalDeliveryTransition('queued', 'cancelled')).to.equal(true)
  })

  it('accepts dispatched → streaming (first session/update arrived)', () => {
    expect(isLegalDeliveryTransition('dispatched', 'streaming')).to.equal(true)
  })

  it('accepts dispatched → errored / cancelled before any update', () => {
    expect(isLegalDeliveryTransition('dispatched', 'errored')).to.equal(true)
    expect(isLegalDeliveryTransition('dispatched', 'cancelled')).to.equal(true)
  })

  it('accepts streaming → awaiting_permission / completed / errored / cancelled', () => {
    expect(isLegalDeliveryTransition('streaming', 'awaiting_permission')).to.equal(true)
    expect(isLegalDeliveryTransition('streaming', 'completed')).to.equal(true)
    expect(isLegalDeliveryTransition('streaming', 'errored')).to.equal(true)
    expect(isLegalDeliveryTransition('streaming', 'cancelled')).to.equal(true)
  })

  it('accepts awaiting_permission → streaming / cancelled / errored', () => {
    expect(isLegalDeliveryTransition('awaiting_permission', 'streaming')).to.equal(true)
    expect(isLegalDeliveryTransition('awaiting_permission', 'cancelled')).to.equal(true)
    expect(isLegalDeliveryTransition('awaiting_permission', 'errored')).to.equal(true)
  })

  it('rejects terminal-leaving transitions (absorbing terminal states)', () => {
    for (const terminal of TURN_DELIVERY_TERMINAL_STATES) {
      expect(isLegalDeliveryTransition(terminal, 'streaming')).to.equal(false)
      expect(isLegalDeliveryTransition(terminal, 'queued')).to.equal(false)
    }
  })

  it('exposes the terminal delivery states for orchestrator finalisation', () => {
    expect(TURN_DELIVERY_TERMINAL_STATES).to.include.members(['completed', 'cancelled', 'errored'])
    expect(TURN_DELIVERY_TERMINAL_STATES).to.not.include('queued')
    expect(TURN_DELIVERY_TERMINAL_STATES).to.not.include('streaming')
  })

  it('assertLegalDeliveryTransition throws for illegal transitions', () => {
    expect(() => assertLegalDeliveryTransition('queued', 'dispatched')).to.not.throw()
    expect(() => assertLegalDeliveryTransition('completed', 'streaming')).to.throw(/transition/i)
  })
})
})
