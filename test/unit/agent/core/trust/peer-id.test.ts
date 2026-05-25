import {expect} from 'chai'
import {generateKeyPairSync} from 'node:crypto'

import {
  derivePeerIdFromPublicKey,
  derivePeerIdFromRawPublicKey,
  isValidPeerIdString,
} from '../../../../../src/agent/core/trust/peer-id.js'

// Phase 9 / AMENDMENT_TOFU §A3.2 — libp2p PeerID derivation.
//
// The only normative derivation is `@libp2p/peer-id`'s `peerIdFromPublicKey`
// call. peer-id.ts is a thin wrapper that:
//   1. Accepts a Node `KeyObject` (Ed25519 public) and returns the
//      libp2p PeerID string (base58btc multihash, 52 chars for Ed25519).
//   2. Accepts a raw 32-byte Ed25519 pubkey Uint8Array → PeerID string.
//   3. Validates a PeerID string for shape + Ed25519 identity-multihash.

describe('peer-id (libp2p PeerID derivation)', () => {
  describe('derivePeerIdFromPublicKey', () => {
    it('produces a 52-char base58btc string for Ed25519 keys', () => {
      const {publicKey} = generateKeyPairSync('ed25519')
      const peerId = derivePeerIdFromPublicKey(publicKey)
      expect(peerId).to.have.lengthOf(52)
      // base58btc alphabet — no 0, O, I, l
      expect(peerId).to.match(/^[1-9A-HJ-NP-Za-km-z]+$/)
      // Ed25519 libp2p PeerIDs start with "12D3KooW" (multihash identity
      // prefix for Ed25519: `00 24 08 01 12 20 ...`).
      expect(peerId).to.match(/^12D3KooW/)
    })

    it('is deterministic — same key → same peer_id', () => {
      const {publicKey} = generateKeyPairSync('ed25519')
      const a = derivePeerIdFromPublicKey(publicKey)
      const b = derivePeerIdFromPublicKey(publicKey)
      expect(a).to.equal(b)
    })

    it('different keys produce different peer_ids', () => {
      const a = derivePeerIdFromPublicKey(generateKeyPairSync('ed25519').publicKey)
      const b = derivePeerIdFromPublicKey(generateKeyPairSync('ed25519').publicKey)
      expect(a).to.not.equal(b)
    })

    it('rejects non-Ed25519 public keys', () => {
      // PeerID derivation in v1 only supports Ed25519 (per AMENDMENT_TOFU §A7
      // L1 key requirement). RSA, P-256, X25519 etc. are out of scope.
      const {publicKey: rsaKey} = generateKeyPairSync('rsa', {modulusLength: 2048})
      expect(() => derivePeerIdFromPublicKey(rsaKey)).to.throw(/Ed25519/)
    })
  })

  describe('derivePeerIdFromRawPublicKey', () => {
    it('produces a 52-char base58btc string for valid 32-byte Ed25519 raw pubkey', () => {
      const {publicKey} = generateKeyPairSync('ed25519')
      const jwk = publicKey.export({format: 'jwk'})
      const raw = new Uint8Array(Buffer.from(jwk.x as string, 'base64url'))
      const peerId = derivePeerIdFromRawPublicKey(raw)
      expect(peerId).to.have.lengthOf(52)
      expect(peerId).to.match(/^12D3KooW/)
    })

    it('matches derivePeerIdFromPublicKey for the same key', () => {
      const {publicKey} = generateKeyPairSync('ed25519')
      const jwk = publicKey.export({format: 'jwk'})
      const raw = new Uint8Array(Buffer.from(jwk.x as string, 'base64url'))
      expect(derivePeerIdFromRawPublicKey(raw)).to.equal(derivePeerIdFromPublicKey(publicKey))
    })

    it('rejects raw bytes that are not exactly 32 bytes', () => {
      expect(() => derivePeerIdFromRawPublicKey(new Uint8Array(31))).to.throw(/32/)
      expect(() => derivePeerIdFromRawPublicKey(new Uint8Array(33))).to.throw(/32/)
      expect(() => derivePeerIdFromRawPublicKey(new Uint8Array(0))).to.throw(/32/)
    })
  })

  describe('isValidPeerIdString', () => {
    it('accepts a freshly-derived Ed25519 peer_id', () => {
      const {publicKey} = generateKeyPairSync('ed25519')
      const peerId = derivePeerIdFromPublicKey(publicKey)
      expect(isValidPeerIdString(peerId)).to.equal(true)
    })

    it('rejects strings shorter than the Ed25519-PeerID length', () => {
      expect(isValidPeerIdString('12D3KooW')).to.equal(false)
      expect(isValidPeerIdString('')).to.equal(false)
    })

    it('rejects strings that are NOT valid base58btc', () => {
      // `0` and `O` and `I` and `l` are not in base58btc alphabet.
      expect(isValidPeerIdString('0'.repeat(52))).to.equal(false)
      expect(isValidPeerIdString('I'.repeat(52))).to.equal(false)
    })

    it('rejects non-Ed25519 multihash bytes (e.g. CIDv0 dag-pb hash)', () => {
      // A Qm... CID is base58btc 46 chars decoding to a sha256 multihash.
      // Not an Ed25519 PeerID. Must reject.
      expect(isValidPeerIdString('QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG')).to.equal(false)
    })

    it('returns false (never throws) on garbage input', () => {
      // Total verifier: any malformed input returns false.
      expect(isValidPeerIdString('!@#$%')).to.equal(false)
      expect(isValidPeerIdString('hello world')).to.equal(false)
    })
  })

  describe('AMENDMENT_TOFU §A3.2 invariant — subject_id == derivePeerId(public_key)', () => {
    it('a peer_id string round-trips through libp2p’s decoder', () => {
      // The verifier guard in AMENDMENT_TOFU §A3.2 requires recomputing
      // peer_id from the cert’s public_key and matching the cert’s
      // subject_id. This test pins that the derivation is consistent
      // with libp2p’s own peer-id decoding (the inverse op).
      const {publicKey} = generateKeyPairSync('ed25519')
      const peerId = derivePeerIdFromPublicKey(publicKey)
      // Round-trip via the validator: a derived peer_id must always be valid.
      expect(isValidPeerIdString(peerId)).to.equal(true)
    })
  })
})
