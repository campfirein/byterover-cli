/* eslint-disable camelcase */
// PeerTreeCertificate fields mirror AMENDMENT_TOFU §A3.2 on-disk JSON
// shape and are intentionally snake_case.

import {createHash, createPublicKey, KeyObject} from 'node:crypto'

import {signPeerTreeCert, verifyPeerTreeCert} from './sign.js'
import {isValidUuidV7} from './tree-id.js'

/**
 * Phase 9 / Slice 9.3b — `PeerTreeCertificate` (L2 peer-mode tree cert).
 *
 * Binds an L2 tree key to its issuing L1 install identity via a
 * signature by the L1 install key over the canonical-JCS bytes of the
 * cert payload (everything except `signature`). See AMENDMENT_TOFU
 * §A3.2 + §A8 Q4.
 *
 * Public API:
 *   - `buildPeerTreeCertPayload(args)` — assemble the cert minus
 *     signature. Validates `tree_id` is a well-formed UUIDv7.
 *   - `issuePeerTreeCertificate(args)` — build + sign with L1 key.
 *   - `verifyPeerTreeCertChain({cert, l1PubRaw, now})` — verify the
 *     cert chain per AMENDMENT_TOFU §A3.2 (parent install pubkey
 *     fingerprint match → L2 signature verify → time checks →
 *     tree_id well-formedness).
 *
 * NOT YET wired here: full polymorphic `verifyCertChain` (per
 * AMENDMENT_TOFU). That arrives in a later slice; 9.3 only needs the
 * peer-tree branch.
 */

export interface PeerTreeCertificate {
  readonly cert_kind: 'peer-tree'
  readonly expires_at: string
  readonly issued_at: string
  readonly parent_install: {
    readonly install_pubkey_fingerprint: string
    readonly peer_id: string
  }
  readonly public_key: {readonly alg: 'ed25519'; readonly key: string}
  readonly signature: string
  readonly subject_id: string
  readonly version: 1
}

export type PeerTreeCertPayload = Omit<PeerTreeCertificate, 'signature'>

export interface BuildPeerTreeCertArgs {
  readonly expiresAt: Date
  readonly issuedAt: Date
  readonly l1PeerId: string
  readonly l1PubRaw: Uint8Array
  readonly l2PubKey: string
  readonly treeId: string
}

export function buildPeerTreeCertPayload(args: BuildPeerTreeCertArgs): PeerTreeCertPayload {
  if (!isValidUuidV7(args.treeId)) {
    throw new Error(`TREE_ID_MALFORMED: tree_id ${args.treeId} is not a valid UUIDv7`)
  }

  const install_pubkey_fingerprint = createHash('sha256').update(args.l1PubRaw).digest('hex')
  return {
    cert_kind: 'peer-tree',
    expires_at: args.expiresAt.toISOString(),
    issued_at: args.issuedAt.toISOString(),
    parent_install: {
      install_pubkey_fingerprint,
      peer_id: args.l1PeerId,
    },
    public_key: {alg: 'ed25519', key: args.l2PubKey},
    subject_id: args.treeId,
    version: 1,
  }
}

export interface IssuePeerTreeCertArgs extends BuildPeerTreeCertArgs {
  readonly l1PrivateKey: KeyObject
}

export function issuePeerTreeCertificate(args: IssuePeerTreeCertArgs): PeerTreeCertificate {
  const payload = buildPeerTreeCertPayload(args)
  const signature = signPeerTreeCert(payload, args.l1PrivateKey)
  return {...payload, signature}
}

export interface VerifyPeerTreeCertArgs {
  readonly cert: PeerTreeCertificate
  readonly l1PubRaw: Uint8Array
  readonly now: Date
}

export type VerifyResult =
  | {ok: false; reason: VerifyFailureReason}
  | {ok: true}

export type VerifyFailureReason =
  | 'CERT_EXPIRED'
  | 'CERT_NOT_YET_VALID'
  | 'INVALID_PARENT_BINDING'
  | 'PEER_TREE_SIG_INVALID'
  | 'TREE_ID_MALFORMED'

const CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * Verify a `PeerTreeCertificate` against the supplied L1 raw public
 * key. The caller is responsible for sourcing the L1 pubkey (cache /
 * handshake-embedded / DHT / registry); this function does not do
 * peer-resolution. The order matches AMENDMENT_TOFU §A3.2 verifier
 * guards: cheap → expensive.
 *
 *   1. `subject_id` well-formedness (UUIDv7).
 *   2. `parent_install.install_pubkey_fingerprint == sha256(l1PubRaw)`.
 *   3. `issued_at` not too far in the future (within 5-min clock skew).
 *   4. `expires_at` not in the past.
 *   5. Cert signature verifies against L1 pubkey (domain-tagged).
 */
export function verifyPeerTreeCertChain(args: VerifyPeerTreeCertArgs): VerifyResult {
  if (!isValidUuidV7(args.cert.subject_id)) {
    return {ok: false, reason: 'TREE_ID_MALFORMED'}
  }

  const expectedFingerprint = createHash('sha256').update(args.l1PubRaw).digest('hex')
  if (args.cert.parent_install.install_pubkey_fingerprint !== expectedFingerprint) {
    return {ok: false, reason: 'INVALID_PARENT_BINDING'}
  }

  const issuedAt = Date.parse(args.cert.issued_at)
  if (!Number.isFinite(issuedAt) || issuedAt > args.now.getTime() + CLOCK_SKEW_MS) {
    return {ok: false, reason: 'CERT_NOT_YET_VALID'}
  }

  const expiresAt = Date.parse(args.cert.expires_at)
  if (!Number.isFinite(expiresAt) || expiresAt <= args.now.getTime()) {
    return {ok: false, reason: 'CERT_EXPIRED'}
  }

  const l1PubKey = createPublicKey({
    format: 'jwk',
    key: {crv: 'Ed25519', kty: 'OKP', x: Buffer.from(args.l1PubRaw).toString('base64url')},
  })
  const {signature, ...payload} = args.cert
  if (!verifyPeerTreeCert(payload, signature, l1PubKey)) {
    return {ok: false, reason: 'PEER_TREE_SIG_INVALID'}
  }

  return {ok: true}
}
