import {expect} from 'chai'

import {TurnEventSchema} from '../../../../../src/shared/types/channel.js'

// Slice 4.−1 — TurnEvent schema widening (CHANNEL_PROTOCOL.md §7.1 amendment).
//
// Two additive changes:
//   1. New `agent_meta` variant — hosts MAY project unrecognised
//      `session/update` notifications into a payload-only event.
//   2. `tool_call_update.status` loosened from the closed Phase-3 enum
//      ('in_progress' | 'completed' | 'failed') to any string the agent emits.
//
// Both changes are forward-compat-only: no existing event payload becomes
// invalid; slices 4.3 (projector) and the integration tests depend on
// `TurnEventSchema.parse(...)` accepting the new shapes.

const base = {
  channelId: 'pi-test',
  deliveryId: 'd-1',
  emittedAt: new Date('2026-05-12T00:00:00.000Z').toISOString(),
  memberHandle: '@kimi',
  seq: 1,
  turnId: '01HX-test-turn',
}

describe('TurnEventSchema — Slice 4.−1 widening', () => {
  describe('agent_meta variant', () => {
    it('accepts agent_meta with subKind + payload', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'agent_meta',
        payload: {
          availableCommands: [{description: 'show help', name: '/help'}],
        },
        subKind: 'available_commands_update',
      })
      expect(parsed.success).to.equal(true)
    })

    it('accepts agent_meta with an empty payload object', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'agent_meta',
        payload: {},
        subKind: 'current_mode_update',
      })
      expect(parsed.success).to.equal(true)
    })

    it('rejects agent_meta without subKind', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'agent_meta',
        payload: {anything: 'here'},
      })
      expect(parsed.success).to.equal(false)
    })

    it('rejects agent_meta without payload', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'agent_meta',
        subKind: 'current_model_update',
      })
      expect(parsed.success).to.equal(false)
    })

    it('rejects agent_meta with a non-string subKind', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'agent_meta',
        payload: {},
        subKind: 42,
      })
      expect(parsed.success).to.equal(false)
    })
  })

  describe('tool_call_update.status widening', () => {
    it('accepts the Phase-3 statuses (regression sentinel)', () => {
      for (const status of ['in_progress', 'completed', 'failed']) {
        const parsed = TurnEventSchema.safeParse({
          ...base,
          kind: 'tool_call_update',
          status,
          toolCallId: 'tc-1',
        })
        expect(parsed.success, `status ${status} should still parse`).to.equal(true)
      }
    })

    it('accepts status: "pending" (was rejected pre-4.−1)', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'tool_call_update',
        status: 'pending',
        toolCallId: 'tc-2',
      })
      expect(parsed.success).to.equal(true)
    })

    it('accepts any agent-emitted status string', () => {
      for (const status of ['queued', 'cancelled', 'partial', 'streaming', 'awaiting_review']) {
        const parsed = TurnEventSchema.safeParse({
          ...base,
          kind: 'tool_call_update',
          status,
          toolCallId: 'tc-3',
        })
        expect(parsed.success, `status ${status} should parse`).to.equal(true)
      }
    })

    it('rejects a non-string status (e.g. numeric)', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'tool_call_update',
        status: 1,
        toolCallId: 'tc-4',
      })
      expect(parsed.success).to.equal(false)
    })

    it('tolerates status absent (the field stays optional)', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        kind: 'tool_call_update',
        toolCallId: 'tc-5',
      })
      expect(parsed.success).to.equal(true)
    })
  })

  describe('regression: existing variants still parse', () => {
    it('agent_message_chunk', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        content: 'hi',
        kind: 'agent_message_chunk',
      })
      expect(parsed.success).to.equal(true)
    })

    it('tool_call', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        input: {path: '/tmp/foo'},
        kind: 'tool_call',
        name: 'fs.read',
        toolCallId: 'tc-x',
      })
      expect(parsed.success).to.equal(true)
    })

    it('turn_state_change', () => {
      const parsed = TurnEventSchema.safeParse({
        ...base,
        deliveryId: null,
        from: 'dispatched',
        kind: 'turn_state_change',
        memberHandle: null,
        to: 'completed',
      })
      expect(parsed.success).to.equal(true)
    })
  })
})
