import {expect} from 'chai'

import type {TurnEvent} from '../../../../src/shared/types/channel.js'

import {
  countDedupKey,
  isTerminalDeliveryEvent,
  isTerminalTurnEvent,
  matchesFilter,
  parseCommaSet,
  replayDedupKey,
} from '../../../../src/oclif/lib/channel-subscribe-helpers.js'

// Slice 8.9 — pure helpers for `brv channel subscribe`. The command itself is
// a thin orchestration layer over connectChannelClient (already covered by
// other tests + manual verification). These pure helpers carry the logic the
// codex review (turnId 8F2GbLBLghHtIp25qsb2b on 2026-05-15) called out as
// load-bearing: filter precedence with nullable memberHandle, exclusive
// --after-seq semantics, and (turnId, memberHandle) quorum dedup.

const baseEvent = (overrides: Partial<TurnEvent> & {kind: TurnEvent['kind']}): TurnEvent => {
  const base = {
    channelId: 'ch',
    deliveryId: 'del-1',
    emittedAt: '2026-05-15T00:00:00.000Z',
    memberHandle: '@codex',
    seq: 1,
    turnId: 'turn-1',
  }
  switch (overrides.kind) {
    case 'agent_message_chunk': {
      return {...base, ...overrides, content: 'hello'} as TurnEvent
    }

    case 'agent_thought_chunk': {
      return {...base, ...overrides, content: 'think'} as TurnEvent
    }

    case 'delivery_state_change': {
      return {...base, ...overrides, from: 'streaming', to: 'completed'} as TurnEvent
    }

    case 'turn_state_change': {
      return {...base, ...overrides, deliveryId: null, from: 'dispatched', memberHandle: null, to: 'completed'} as TurnEvent
    }

    default: {
      return {...base, ...overrides} as TurnEvent
    }
  }
}

