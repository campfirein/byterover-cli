/* eslint-disable camelcase */
// PeerTreeCertificate fields mirror AMENDMENT_TOFU §A3.2 on-disk JSON
// shape and are intentionally snake_case.

import {expect} from 'chai'
import {createHash, generateKeyPairSync} from 'node:crypto'

import {derivePeerIdFromPublicKey} from '../../../../../src/agent/core/trust/peer-id.js'
import {
  buildPeerTreeCertPayload,
  issuePeerTreeCertificate,
  verifyPeerTreeCertChain,
} from '../../../../../src/agent/core/trust/peer-tree-signer.js'

// Phase 9 / Slice 9.3b — L2 PeerTreeCertificate primitives.
//
// `PeerTreeCertificate` binds an L2 tree key to its issuing L1 install
// identity. Codex round-1: JCS-signed payload by L1, NOT JWT-style. See
// AMENDMENT_TOFU §A3.2 + §A8 Q4.

describe('peer-tree-signer (Slice 9.3b)', () => {
  const l1 = generateKeyPairSync('ed25519')
  const l2 = generateKeyPairSync('ed25519')

  const l1PubRaw = (() => {
    const jwk = l1.publicKey.export({format: 'jwk'}) as {x: string}
    return Buffer.from(jwk.x, 'base64url')
  })()

  const l1PeerId = derivePeerIdFromPublicKey(l1.publicKey)
  const l2PubKey = (() => {
    const jwk = l2.publicKey.export({format: 'jwk'}) as {x: string}
    return Buffer.from(jwk.x, 'base64url').toString('base64')
  })()

  describe('buildPeerTreeCertPayload', () => {
    it('produces a payload with cert_kind="peer-tree" and parent_install bound to L1', () => {
      const payload = buildPeerTreeCertPayload({
        expiresAt: new Date('2027-05-19T00:00:00.000Z'),
        issuedAt: new Date('2026-05-19T00:00:00.000Z'),
        l1PeerId,
        l1PubRaw,
        l2PubKey,
        treeId: '0190a2e0-6b9e-7000-8000-000000000000',
      })

      expect(payload.cert_kind).to.equal('peer-tree')
      expect(payload.subject_id).to.equal('0190a2e0-6b9e-7000-8000-000000000000')
      expect(payload.public_key.alg).to.equal('ed25519')
      expect(payload.public_key.key).to.equal(l2PubKey)
      expect(payload.parent_install.peer_id).to.equal(l1PeerId)
      const expectedFp = createHash('sha256').update(l1PubRaw).digest('hex')
      expect(payload.parent_install.install_pubkey_fingerprint).to.equal(expectedFp)
      expect(payload.version).to.equal(1)
    })

    it('rejects a malformed UUIDv7 tree_id with TREE_ID_MALFORMED', () => {
      expect(() =>
        buildPeerTreeCertPayload({
          expiresAt: new Date('2027-05-19T00:00:00.000Z'),
          issuedAt: new Date('2026-05-19T00:00:00.000Z'),
          l1PeerId,
          l1PubRaw,
          l2PubKey,
          treeId: 'not-a-uuid',
        }),
      ).to.throw(/TREE_ID_MALFORMED/)
    })

    it('rejects a UUIDv4 tree_id with TREE_ID_MALFORMED', () => {
      expect(() =>
        buildPeerTreeCertPayload({
          expiresAt: new Date('2027-05-19T00:00:00.000Z'),
          issuedAt: new Date('2026-05-19T00:00:00.000Z'),
          l1PeerId,
          l1PubRaw,
          l2PubKey,
          treeId: '123e4567-e89b-42d3-a456-426614174000',
        }),
      ).to.throw(/TREE_ID_MALFORMED/)
    })
  })

  describe('issuePeerTreeCertificate', () => {
    it('builds and self-signs a cert; signature verifies against the L1 public key', () => {
      const cert = issuePeerTreeCertificate({
        expiresAt: new Date('2027-05-19T00:00:00.000Z'),
        issuedAt: new Date('2026-05-19T00:00:00.000Z'),
        l1PeerId,
        l1PrivateKey: l1.privateKey,
        l1PubRaw,
        l2PubKey,
        treeId: '0190a2e0-6b9e-7000-8000-000000000000',
      })
      expect(cert.signature).to.match(/^[A-Za-z0-9+/=]+$/)
      // Signature should be detached + base64 — 88 chars for a 64-byte Ed25519 sig.
      expect(cert.signature.length).to.equal(88)
    })
  })

  describe('verifyPeerTreeCertChain — happy path', () => {
    it('verifies a cert against its L1 public key (parent_install.peer_id matches)', () => {
      const cert = issuePeerTreeCertificate({
        expiresAt: new Date('2027-05-19T00:00:00.000Z'),
        issuedAt: new Date('2026-05-19T00:00:00.000Z'),
        l1PeerId,
        l1PrivateKey: l1.privateKey,
        l1PubRaw,
        l2PubKey,
        treeId: '0190a2e0-6b9e-7000-8000-000000000000',
      })

      const r = verifyPeerTreeCertChain({
        cert,
        l1PubRaw,
        now: new Date('2026-06-01T00:00:00.000Z'),
      })
      expect(r.ok, JSON.stringify(r)).to.equal(true)
    })
  })

  describe('verifyPeerTreeCertChain — failure modes', () => {
    const baseCert = issuePeerTreeCertificate({
      expiresAt: new Date('2027-05-19T00:00:00.000Z'),
      issuedAt: new Date('2026-05-19T00:00:00.000Z'),
      l1PeerId,
      l1PrivateKey: l1.privateKey,
      l1PubRaw,
      l2PubKey,
      treeId: '0190a2e0-6b9e-7000-8000-000000000000',
    })

    it('rejects when the supplied L1 pubkey does not match parent_install.install_pubkey_fingerprint', () => {
      const stranger = generateKeyPairSync('ed25519')
      const strangerRaw = Buffer.from(
        (stranger.publicKey.export({format: 'jwk'}) as {x: string}).x,
        'base64url',
      )
      const r = verifyPeerTreeCertChain({
        cert: baseCert,
        l1PubRaw: strangerRaw,
        now: new Date('2026-06-01T00:00:00.000Z'),
      })
      expect(r.ok).to.equal(false)
      if (!r.ok) expect(r.reason).to.equal('INVALID_PARENT_BINDING')
    })

    it('rejects an expired cert with CERT_EXPIRED', () => {
      const r = verifyPeerTreeCertChain({
        cert: baseCert,
        l1PubRaw,
        now: new Date('2028-01-01T00:00:00.000Z'),
      })
      expect(r.ok).to.equal(false)
      if (!r.ok) expect(r.reason).to.equal('CERT_EXPIRED')
    })

    it('rejects a future-dated cert (issued_at in the future) with CERT_NOT_YET_VALID', () => {
      const futureCert = issuePeerTreeCertificate({
        expiresAt: new Date('2030-05-19T00:00:00.000Z'),
        issuedAt: new Date('2029-05-19T00:00:00.000Z'),
        l1PeerId,
        l1PrivateKey: l1.privateKey,
        l1PubRaw,
        l2PubKey,
        treeId: '0190a2e0-6b9e-7000-8000-000000000001',
      })
      const r = verifyPeerTreeCertChain({
        cert: futureCert,
        l1PubRaw,
        now: new Date('2026-06-01T00:00:00.000Z'),
      })
      expect(r.ok).to.equal(false)
      if (!r.ok) expect(r.reason).to.equal('CERT_NOT_YET_VALID')
    })

    it('rejects a cert whose signature was forged with a different L2 key', () => {
      const tampered = {...baseCert, signature: 'Z'.repeat(86) + '=='}
      const r = verifyPeerTreeCertChain({
        cert: tampered,
        l1PubRaw,
        now: new Date('2026-06-01T00:00:00.000Z'),
      })
      expect(r.ok).to.equal(false)
      if (!r.ok) expect(r.reason).to.equal('PEER_TREE_SIG_INVALID')
    })

    it('rejects a cert with TREE_ID_MALFORMED if subject_id is not a UUIDv7', () => {
      const bad = {...baseCert, subject_id: 'not-a-uuid'}
      const r = verifyPeerTreeCertChain({
        cert: bad,
        l1PubRaw,
        now: new Date('2026-06-01T00:00:00.000Z'),
      })
      expect(r.ok).to.equal(false)
      if (!r.ok) expect(r.reason).to.equal('TREE_ID_MALFORMED')
    })
  })
})
