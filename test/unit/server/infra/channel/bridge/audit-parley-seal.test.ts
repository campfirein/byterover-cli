/* eslint-disable camelcase */
// Bound-context wire fields use snake_case (parley §5.2).

import {expect} from 'chai'
import {generateKeyPairSync} from 'node:crypto'

import {signTranscriptSeal} from '../../../../../../src/agent/core/trust/sign.js'
import {
  type ParleyResponseFrame,
  transcriptDigest,
} from '../../../../../../src/server/core/domain/channel/parley-types.js'
import {auditParleySeal} from '../../../../../../src/server/infra/channel/bridge/audit-parley-seal.js'

// Phase 9 / Slice 9.10 — extract-and-harden the transcript-seal
// verification helper so it can be re-run AFTER frames have been
// persisted. Round-1 hardenings: TRAILING_FRAMES_AFTER_SEAL,
// STRUCTURE_INVALID, errored-path sig-verify.

const keypair = generateKeyPairSync('ed25519')
const remoteL2PubKey = keypair.publicKey

const buildBound = (overrides: Partial<{
  channel_id: string
  delivery_id: string
  ended_state: 'cancelled' | 'completed' | 'errored'
  protocol: 'delegate' | 'query'
  request_envelope_hash: string
  turn_id: string
}> = {}) => ({
  channel_id: 'demo-channel',
  delivery_id: 'd-001',
  ended_state: 'completed' as const,
  protocol: 'query' as const,
  request_envelope_hash: 'a'.repeat(64),
  turn_id: 't-001',
  ...overrides,
})

const buildSignedTranscript = (
  preSealFrames: ParleyResponseFrame[],
  bound: ReturnType<typeof buildBound>,
): ParleyResponseFrame[] => {
  const digest = transcriptDigest(preSealFrames)
  const sealPayload = {
    channel_id: bound.channel_id,
    delivery_id: bound.delivery_id,
    ended_state: bound.ended_state,
    protocol: bound.protocol,
    request_envelope_hash: bound.request_envelope_hash,
    transcript_digest: digest,
    turn_id: bound.turn_id,
  }
  const signature = signTranscriptSeal(sealPayload, keypair.privateKey)
  return [
    ...preSealFrames,
    {
      kind: 'transcript_seal',
      seq: preSealFrames.length + 1,
      signature,
      transcript_digest: digest,
    },
  ]
}

