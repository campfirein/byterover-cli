/* eslint-disable camelcase */
// Envelope field names mirror IMPLEMENTATION_PHASE_9 §5.1 on-wire JSON
// shape and are intentionally snake_case.

import {createHash, createPublicKey} from 'node:crypto'

import {canonicalize} from '../../../../agent/core/trust/canonical.js'
import {derivePeerIdFromRawPublicKey} from '../../../../agent/core/trust/peer-id.js'
import {verifyPeerTreeCertChain} from '../../../../agent/core/trust/peer-tree-signer.js'
import {
  verifyInstallCert,
  verifyParleyHandshake,
  verifyRequestAuth,
} from '../../../../agent/core/trust/sign.js'
import {type KnownPeer, type TofuStore} from '../../../../agent/core/trust/tofu-store.js'
import {
  type ParleyQueryEnvelope,
  ParleyQueryEnvelopeSchema,
  requestEnvelopeHash,
} from '../../../core/domain/channel/parley-types.js'
import {NonceLru} from './parley-nonce-lru.js'

/**
 * Phase 9 / IMPLEMENTATION_PHASE_9 §5.1 — Parley handshake verifier.
 *
 * Runs steps 1–11 of the 12-step verifier order (step 12, disclosure
 * resolver, is deferred to a later slice — mock-echo does not need it).
 *
 * Pure, dependency-injected, no I/O beyond:
 *   - `tofuStore` reads + an upsert on the success path.
 *   - `nonceLru` lookups + an insert on the success path.
 *
 * The function is total — it never throws on policy decisions or
 * malformed input. Implementation bugs that throw (e.g. crypto core
 * errors) propagate; the calling server wraps them via the rate-limit
 * hook per §5.1 codex round-4 MEDIUM-1.
 */

export type TofuPolicy = 'auto' | 'deny' | 'prompt'

export type CertKind = 'ca-issued-tree' | 'peer-tree'

export interface VerifyHandshakeArgs {
  readonly acceptModes: ReadonlyArray<CertKind>
  readonly clockSkewMs: number
  readonly envelope: unknown
  readonly nonceLru: NonceLru
  readonly now: Date
  readonly tofuPolicy: TofuPolicy
  readonly tofuStore: TofuStore
  readonly transportPeerId: string
}

export type VerifyHandshakeResult =
  | {envelope: ParleyQueryEnvelope; ok: true; pinned: KnownPeer; requestEnvelopeHash: string}
  | {
      envelope?: ParleyQueryEnvelope
      ok: false
      reason: VerifyFailureReason
      requestEnvelopeHash?: string
      retriable?: boolean
    }

export type VerifyFailureReason =
  | 'CERT_CHAIN_MISMATCH'
  | 'CERT_KIND_REJECTED_BY_POLICY'
  | 'ENVELOPE_MALFORMED'
  | 'HANDSHAKE_REPLAY'
  | 'HANDSHAKE_SIG_INVALID'
  | 'HANDSHAKE_TS_EXPIRED'
  | 'INSTALL_CERT_INVALID'
  | 'PARENT_INSTALL_CERT_UNAVAILABLE'
  | 'PEER_UNPINNED'
  | 'REQUEST_AUTH_INVALID'
  | 'REQUEST_BODY_HASH_MISMATCH'
  | 'TOFU_PROMPT_NOT_IMPLEMENTED'
  | 'TRANSPORT_IDENTITY_MISMATCH'
  | 'TREE_CERT_INVALID'

