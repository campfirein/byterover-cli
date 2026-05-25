import {expect} from 'chai'

import {
  DEFAULT_IDEMPOTENCY_BUCKET_MS,
  deriveIdempotencyKey,
} from '../../../../../src/server/infra/channel/idempotency-key.js'

// Phase 10 Tier C #2 — auto-idempotency key derivation. Confirms the
// hash collapses structurally-equal dispatches inside a 5-minute bucket
// and distinguishes any single material change (prompt, mentions,
// channelId, bucket).

describe('deriveIdempotencyKey', () => {
  const baseArgs = {
    channelId: 'review-2026',
    mentions: ['@kimi'],
    nowMs: Date.parse('2026-05-18T12:00:00.000Z'),
    promptBlocks: [{text: '@kimi review src/auth.py', type: 'text' as const}],
  }

  it('produces the same key for identical inputs inside the same bucket', () => {
    const a = deriveIdempotencyKey(baseArgs)
    const b = deriveIdempotencyKey({...baseArgs, nowMs: baseArgs.nowMs + 60_000})
    expect(a).to.equal(b)
  })

  it('produces a different key when the bucket advances', () => {
    const a = deriveIdempotencyKey(baseArgs)
    const b = deriveIdempotencyKey({
      ...baseArgs,
      nowMs: baseArgs.nowMs + DEFAULT_IDEMPOTENCY_BUCKET_MS,
    })
    expect(a).to.not.equal(b)
  })

  it('produces a different key when the prompt text differs', () => {
    const a = deriveIdempotencyKey(baseArgs)
    const b = deriveIdempotencyKey({
      ...baseArgs,
      promptBlocks: [{text: '@kimi review src/auth.py please', type: 'text' as const}],
    })
    expect(a).to.not.equal(b)
  })

  it('produces a different key when mentions differ', () => {
    const a = deriveIdempotencyKey(baseArgs)
    const b = deriveIdempotencyKey({...baseArgs, mentions: ['@codex']})
    expect(a).to.not.equal(b)
  })

  it('treats mention order as irrelevant (sorted before hashing)', () => {
    const a = deriveIdempotencyKey({...baseArgs, mentions: ['@kimi', '@codex']})
    const b = deriveIdempotencyKey({...baseArgs, mentions: ['@codex', '@kimi']})
    expect(a).to.equal(b)
  })

  it('produces a different key when channelId differs', () => {
    const a = deriveIdempotencyKey(baseArgs)
    const b = deriveIdempotencyKey({...baseArgs, channelId: 'other-channel'})
    expect(a).to.not.equal(b)
  })

  it('returns a 64-char hex sha256 digest', () => {
    const key = deriveIdempotencyKey(baseArgs)
    expect(key).to.match(/^[\da-f]{64}$/)
  })
})
