/* eslint-disable camelcase */
// Parley envelope/frame field names mirror IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE
// §5.1 + §5.2 on-wire JSON shape and are intentionally snake_case.

import {expect} from 'chai'
import {createHash, generateKeyPairSync} from 'node:crypto'

import {canonicalize} from '../../../../../../src/agent/core/trust/canonical.js'
import {
  DOMAIN_TAGS,
  signPermissionResponseIntent,
  signResponseError,
  signResponseTerminal,
  signTranscriptSeal,
  verifyPermissionResponseIntent,
  verifyResponseError,
  verifyResponseTerminal,
  verifyTranscriptSeal,
} from '../../../../../../src/agent/core/trust/sign.js'
import {
  ParleyHandshakeSchema,
  ParleyQueryEnvelopeSchema,
  ParleyResponseFrameSchema,
  requestEnvelopeHash,
  transcriptDigest,
} from '../../../../../../src/server/core/domain/channel/parley-types.js'

const buildEnvelope = () => ({
  channel_id: 'review-2026',
  delivery_id: 'd-001',
  disclosure_intent: 'query' as const,
  handshake: {
    install_cert: {
      cert_kind: 'install' as const,
      expires_at: '2027-05-19T00:00:00.000Z',
      issued_at: '2026-05-19T00:00:00.000Z',
      public_key: {alg: 'ed25519' as const, key: 'AA'.repeat(22)},
      signature: 'A'.repeat(86) + '==',
      subject_id: '12D3KooWFakeSubject1111111111111111111111111111',
      version: 1 as const,
    },
    nonce: Buffer.alloc(16, 0xab).toString('base64'),
    signature: 'C'.repeat(86) + '==',
    tree_cert: {
      cert_kind: 'peer-tree' as const,
      expires_at: '2027-05-19T00:00:00.000Z',
      issued_at: '2026-05-19T00:00:00.000Z',
      parent_install: {
        install_pubkey_fingerprint: 'a'.repeat(64),
        peer_id: '12D3KooWFakeSubject1111111111111111111111111111',
      },
      public_key: {alg: 'ed25519' as const, key: 'BB'.repeat(22)},
      signature: 'B'.repeat(86) + '==',
      subject_id: '0190a2e0-6b9e-7000-8000-000000000000',
      version: 1 as const,
    },
    ts: '2026-05-19T00:30:00.000Z',
    version: 1 as const,
  },
  prompt: [{text: 'hello bob', type: 'text' as const}],
  protocol: 'query' as const,
  request_auth: {
    body_hash: 'a'.repeat(64),
    requester_cert: {
      cert_kind: 'peer-tree' as const,
      expires_at: '2027-05-19T00:00:00.000Z',
      issued_at: '2026-05-19T00:00:00.000Z',
      parent_install: {
        install_pubkey_fingerprint: 'a'.repeat(64),
        peer_id: '12D3KooWFakeSubject1111111111111111111111111111',
      },
      public_key: {alg: 'ed25519' as const, key: 'BB'.repeat(22)},
      signature: 'B'.repeat(86) + '==',
      subject_id: '0190a2e0-6b9e-7000-8000-000000000000',
      version: 1 as const,
    },
    signature: 'D'.repeat(86) + '==',
  },
  turn_id: 't-001',
  version: 1 as const,
})

// Phase 9 / Slice 9.3a — wire-shape primitives for Parley.
//
// This file pins:
//   - Domain tags `brv.response.v1`, `brv.response.error.v1`,
//     `brv.response.terminal.v1`, `brv.consent.v1` (PHASE_9 §5.2).
//   - Zod schemas for `ParleyQueryEnvelope`, `ParleyHandshake`,
//     `ParleyResponseFrame` (§5.1, §5.2).
//   - `requestEnvelopeHash(envelope)` — canonical-JCS sha256 of the
//     envelope minus response-side fields (§5.2).
//   - `transcriptDigest(frames)` — domain-tagged sha256 over the
//     canonical concat of non-heartbeat frames in seq order (§5.2).

