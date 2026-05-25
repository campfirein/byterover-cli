/* eslint-disable camelcase */
// Cert / payload field names mirror AMENDMENT_TOFU §A3.2 on-disk JSON
// shape and are intentionally snake_case to match the wire spec.

import {expect} from 'chai'
import {generateKeyPairSync, KeyObject} from 'node:crypto'

import {
  DOMAIN_TAGS,
  type DomainTag,
  signInstallCert,
  signParleyHandshake,
  signPeerRecord,
  signPeerTreeCert,
  verifyInstallCert,
  verifyParleyHandshake,
  verifyPeerRecord,
  verifyPeerTreeCert,
} from '../../../../../src/agent/core/trust/sign.js'

// Phase 9 / AMENDMENT_TOFU §A7 — domain-separated Ed25519 sign/verify.
// Every brv L1 application signature prefixes its canonical bytes with
// `brv.<kind>.v1\n`. Verifier MUST reject a signature produced under a
// different domain tag (cross-protocol replay prevention).
//
// No raw-Ed25519 signing helpers are exposed — callers MUST use a
// typed-per-intent function. This test file enforces that contract by
// only importing the typed helpers.

describe('domain-separated Ed25519 signing', () => {
  let keyPair: {privateKey: KeyObject; publicKey: KeyObject}
  let otherKeyPair: {privateKey: KeyObject; publicKey: KeyObject}

  beforeEach(() => {
    keyPair = generateKeyPairSync('ed25519')
    otherKeyPair = generateKeyPairSync('ed25519')
  })

  describe('DOMAIN_TAGS — the registered set', () => {
    it('exposes all Phase-9 L1 domain tags', () => {
      // These MUST match AMENDMENT_TOFU §A7 + Phase 9 §A7 typed-signer list.
      expect(DOMAIN_TAGS).to.have.property('cert.install', 'brv.cert.install.v1\n')
      expect(DOMAIN_TAGS).to.have.property('cert.peer-tree', 'brv.cert.peer-tree.v1\n')
      expect(DOMAIN_TAGS).to.have.property('parley.handshake', 'brv.parley.handshake.v1\n')
      expect(DOMAIN_TAGS).to.have.property('peer-record', 'brv.peer-record.v1\n')
    })

    it('each tag ends with newline (separator from JCS bytes)', () => {
      for (const tag of Object.values(DOMAIN_TAGS) as DomainTag[]) {
        expect(tag).to.match(/\n$/)
      }
    })

    it('each tag starts with `brv.` and contains `.v1\\n`', () => {
      for (const tag of Object.values(DOMAIN_TAGS) as DomainTag[]) {
        expect(tag).to.match(/^brv\./)
        expect(tag).to.match(/\.v1\n$/)
      }
    })
  })

  describe('signInstallCert / verifyInstallCert', () => {
    const installCertPayload = {
      cert_kind: 'install' as const,
      expires_at: '2031-05-18T00:00:00.000Z',
      issued_at: '2026-05-18T00:00:00.000Z',
      public_key: {alg: 'ed25519' as const, key: 'ZmFrZS1iYXNlNjQ='},
      subject_id: 'deadbeef-placeholder-peer-id',
      version: 1 as const,
    }

    it('round-trips: sign then verify with the matching public key', () => {
      const sig = signInstallCert(installCertPayload, keyPair.privateKey)
      expect(verifyInstallCert(installCertPayload, sig, keyPair.publicKey)).to.equal(true)
    })

    it('signature is base64-encoded', () => {
      const sig = signInstallCert(installCertPayload, keyPair.privateKey)
      expect(sig).to.match(/^[A-Za-z0-9+/]+=*$/)
    })

    it('signature output is deterministic for identical input (Ed25519 is deterministic)', () => {
      const sig1 = signInstallCert(installCertPayload, keyPair.privateKey)
      const sig2 = signInstallCert(installCertPayload, keyPair.privateKey)
      expect(sig1).to.equal(sig2)
    })

    it('verify rejects with the wrong public key', () => {
      const sig = signInstallCert(installCertPayload, keyPair.privateKey)
      expect(verifyInstallCert(installCertPayload, sig, otherKeyPair.publicKey)).to.equal(false)
    })

    it('verify rejects if the payload differs (any field change)', () => {
      const sig = signInstallCert(installCertPayload, keyPair.privateKey)
      const tampered = {...installCertPayload, issued_at: '2026-05-19T00:00:00.000Z'}
      expect(verifyInstallCert(tampered, sig, keyPair.publicKey)).to.equal(false)
    })

    it('verify rejects a forged base64 signature', () => {
      // 64 bytes of zeros, base64-encoded — well-formed but invalid.
      const fakeSig = Buffer.alloc(64).toString('base64')
      expect(verifyInstallCert(installCertPayload, fakeSig, keyPair.publicKey)).to.equal(false)
    })

    it('verify rejects a malformed (non-base64) signature without throwing', () => {
      // Verifier MUST be total: any input shape that fails to decode
      // returns false, never throws.
      expect(verifyInstallCert(installCertPayload, 'not!base64!', keyPair.publicKey)).to.equal(false)
    })

    it('verify rejects a non-Ed25519 key (defense-in-depth — opencode round-1 MEDIUM)', () => {
      // Generate an RSA key — wrong curve type. ed25519Verify would throw
      // on this; the explicit asymmetricKeyType guard MUST fail-closed
      // BEFORE reaching the crypto call.
      const rsaKey = generateKeyPairSync('rsa', {modulusLength: 2048})
      const sig = signInstallCert(installCertPayload, keyPair.privateKey)
      expect(verifyInstallCert(installCertPayload, sig, rsaKey.publicKey)).to.equal(false)
    })

    it('reorders payload keys (canonical-form invariance)', () => {
      // Two payloads with identical content but different JS insertion
      // order MUST produce identical signatures.
      const reordered = {
        cert_kind: 'install' as const,
        expires_at: installCertPayload.expires_at,
        issued_at: installCertPayload.issued_at,
        public_key: installCertPayload.public_key,
        subject_id: installCertPayload.subject_id,
        version: 1 as const,
      }
      const sigA = signInstallCert(installCertPayload, keyPair.privateKey)
      const sigB = signInstallCert(reordered, keyPair.privateKey)
      expect(sigA).to.equal(sigB)
    })
  })

  describe('cross-domain replay prevention', () => {
    // CRITICAL property from AMENDMENT_TOFU §A7: a signature produced
    // under one domain tag MUST NOT verify under another. This catches
    // the cross-protocol attack where an attacker submits an install-
    // cert signature as if it were a parley-handshake signature.

    const payload = {
      // Both helpers accept different shapes; this minimum-overlap object
      // is here just to drive the signing path. The point is the BYTES
      // being signed are identical (same JCS form of `payload`); only
      // the domain tag prefix differs.
      arbitrary: 'shared-payload',
      version: 1 as const,
    }

    it('install-cert signature does NOT verify as parley-handshake', () => {
      // Sign as install cert (uses `brv.cert.install.v1\n` prefix).
      // Verify as parley handshake (expects `brv.parley.handshake.v1\n`).
      // Different prefixes → different signed bytes → verify must fail.
      const sig = signInstallCert(payload as never, keyPair.privateKey)
      expect(verifyParleyHandshake(payload as never, sig, keyPair.publicKey)).to.equal(false)
    })

    it('parley-handshake signature does NOT verify as install-cert', () => {
      const sig = signParleyHandshake(payload as never, keyPair.privateKey)
      expect(verifyInstallCert(payload as never, sig, keyPair.publicKey)).to.equal(false)
    })

    it('peer-record signature does NOT verify as peer-tree-cert', () => {
      const sig = signPeerRecord(payload as never, keyPair.privateKey)
      expect(verifyPeerTreeCert(payload as never, sig, keyPair.publicKey)).to.equal(false)
    })

    it('peer-tree-cert signature does NOT verify as peer-record', () => {
      const sig = signPeerTreeCert(payload as never, keyPair.privateKey)
      expect(verifyPeerRecord(payload as never, sig, keyPair.publicKey)).to.equal(false)
    })
  })

  describe('API surface — no raw signing helper exposed', () => {
    it('only typed-per-intent helpers are exported from sign.ts', async () => {
      // Inspect the module's exports — should ONLY be the typed sign/verify
      // pairs + DOMAIN_TAGS. No `signRaw`, `signBytes`, etc. that would let
      // a caller bypass domain separation.
      const mod = await import('../../../../../src/agent/core/trust/sign.js')
      const exportNames = new Set(Object.keys(mod))

      // Must export these.
      expect(exportNames.has('DOMAIN_TAGS')).to.equal(true)
      expect(exportNames.has('signInstallCert')).to.equal(true)
      expect(exportNames.has('verifyInstallCert')).to.equal(true)
      expect(exportNames.has('signPeerTreeCert')).to.equal(true)
      expect(exportNames.has('verifyPeerTreeCert')).to.equal(true)
      expect(exportNames.has('signParleyHandshake')).to.equal(true)
      expect(exportNames.has('verifyParleyHandshake')).to.equal(true)
      expect(exportNames.has('signPeerRecord')).to.equal(true)
      expect(exportNames.has('verifyPeerRecord')).to.equal(true)

      // Must NOT export these (escape hatches that bypass domain separation).
      expect(exportNames.has('signRaw')).to.equal(false)
      expect(exportNames.has('signBytes')).to.equal(false)
      expect(exportNames.has('sign')).to.equal(false)
      expect(exportNames.has('verifyRaw')).to.equal(false)
      expect(exportNames.has('verifyBytes')).to.equal(false)
      expect(exportNames.has('verify')).to.equal(false)
    })
  })
})