// eslint-disable-next-line complexity
export async function verifyHandshakeAndPin(args: VerifyHandshakeArgs): Promise<VerifyHandshakeResult> {
  // Step 1: syntactic decode (Zod safeParse — strict-mode envelope).
  const parsed = ParleyQueryEnvelopeSchema.safeParse(args.envelope)
  if (!parsed.success) {
    return {ok: false, reason: 'ENVELOPE_MALFORMED'}
  }

  const env = parsed.data

  // Compute the request-envelope hash once so failure paths can
  // surface it to the server (which binds error-terminal signatures
  // to the real request context, not a sentinel — kimi round-1
  // BLOCKING fix).
  const reHash = requestEnvelopeHash(env)
  const reject = (reason: VerifyFailureReason): VerifyHandshakeResult => ({
    envelope: env,
    ok: false,
    reason,
    requestEnvelopeHash: reHash,
  })

  // Step 2: timestamp window. The handshake.ts MUST be within ±clockSkewMs.
  const tsMs = Date.parse(env.handshake.ts)
  if (!Number.isFinite(tsMs)) return reject('HANDSHAKE_TS_EXPIRED')

  const drift = Math.abs(tsMs - args.now.getTime())
  if (drift > args.clockSkewMs) return reject('HANDSHAKE_TS_EXPIRED')

  // Step 3: transport identity match. Recompute peer_id from the
  // install_cert.public_key and compare against the Noise-authenticated
  // transport peer_id. No policy decisions yet based on attacker bytes.
  const installPubBytes = Buffer.from(env.handshake.install_cert.public_key.key, 'base64')
  if (installPubBytes.length !== 32) return reject('INSTALL_CERT_INVALID')

  let derivedPeerId: string
  try {
    derivedPeerId = derivePeerIdFromRawPublicKey(new Uint8Array(installPubBytes))
  } catch {
    return reject('INSTALL_CERT_INVALID')
  }

  if (derivedPeerId !== args.transportPeerId) return reject('TRANSPORT_IDENTITY_MISMATCH')

  // Step 4: install cert self-signature + subject_id == derivePeerId(public_key).
  if (env.handshake.install_cert.subject_id !== derivedPeerId) return reject('INSTALL_CERT_INVALID')

  const installPubKey = createPublicKey({
    format: 'jwk',
    key: {crv: 'Ed25519', kty: 'OKP', x: Buffer.from(installPubBytes).toString('base64url')},
  })

  const {signature: installSig, ...installCertPayload} = env.handshake.install_cert
  if (!verifyInstallCert(installCertPayload, installSig, installPubKey)) return reject('INSTALL_CERT_INVALID')

  // Step 5: handshake outer signature by install_cert.public_key over
  // canonical bytes of {install_cert, tree_cert, ts, nonce, version}.
  const {signature: handshakeSig, ...handshakeInner} = env.handshake
  if (!verifyParleyHandshake(handshakeInner, handshakeSig, installPubKey)) return reject('HANDSHAKE_SIG_INVALID')

  // Step 6: nonce replay check. Lookup ONLY — insertion happens at
  // step 11 after the rest of the pipeline passes (so step ≤10 rejects
  // don't lock out a legitimate re-try with the same nonce).
  if (args.nonceLru.has(args.transportPeerId, env.handshake.nonce)) return reject('HANDSHAKE_REPLAY')

  // Step 7: accept_modes gate. Tree-cert kind must be in the local
  // accept list AND must be supported by this slice (kimi round-1
  // MEDIUM — surface as CERT_KIND_REJECTED_BY_POLICY, not the more-
  // alarming TREE_CERT_INVALID, when the slice doesn't implement the
  // ca-issued-tree verification path).
  if (!args.acceptModes.includes(env.handshake.tree_cert.cert_kind)) {
    return reject('CERT_KIND_REJECTED_BY_POLICY')
  }

  if (env.handshake.tree_cert.cert_kind !== 'peer-tree') {
    // ca-issued-tree path is reserved by the type system but not
    // implemented in slice 9.3. Operators MAY put 'ca-issued-tree' in
    // acceptModes today, but the verifier rejects it here instead of
    // half-running a chain check that would fail with the wrong
    // reason code.
    return reject('CERT_KIND_REJECTED_BY_POLICY')
  }

  // Step 8: tree cert chain (peer-tree branch).
  const chain = verifyPeerTreeCertChain({
    cert: env.handshake.tree_cert,
    l1PubRaw: new Uint8Array(installPubBytes),
    now: args.now,
  })
  if (!chain.ok) return reject('TREE_CERT_INVALID')

  // Step 9: request_auth.requester_cert MUST be byte-equal (canonical
  // form) to handshake.tree_cert. We use canonical-JCS bytes rather
  // than reference equality so two structurally equivalent JS objects
  // with different key order still match.
  if (canonicalize(env.request_auth.requester_cert) !== canonicalize(env.handshake.tree_cert)) {
    return reject('CERT_CHAIN_MISMATCH')
  }

  // Step 10a: body_hash MUST equal sha256(canonical({protocol,
  // channel_id, turn_id, delivery_id, prompt})).
  const bodyHashInput = {
    channel_id: env.channel_id,
    delivery_id: env.delivery_id,
    prompt: env.prompt,
    protocol: env.protocol,
    turn_id: env.turn_id,
  }
  const computedBodyHash = createHash('sha256')
    .update(canonicalize(bodyHashInput), 'utf8')
    .digest('hex')
  if (computedBodyHash !== env.request_auth.body_hash) return reject('REQUEST_BODY_HASH_MISMATCH')

  // Step 10b: request_auth.signature MUST verify under the L2 tree
  // key (tree_cert.public_key) over canonical(request_auth minus
  // signature).
  const treePubBytes = Buffer.from(env.handshake.tree_cert.public_key.key, 'base64')
  const treePubKey = createPublicKey({
    format: 'jwk',
    // treePubBytes is already a Buffer; calling .toString directly avoids
    // a no-op `Buffer.from(buffer)` wrap (kimi round-1 LOW).
    key: {crv: 'Ed25519', kty: 'OKP', x: treePubBytes.toString('base64url')},
  })
  const {signature: reqAuthSig, ...reqAuthPayload} = env.request_auth
  if (!verifyRequestAuth(reqAuthPayload, reqAuthSig, treePubKey)) return reject('REQUEST_AUTH_INVALID')

  // Step 11: TOFU policy. Lookup existing pin; apply tofu_policy.
  const existing = await args.tofuStore.get(args.transportPeerId)
  if (!existing && args.tofuPolicy === 'deny') return reject('PEER_UNPINNED')

  if (!existing && args.tofuPolicy === 'prompt') {
    // v1 mock-echo slice deliberately does NOT wire a prompt UX —
    // that requires a CLI/REPL interaction that is out of scope
    // here. Operators set tofu_policy: 'auto' or 'deny' in 9.3.
    return reject('TOFU_PROMPT_NOT_IMPLEMENTED')
  }

  // All guards passed — pin (or refresh last_seen) under the store's
  // exclusive lock, with merge inside the lock for race-free pin-state
  // preservation. Insert the nonce LRU entry only after we know the
  // upsert succeeded.
  //
  // `display_handle` is preserved across re-pins (kimi round-1 MEDIUM
  // — handle-revert spoofing fix). Once Bob has a handle pinned for
  // this peer_id, an attacker replaying an old install cert with a
  // different handle cannot overwrite it. The operator must explicitly
  // re-confirm via `brv trust verify` to change a pinned handle.
  const fingerprint = `sha256:${createHash('sha256').update(installPubBytes).digest('hex')}`
  const nowIso = args.now.toISOString()
  const pinned = await args.tofuStore.upsertWithMerge(args.transportPeerId, (priorPeer) => ({
    display_handle: priorPeer?.display_handle ?? env.handshake.install_cert.display_handle,
    first_seen_at: priorPeer?.first_seen_at ?? nowIso,
    install_cert_fingerprint: fingerprint,
    last_seen_at: nowIso,
    peer_id: args.transportPeerId,
    pin_state: priorPeer?.pin_state ?? 'auto-tofu',
    ...(priorPeer?.ca_binding ? {ca_binding: priorPeer.ca_binding} : {}),
  }))

  args.nonceLru.insert(args.transportPeerId, env.handshake.nonce)

  return {envelope: env, ok: true, pinned, requestEnvelopeHash: reHash}
}