describe('Parley wire-shape primitives (Slice 9.3a)', () => {
  describe('domain tags (PHASE_9 §5.2)', () => {
    it('exposes the four new response/consent tags with the canonical `brv.<kind>.v1\\n` shape', () => {
      expect(DOMAIN_TAGS['response.frame-digest']).to.equal('brv.response.v1\n')
      expect(DOMAIN_TAGS['response.error']).to.equal('brv.response.error.v1\n')
      expect(DOMAIN_TAGS['response.terminal']).to.equal('brv.response.terminal.v1\n')
      expect(DOMAIN_TAGS.consent).to.equal('brv.consent.v1\n')
    })

    it('every tag still ends with `\\n` (boundary char below 0x20)', () => {
      for (const tag of Object.values(DOMAIN_TAGS)) {
        expect(tag.endsWith('\n')).to.equal(true)
      }
    })
  })

  describe('ParleyHandshakeSchema (§5.1)', () => {
    const validInstallCert = {
      cert_kind: 'install' as const,
      expires_at: '2027-05-19T00:00:00.000Z',
      issued_at: '2026-05-19T00:00:00.000Z',
      public_key: {alg: 'ed25519' as const, key: 'AA'.repeat(22) + '='.repeat(0)},
      signature: 'A'.repeat(86) + '==',
      subject_id: '12D3KooWFakeSubject1111111111111111111111111111',
      version: 1 as const,
    }

    const validPeerTreeCert = {
      cert_kind: 'peer-tree' as const,
      expires_at: '2027-05-19T00:00:00.000Z',
      issued_at: '2026-05-19T00:00:00.000Z',
      parent_install: {
        install_pubkey_fingerprint: 'a'.repeat(64),
        peer_id: '12D3KooWFakeSubject1111111111111111111111111111',
      },
      public_key: {alg: 'ed25519' as const, key: 'BB'.repeat(22)},
      signature: 'B'.repeat(86) + '==',
      subject_id: '0190a2e0-6b9e-7000-8000-000000000000',
      version: 1 as const,
    }

    const validHandshake = {
      install_cert: validInstallCert,
      nonce: Buffer.alloc(16, 0xab).toString('base64'),
      signature: 'C'.repeat(86) + '==',
      tree_cert: validPeerTreeCert,
      ts: '2026-05-19T00:30:00.000Z',
      version: 1 as const,
    }

    it('accepts a structurally valid handshake', () => {
      const r = ParleyHandshakeSchema.safeParse(validHandshake)
      expect(r.success, JSON.stringify(r)).to.equal(true)
    })

    it('rejects when version is not 1', () => {
      expect(ParleyHandshakeSchema.safeParse({...validHandshake, version: 2}).success).to.equal(false)
    })

    it('rejects when signature is not base64', () => {
      expect(ParleyHandshakeSchema.safeParse({...validHandshake, signature: 'not_base64!'}).success).to.equal(false)
    })

    it('rejects when nonce is missing', () => {
      const rest = {...validHandshake} as Record<string, unknown>
      delete rest.nonce
      expect(ParleyHandshakeSchema.safeParse(rest).success).to.equal(false)
    })

    it('rejects when tree_cert.cert_kind is unknown', () => {
      const bad = {...validHandshake, tree_cert: {...validPeerTreeCert, cert_kind: 'phony-cert'}}
      expect(ParleyHandshakeSchema.safeParse(bad).success).to.equal(false)
    })
  })

  describe('ParleyQueryEnvelopeSchema (§5.1)', () => {
    it('accepts a structurally valid query envelope', () => {
      const r = ParleyQueryEnvelopeSchema.safeParse(buildEnvelope())
      expect(r.success, JSON.stringify(r)).to.equal(true)
    })

    it('rejects unknown extra fields at the envelope root', () => {
      const bad = {...buildEnvelope(), evil_field: 'sneaky'}
      expect(ParleyQueryEnvelopeSchema.safeParse(bad).success).to.equal(false)
    })

    it('rejects when protocol is neither "query" nor "delegate"', () => {
      const bad = {...buildEnvelope(), protocol: 'broadcast'}
      expect(ParleyQueryEnvelopeSchema.safeParse(bad).success).to.equal(false)
    })

    it('accepts an optional suppress_thoughts flag', () => {
      const e = {...buildEnvelope(), suppress_thoughts: true}
      const r = ParleyQueryEnvelopeSchema.safeParse(e)
      expect(r.success).to.equal(true)
    })
  })

  describe('ParleyResponseFrameSchema (§5.2)', () => {
    it('accepts an agent_message_chunk', () => {
      const r = ParleyResponseFrameSchema.safeParse({content: 'hello', kind: 'agent_message_chunk', seq: 1})
      expect(r.success).to.equal(true)
    })

    it('accepts a signed stream_end (completed) terminal frame', () => {
      const r = ParleyResponseFrameSchema.safeParse({
        ended_state: 'completed',
        kind: 'stream_end',
        seq: 5,
        signature: 'E'.repeat(86) + '==',
      })
      expect(r.success).to.equal(true)
    })

    it('accepts a signed error terminal frame', () => {
      const r = ParleyResponseFrameSchema.safeParse({
        code: 'INTERNAL',
        kind: 'error',
        message: 'something broke',
        seq: 5,
        signature: 'F'.repeat(86) + '==',
      })
      expect(r.success).to.equal(true)
    })

    it('accepts a transcript_seal frame', () => {
      const r = ParleyResponseFrameSchema.safeParse({
        kind: 'transcript_seal',
        seq: 6,
        signature: 'G'.repeat(86) + '==',
        transcript_digest: 'a'.repeat(64),
      })
      expect(r.success).to.equal(true)
    })

    it('rejects a stream_end without signature', () => {
      const r = ParleyResponseFrameSchema.safeParse({
        ended_state: 'completed',
        kind: 'stream_end',
        seq: 5,
      })
      expect(r.success).to.equal(false)
    })

    it('rejects an unknown kind', () => {
      const r = ParleyResponseFrameSchema.safeParse({kind: 'phony', seq: 1})
      expect(r.success).to.equal(false)
    })

    it('rejects a stream_end with an unexpected ended_state', () => {
      const r = ParleyResponseFrameSchema.safeParse({
        ended_state: 'mystery',
        kind: 'stream_end',
        seq: 5,
        signature: 'E'.repeat(86) + '==',
      })
      expect(r.success).to.equal(false)
    })
  })

  describe('requestEnvelopeHash(envelope) — §5.2', () => {
    const stableEnvelope = {
      channel_id: 'review-2026',
      delivery_id: 'd-001',
      disclosure_intent: 'query' as const,
      handshake: {fakeFieldsForTest: true, signature: 'aaa'},
      prompt: [{text: 'hi', type: 'text'}],
      protocol: 'query' as const,
      request_auth: {fakeFieldsForTest: true, signature: 'bbb'},
      turn_id: 't-001',
      version: 1 as const,
    }

    it('is stable across logically-equal envelopes (key reordering)', () => {
      /* eslint-disable perfectionist/sort-objects */
      // INTENTIONALLY out of alphabetical order — this fixture proves
      // canonical-form invariance against key reordering.
      const reordered = {
        version: 1 as const,
        turn_id: 't-001',
        request_auth: {signature: 'bbb', fakeFieldsForTest: true},
        protocol: 'query' as const,
        prompt: [{type: 'text', text: 'hi'}],
        handshake: {signature: 'aaa', fakeFieldsForTest: true},
        disclosure_intent: 'query' as const,
        delivery_id: 'd-001',
        channel_id: 'review-2026',
      }
      /* eslint-enable perfectionist/sort-objects */
      expect(requestEnvelopeHash(stableEnvelope)).to.equal(requestEnvelopeHash(reordered))
    })

    it('changes when channel_id changes', () => {
      const a = requestEnvelopeHash(stableEnvelope)
      const b = requestEnvelopeHash({...stableEnvelope, channel_id: 'review-2027'})
      expect(a).not.to.equal(b)
    })

    it('changes when handshake.signature changes (the signature IS part of the request hash)', () => {
      const a = requestEnvelopeHash(stableEnvelope)
      const b = requestEnvelopeHash({...stableEnvelope, handshake: {...stableEnvelope.handshake, signature: 'zzz'}})
      expect(a).not.to.equal(b)
    })

    it('returns a 64-char hex string (sha256)', () => {
      expect(requestEnvelopeHash(stableEnvelope)).to.match(/^[\da-f]{64}$/)
    })
  })

  describe('transcriptDigest(frames) — §5.2', () => {
    const frame1 = {content: 'hi', kind: 'agent_message_chunk' as const, seq: 1}
    const terminal = {
      ended_state: 'completed' as const,
      kind: 'stream_end' as const,
      seq: 2,
      signature: 'E'.repeat(86) + '==',
    }
    const heartbeat = {kind: 'heartbeat_ping' as const, seq: 100}

    it('is stable for the same frame sequence', () => {
      const a = transcriptDigest([frame1, terminal])
      const b = transcriptDigest([frame1, terminal])
      expect(a).to.equal(b)
    })

    it('changes when any frame field changes', () => {
      const a = transcriptDigest([frame1, terminal])
      const b = transcriptDigest([{...frame1, content: 'goodbye'}, terminal])
      expect(a).not.to.equal(b)
    })

    it('EXCLUDES heartbeat_ping / heartbeat_pong from the digest (§5.2)', () => {
      const withHeartbeat = [frame1, heartbeat, terminal]
      const withoutHeartbeat = [frame1, terminal]
      expect(transcriptDigest(withHeartbeat)).to.equal(transcriptDigest(withoutHeartbeat))
    })

    it('includes the domain-tag prefix `brv.response.v1\\n` so collisions vs other-intent hashes are impossible', () => {
      const expectedTagBytes = Buffer.from('brv.response.v1\n', 'utf8')
      const frameBytes = Buffer.from(canonicalize({content: 'hi', kind: 'agent_message_chunk', seq: 1}), 'utf8')
      const handComputed = createHash('sha256')
        .update(expectedTagBytes)
        .update(frameBytes)
        .digest('hex')
      expect(transcriptDigest([frame1])).to.equal(handComputed)
    })

    it('returns a 64-char hex string', () => {
      expect(transcriptDigest([frame1, terminal])).to.match(/^[\da-f]{64}$/)
    })
  })

  describe('typed-per-intent signing helpers (Slice 9.3a — new tags)', () => {
    const keypair = generateKeyPairSync('ed25519')
    const sealPayload = {
      channel_id: 'review-2026',
      delivery_id: 'd-001',
      ended_state: 'completed',
      protocol: 'query',
      request_envelope_hash: 'a'.repeat(64),
      transcript_digest: 'b'.repeat(64),
      turn_id: 't-001',
    }
    const terminalPayload = {
      channel_id: 'review-2026',
      delivery_id: 'd-001',
      protocol: 'query',
      request_envelope_hash: 'a'.repeat(64),
      seq: 5,
      terminal_payload: {ended_state: 'completed', kind: 'stream_end'},
      turn_id: 't-001',
    }
    const errorPayload = {
      channel_id: 'review-2026',
      delivery_id: 'd-001',
      protocol: 'query',
      request_envelope_hash: 'a'.repeat(64),
      seq: 5,
      terminal_payload: {code: 'INTERNAL', kind: 'error', message: 'boom'},
      turn_id: 't-001',
    }
    const consentPayload = {
      alice_decision: 'allow',
      channel_id: 'review-2026',
      request_id: 'pr-1',
      turn_id: 't-001',
    }

    it('signTranscriptSeal round-trips', () => {
      const sig = signTranscriptSeal(sealPayload, keypair.privateKey)
      expect(verifyTranscriptSeal(sealPayload, sig, keypair.publicKey)).to.equal(true)
    })

    it('signResponseTerminal round-trips', () => {
      const sig = signResponseTerminal(terminalPayload, keypair.privateKey)
      expect(verifyResponseTerminal(terminalPayload, sig, keypair.publicKey)).to.equal(true)
    })

    it('signResponseError round-trips', () => {
      const sig = signResponseError(errorPayload, keypair.privateKey)
      expect(verifyResponseError(errorPayload, sig, keypair.publicKey)).to.equal(true)
    })

    it('signPermissionResponseIntent round-trips', () => {
      const sig = signPermissionResponseIntent(consentPayload, keypair.privateKey)
      expect(verifyPermissionResponseIntent(consentPayload, sig, keypair.publicKey)).to.equal(true)
    })

    it('cross-domain replay: transcript_seal signature does NOT verify as response.terminal', () => {
      const sig = signTranscriptSeal(sealPayload, keypair.privateKey)
      expect(verifyResponseTerminal(sealPayload, sig, keypair.publicKey)).to.equal(false)
    })

    it('cross-domain replay: response.terminal signature does NOT verify as response.error', () => {
      const sig = signResponseTerminal(terminalPayload, keypair.privateKey)
      expect(verifyResponseError(terminalPayload, sig, keypair.publicKey)).to.equal(false)
    })

    it('cross-domain replay: consent signature does NOT verify as parley handshake', async () => {
      const {verifyParleyHandshake} = await import('../../../../../../src/agent/core/trust/sign.js')
      const sig = signPermissionResponseIntent(consentPayload, keypair.privateKey)
      expect(verifyParleyHandshake(consentPayload, sig, keypair.publicKey)).to.equal(false)
    })
  })
})