describe('auditParleySeal (slice 9.10)', () => {
  const validPreSeal: ParleyResponseFrame[] = [
    {content: 'hello', kind: 'agent_message_chunk', seq: 1},
    {ended_state: 'completed', kind: 'stream_end', seq: 2, signature: 'AA'.repeat(32) + '=='},
  ]

  it('returns ok=true for a faithfully-persisted transcript', () => {
    const bound = buildBound()
    const frames = buildSignedTranscript(validPreSeal, bound)
    const result = auditParleySeal({bound, frames, remoteL2PubKey})
    expect(result.ok).to.equal(true)
  })

  it('returns MISSING_SEAL when no seal frame is present', () => {
    const bound = buildBound()
    const frames: ParleyResponseFrame[] = [
      {content: 'hello', kind: 'agent_message_chunk', seq: 1},
    ]
    const result = auditParleySeal({bound, frames, remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('MISSING_SEAL')
  })

  it('returns TRAILING_FRAMES_AFTER_SEAL when bytes are appended after a valid seal (kimi round-1 MED)', () => {
    const bound = buildBound()
    const frames = buildSignedTranscript(validPreSeal, bound)
    // Attacker appends a garbage frame AFTER the signed seal.
    const tampered: ParleyResponseFrame[] = [
      ...frames,
      {content: 'EVIL', kind: 'agent_message_chunk', seq: 99},
    ]
    const result = auditParleySeal({bound, frames: tampered, remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('TRAILING_FRAMES_AFTER_SEAL')
  })

  it('returns TRAILING_FRAMES_AFTER_SEAL when two seals appear and the FIRST one is valid (rejects the structure entirely)', () => {
    const bound = buildBound()
    const frames = buildSignedTranscript(validPreSeal, bound)
    // Append a second seal (with arbitrary content) — even if the
    // first seal is valid, the structure is rejected.
    const twoSeals: ParleyResponseFrame[] = [
      ...frames,
      {
        kind: 'transcript_seal',
        seq: 99,
        signature: 'AA'.repeat(43) + '=',
        transcript_digest: 'f'.repeat(64),
      },
    ]
    const result = auditParleySeal({bound, frames: twoSeals, remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('TRAILING_FRAMES_AFTER_SEAL')
  })

  it('returns STRUCTURE_INVALID when pre-seal has no terminal frame (truncated transcript)', () => {
    const bound = buildBound()
    // Only a chunk, no stream_end / error before the seal.
    const preSeal: ParleyResponseFrame[] = [
      {content: 'hello', kind: 'agent_message_chunk', seq: 1},
    ]
    const frames = buildSignedTranscript(preSeal, bound)
    const result = auditParleySeal({bound, frames, remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('STRUCTURE_INVALID')
  })

  it('returns STRUCTURE_INVALID on heartbeat-only pre-seal', () => {
    const bound = buildBound()
    const preSeal: ParleyResponseFrame[] = [
      {kind: 'heartbeat_ping', seq: 1},
    ]
    const frames = buildSignedTranscript(preSeal, bound)
    const result = auditParleySeal({bound, frames, remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('STRUCTURE_INVALID')
  })

  it('returns MISSING_SEAL when frames is empty', () => {
    const bound = buildBound()
    const result = auditParleySeal({bound, frames: [], remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('MISSING_SEAL')
  })

  it('accepts heartbeats interleaved before a terminal frame (heartbeats skipped in digest, structure check uses last NON-heartbeat)', () => {
    const bound = buildBound()
    const preSeal: ParleyResponseFrame[] = [
      {content: 'hello', kind: 'agent_message_chunk', seq: 1},
      {kind: 'heartbeat_ping', seq: 2},
      {ended_state: 'completed', kind: 'stream_end', seq: 3, signature: 'AA'.repeat(32) + '=='},
      {kind: 'heartbeat_ping', seq: 4},
    ]
    const frames = buildSignedTranscript(preSeal, bound)
    const result = auditParleySeal({bound, frames, remoteL2PubKey})
    expect(result.ok).to.equal(true)
  })

  it('returns TRANSCRIPT_DIGEST_MISMATCH when a pre-seal frame was tampered after signing', () => {
    const bound = buildBound()
    const frames = buildSignedTranscript(validPreSeal, bound)
    const tampered: ParleyResponseFrame[] = [
      {content: 'TAMPERED', kind: 'agent_message_chunk', seq: 1},
      frames[1],
      frames[2],
    ]
    const result = auditParleySeal({bound, frames: tampered, remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('TRANSCRIPT_DIGEST_MISMATCH')
  })

  it('returns TRANSCRIPT_SEAL_SIG_INVALID when the seal signature does not verify', () => {
    const bound = buildBound()
    const frames = buildSignedTranscript(validPreSeal, bound)
    const otherKey = generateKeyPairSync('ed25519').publicKey
    const result = auditParleySeal({bound, frames, remoteL2PubKey: otherKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('TRANSCRIPT_SEAL_SIG_INVALID')
  })

  it('returns TRANSCRIPT_SEAL_SIG_INVALID when the bound context was tampered', () => {
    const bound = buildBound()
    const frames = buildSignedTranscript(validPreSeal, bound)
    const tamperedBound = {...bound, delivery_id: 'd-other'}
    const result = auditParleySeal({bound: tamperedBound, frames, remoteL2PubKey})
    expect(result.ok).to.equal(false)
    if (!result.ok) expect(result.reason).to.equal('TRANSCRIPT_SEAL_SIG_INVALID')
  })

  it('audits errored seals with FULL signature verification (kimi round-1 LOW — no errored bypass)', () => {
    const bound = buildBound({ended_state: 'errored'})
    const preSeal: ParleyResponseFrame[] = [
      {code: 'BOOM', kind: 'error', message: 'reject', seq: 1, signature: 'AA'.repeat(32) + '=='},
    ]
    // Sign with the correct key — audit accepts.
    const frames = buildSignedTranscript(preSeal, bound)
    const okResult = auditParleySeal({bound, frames, remoteL2PubKey})
    expect(okResult.ok).to.equal(true)

    // Sign with a different key — audit MUST reject (no errored bypass).
    const otherKey = generateKeyPairSync('ed25519').publicKey
    const badResult = auditParleySeal({bound, frames, remoteL2PubKey: otherKey})
    expect(badResult.ok).to.equal(false)
    if (!badResult.ok) expect(badResult.reason).to.equal('TRANSCRIPT_SEAL_SIG_INVALID')
  })
})
