import {keys} from '@libp2p/crypto'
import {peerIdFromPublicKey, peerIdFromString} from '@libp2p/peer-id'
import {type KeyObject} from 'node:crypto'

/**
 * Phase 9 / AMENDMENT_TOFU §A3.2 — libp2p PeerID derivation.
 *
 * The ONLY normative derivation is `@libp2p/peer-id`'s `peerIdFromPublicKey`
 * call. This module is a thin wrapper that:
 *
 *   1. Converts a Node `KeyObject` (Ed25519 public) into a libp2p
 *      public-key object and runs the peer-id derivation.
 *   2. Same for a raw 32-byte Ed25519 pubkey Uint8Array.
 *   3. Validates a string-form peer_id (round-trip through libp2p's
 *      `peerIdFromString` + Ed25519 multihash shape check).
 *
 * Internal multihash / protobuf framing is libp2p's concern — we do
 * not duplicate that logic here. If libp2p ever changes its
 * derivation, our fixed-vector tests against `@libp2p/peer-id`
 * directly will break and surface the divergence immediately.
 */

const ED25519_RAW_PUBKEY_LENGTH = 32

/**
 * Derive a peer_id string from a Node Ed25519 public key.
 * Throws if the KeyObject is not an Ed25519 key.
 */
export function derivePeerIdFromPublicKey(publicKey: KeyObject): string {
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(
      `peer-id derivation requires an Ed25519 key; got ${publicKey.asymmetricKeyType ?? 'unknown'}`,
    )
  }

  const jwk = publicKey.export({format: 'jwk'})
  const {x} = (jwk as Record<string, unknown>)
  if (typeof x !== 'string') {
    throw new TypeError('Ed25519 KeyObject JWK is missing the `x` (raw pubkey) field')
  }

  const raw = new Uint8Array(Buffer.from(x, 'base64url'))
  return derivePeerIdFromRawPublicKey(raw)
}

/**
 * Derive a peer_id string from a raw 32-byte Ed25519 public key.
 * Throws if the input is not exactly 32 bytes.
 */
export function derivePeerIdFromRawPublicKey(raw: Uint8Array): string {
  if (raw.length !== ED25519_RAW_PUBKEY_LENGTH) {
    throw new RangeError(
      `Ed25519 public key MUST be exactly ${ED25519_RAW_PUBKEY_LENGTH} bytes; got ${raw.length}`,
    )
  }

  const libp2pPub = keys.publicKeyFromRaw(raw)
  if (libp2pPub.type !== 'Ed25519') {
    // Defensive — publicKeyFromRaw on raw 32 bytes always picks Ed25519,
    // but a future libp2p version may change the heuristic.
    throw new TypeError(
      `libp2p decoded raw bytes as ${libp2pPub.type}, expected Ed25519`,
    )
  }

  return peerIdFromPublicKey(libp2pPub).toString()
}

/**
 * Validate that a string is a well-formed Ed25519 peer_id.
 *
 * Total: returns `false` for any malformed input (length, charset,
 * decode failure, wrong key type). Never throws.
 *
 * Used by the AMENDMENT_TOFU §A3.2 verifier guard:
 *   subject_id MUST equal derivePeerId(public_key)
 * — combined with a separate equality check between the recomputed
 * peer_id and the cert's `subject_id`, this catches forged cert
 * payloads claiming an arbitrary peer_id.
 */
export function isValidPeerIdString(s: string): boolean {
  // Cheap rejects before any decoding.
  if (typeof s !== 'string' || s.length === 0) return false

  // Ed25519 PeerIDs in identity-multihash form are exactly 52 base58btc
  // characters and start with "12D3KooW" (the fixed multihash prefix
  // `00 24 08 01 12 20` in base58btc). Both checks are cheap and
  // independently sufficient to reject most non-Ed25519 strings.
  if (s.length !== 52) return false
  if (!s.startsWith('12D3KooW')) return false
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false

  // Final authoritative check: ask libp2p to decode it.
  try {
    const pid = peerIdFromString(s)
    return pid.type === 'Ed25519'
  } catch {
    return false
  }
}
