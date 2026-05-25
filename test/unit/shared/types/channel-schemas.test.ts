import {expect} from 'chai'

import type {Turn, TurnEvent} from '../../../../src/shared/types/channel.js'

import {TurnEventSchema, TurnSchema} from '../../../../src/shared/types/channel.js'

/* Deliberately a JSON round-trip (not structuredClone): the transcript store
 *persists these shapes as NDJSON, so this asserts JSON serializability.
 */
const jsonRoundTrip = (value: unknown): unknown =>
  // eslint-disable-next-line unicorn/prefer-structured-clone
  JSON.parse(JSON.stringify(value))

// M0-1 — the persisted/serialized channel shapes must survive a JSON
// round-trip unchanged, and must reject unknown fields (`.strict()`) so a
// drifting producer can't smuggle untyped data into the transcript store.
describe('channel-schemas', () => {
  const turn: Turn = {
    author: {handle: 'you', kind: 'local-user'},
    channelId: 'chan-1',
    mentions: ['@mock'],
    promptBlocks: [{text: 'hello', type: 'text'}],
    promptedBy: 'user',
    startedAt: '2026-05-25T10:00:00.000Z',
    state: 'pending',
    turnId: 'turn-1',
  }

  const messageEvent: TurnEvent = {
    channelId: 'chan-1',
    content: 'hi there',
    deliveryId: 'del-1',
    emittedAt: '2026-05-25T10:00:01.000Z',
    kind: 'message',
    memberHandle: '@mock',
    role: 'acp-agent',
    seq: 0,
    turnId: 'turn-1',
  }

  const toolCallEvent: TurnEvent = {
    channelId: 'chan-1',
    deliveryId: 'del-1',
    emittedAt: '2026-05-25T10:00:02.000Z',
    input: {path: '/tmp/x'},
    kind: 'tool_call',
    memberHandle: '@mock',
    name: 'read_file',
    seq: 1,
    toolCallId: 'tc-1',
    turnId: 'turn-1',
  }

  describe('round-trip', () => {
    it('a Turn survives parse(JSON round-trip)', () => {
      const parsed = TurnSchema.parse(jsonRoundTrip(turn))
      expect(parsed).to.deep.equal(turn)
    })

    it('a message TurnEvent survives parse(JSON round-trip)', () => {
      const parsed = TurnEventSchema.parse(jsonRoundTrip(messageEvent))
      expect(parsed).to.deep.equal(messageEvent)
    })

    it('a tool_call TurnEvent survives parse(JSON round-trip)', () => {
      const parsed = TurnEventSchema.parse(jsonRoundTrip(toolCallEvent))
      expect(parsed).to.deep.equal(toolCallEvent)
    })
  })

  describe('unknown-field rejection (.strict)', () => {
    it('rejects a Turn carrying an unknown top-level field', () => {
      const result = TurnSchema.safeParse({...turn, bogus: 1})
      expect(result.success).to.equal(false)
    })

    it('rejects a TurnEvent carrying an unknown top-level field', () => {
      const result = TurnEventSchema.safeParse({...messageEvent, bogus: 1})
      expect(result.success).to.equal(false)
    })
  })
})
