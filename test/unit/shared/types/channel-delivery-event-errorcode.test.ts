import {expect} from 'chai'

import {TurnEventSchema} from '../../../../src/shared/types/channel.js'

// Slice 8.11 Layer 1 — codex Q6: `delivery_state_change` event needs an
// optional `errorCode` field so hosts subscribed via `subscribe`/`watch`
// can programmatically detect failures like CHANNEL_DRIVER_NOT_REGISTERED
// from the wire event. Previously only `error: string` was on the schema,
// which carries the human-readable text but not the canonical wire code.
// Backward-compatible because the field is `.optional()`.

describe('delivery_state_change.errorCode (Slice 8.11 schema extension)', () => {
  const baseEventFields = {
    channelId: 'pubsub-review',
    deliveryId: 'del-1',
    emittedAt: '2026-05-17T00:00:00.000Z',
    memberHandle: '@codex',
    seq: 1,
    turnId: 'turn-xyz',
  }

  it('accepts delivery_state_change events WITHOUT errorCode (backward compatible)', () => {
    const result = TurnEventSchema.safeParse({
      ...baseEventFields,
      from: 'streaming',
      kind: 'delivery_state_change',
      to: 'completed',
    })
    expect(result.success, JSON.stringify(result)).to.equal(true)
  })

  it('accepts delivery_state_change events WITH optional errorCode populated', () => {
    const result = TurnEventSchema.safeParse({
      ...baseEventFields,
      error: 'No live ACP driver for @codex in pool',
      errorCode: 'CHANNEL_DRIVER_NOT_REGISTERED',
      from: 'queued',
      kind: 'delivery_state_change',
      to: 'errored',
    })
    expect(result.success, JSON.stringify(result)).to.equal(true)
    if (result.success) {
      const event = result.data
      // Narrow via the discriminated union.
      expect(event.kind).to.equal('delivery_state_change')
      if (event.kind === 'delivery_state_change') {
        expect(event.errorCode).to.equal('CHANNEL_DRIVER_NOT_REGISTERED')
        expect(event.error).to.include('No live ACP driver')
      }
    }
  })

  it('accepts delivery_state_change events WITH errorCode but no human error message', () => {
    // Defensive: code without message is unusual but should not be rejected.
    const result = TurnEventSchema.safeParse({
      ...baseEventFields,
      errorCode: 'CHANNEL_DRIVER_NOT_REGISTERED',
      from: 'streaming',
      kind: 'delivery_state_change',
      to: 'errored',
    })
    expect(result.success, JSON.stringify(result)).to.equal(true)
  })

  it('rejects non-string errorCode (type safety)', () => {
    const result = TurnEventSchema.safeParse({
      ...baseEventFields,
      errorCode: 42,
      from: 'streaming',
      kind: 'delivery_state_change',
      to: 'errored',
    })
    expect(result.success).to.equal(false)
  })
})