describe('subscribe-helpers (Slice 8.9)', () => {
  describe('parseCommaSet', () => {
    it('returns undefined for undefined input', () => {
      expect(parseCommaSet()).to.equal(undefined)
    })

    it('returns undefined for empty string', () => {
      expect(parseCommaSet('')).to.equal(undefined)
    })

    it('splits a comma-separated list into a Set', () => {
      const set = parseCommaSet('a,b,c')
      expect(set).to.be.instanceOf(Set)
      expect([...(set ?? new Set())].sort()).to.deep.equal(['a', 'b', 'c'])
    })

    it('trims whitespace and drops empty entries', () => {
      const set = parseCommaSet('  a  , , b ,c  ')
      expect([...(set ?? new Set())].sort()).to.deep.equal(['a', 'b', 'c'])
    })

    it('returns undefined when the input is only whitespace/commas', () => {
      expect(parseCommaSet('  , , ')).to.equal(undefined)
    })
  })

  describe('matchesFilter', () => {
    it('passes all events when no filters are set', () => {
      const evt = baseEvent({kind: 'agent_message_chunk'})
      expect(matchesFilter(evt, {})).to.equal(true)
    })

    it('filters by turn id', () => {
      const evt = baseEvent({kind: 'agent_message_chunk', turnId: 'turn-1'})
      expect(matchesFilter(evt, {turn: 'turn-1'})).to.equal(true)
      expect(matchesFilter(evt, {turn: 'turn-2'})).to.equal(false)
    })

    it('filters by kind', () => {
      const evt = baseEvent({kind: 'agent_message_chunk'})
      expect(matchesFilter(evt, {kinds: new Set(['agent_message_chunk'])})).to.equal(true)
      expect(matchesFilter(evt, {kinds: new Set(['tool_call'])})).to.equal(false)
    })

    it('filters by member handle for member-scoped events', () => {
      const evt = baseEvent({kind: 'agent_message_chunk', memberHandle: '@codex'})
      expect(matchesFilter(evt, {roles: new Set(['@codex'])})).to.equal(true)
      expect(matchesFilter(evt, {roles: new Set(['@kimi'])})).to.equal(false)
    })

    it('passes turn-level events (memberHandle: null) through the roles filter unconditionally (codex P2)', () => {
      const evt = baseEvent({kind: 'turn_state_change'})
      expect(evt.memberHandle).to.equal(null)
      expect(matchesFilter(evt, {roles: new Set(['@codex'])})).to.equal(true)
      expect(matchesFilter(evt, {roles: new Set(['@kimi'])})).to.equal(true)
    })

    it('combines turn + kind + roles filters', () => {
      const evt = baseEvent({kind: 'delivery_state_change', memberHandle: '@codex', turnId: 'turn-1'})
      expect(
        matchesFilter(evt, {
          kinds: new Set(['delivery_state_change']),
          roles: new Set(['@codex']),
          turn: 'turn-1',
        }),
      ).to.equal(true)
      expect(
        matchesFilter(evt, {
          kinds: new Set(['delivery_state_change']),
          roles: new Set(['@kimi']),
          turn: 'turn-1',
        }),
      ).to.equal(false)
    })
  })

  describe('isTerminalTurnEvent', () => {
    it('returns true for turn_state_change → completed', () => {
      const evt = baseEvent({kind: 'turn_state_change'}) as TurnEvent & {to: string}
      expect(isTerminalTurnEvent(evt)).to.equal(true)
    })

    it('returns true for turn_state_change → cancelled', () => {
      const evt = {...baseEvent({kind: 'turn_state_change'}), to: 'cancelled'} as TurnEvent
      expect(isTerminalTurnEvent(evt)).to.equal(true)
    })

    it('returns false for non-terminal turn_state_change', () => {
      const evt = {...baseEvent({kind: 'turn_state_change'}), to: 'dispatched'} as TurnEvent
      expect(isTerminalTurnEvent(evt)).to.equal(false)
    })

    it('returns false for non-turn_state_change events', () => {
      expect(isTerminalTurnEvent(baseEvent({kind: 'agent_message_chunk'}))).to.equal(false)
      expect(isTerminalTurnEvent(baseEvent({kind: 'delivery_state_change'}))).to.equal(false)
    })
  })

  describe('isTerminalDeliveryEvent', () => {
    it('returns true for delivery_state_change → completed', () => {
      expect(isTerminalDeliveryEvent(baseEvent({kind: 'delivery_state_change'}))).to.equal(true)
    })

    it('returns true for delivery_state_change → cancelled', () => {
      const evt = {...baseEvent({kind: 'delivery_state_change'}), to: 'cancelled'} as TurnEvent
      expect(isTerminalDeliveryEvent(evt)).to.equal(true)
    })

    it('returns true for delivery_state_change → errored', () => {
      const evt = {...baseEvent({kind: 'delivery_state_change'}), to: 'errored'} as TurnEvent
      expect(isTerminalDeliveryEvent(evt)).to.equal(true)
    })

    it('returns false for delivery_state_change → streaming', () => {
      const evt = {...baseEvent({kind: 'delivery_state_change'}), to: 'streaming'} as TurnEvent
      expect(isTerminalDeliveryEvent(evt)).to.equal(false)
    })

    it('returns false for non-delivery events', () => {
      expect(isTerminalDeliveryEvent(baseEvent({kind: 'turn_state_change'}))).to.equal(false)
      expect(isTerminalDeliveryEvent(baseEvent({kind: 'agent_message_chunk'}))).to.equal(false)
    })
  })

  describe('replayDedupKey', () => {
    it('produces a stable key from (turnId, seq) — codex P4 crash cursor', () => {
      const evt = baseEvent({kind: 'agent_message_chunk', seq: 42, turnId: 'turn-x'})
      // Same turnId+seq → same key
      const evt2 = baseEvent({kind: 'delivery_state_change', seq: 42, turnId: 'turn-x'})
      expect(replayDedupKey(evt)).to.equal(replayDedupKey(evt2))
    })

    it('distinguishes different seq within the same turn', () => {
      const evt1 = baseEvent({kind: 'agent_message_chunk', seq: 1, turnId: 'turn-x'})
      const evt2 = baseEvent({kind: 'agent_message_chunk', seq: 2, turnId: 'turn-x'})
      expect(replayDedupKey(evt1)).to.not.equal(replayDedupKey(evt2))
    })

    it('distinguishes same seq across different turns (per-turn monotonic seq)', () => {
      const evt1 = baseEvent({kind: 'agent_message_chunk', seq: 1, turnId: 'turn-a'})
      const evt2 = baseEvent({kind: 'agent_message_chunk', seq: 1, turnId: 'turn-b'})
      expect(replayDedupKey(evt1)).to.not.equal(replayDedupKey(evt2))
    })
  })

  describe('countDedupKey', () => {
    it('produces a key from (turnId, memberHandle) for quorum counting (codex P3)', () => {
      const evt = baseEvent({kind: 'delivery_state_change', memberHandle: '@codex', turnId: 'turn-x'})
      const expected = `turn-x${String.fromCodePoint(31)}@codex`
      expect(countDedupKey(evt)).to.equal(expected)
    })

    it('returns undefined when memberHandle is null (turn-level event has no member to count)', () => {
      const evt = baseEvent({kind: 'turn_state_change'})
      expect(countDedupKey(evt)).to.equal(undefined)
    })

    it('treats two deliveries by same member in same turn as ONE quorum unit', () => {
      const evt1 = baseEvent({deliveryId: 'd1', kind: 'delivery_state_change', memberHandle: '@codex', turnId: 'turn-x'})
      const evt2 = baseEvent({deliveryId: 'd2', kind: 'delivery_state_change', memberHandle: '@codex', turnId: 'turn-x'})
      expect(countDedupKey(evt1)).to.equal(countDedupKey(evt2))
    })

    it('distinguishes different members in the same turn', () => {
      const evt1 = baseEvent({kind: 'delivery_state_change', memberHandle: '@codex'})
      const evt2 = baseEvent({kind: 'delivery_state_change', memberHandle: '@kimi'})
      expect(countDedupKey(evt1)).to.not.equal(countDedupKey(evt2))
    })

    it('distinguishes the same member across different turns', () => {
      const evt1 = baseEvent({kind: 'delivery_state_change', memberHandle: '@codex', turnId: 'turn-a'})
      const evt2 = baseEvent({kind: 'delivery_state_change', memberHandle: '@codex', turnId: 'turn-b'})
      expect(countDedupKey(evt1)).to.not.equal(countDedupKey(evt2))
    })
  })
})
