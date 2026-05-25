import {sign as ed25519Sign, verify as ed25519Verify, KeyObject} from 'node:crypto'

import {canonicalize} from './canonical.js'

/**
 * Phase 9 / AMENDMENT_TOFU §A7 — domain-separated Ed25519 sign/verify.
 *
 * Every brv L1 application signature MUST prefix its canonical-JCS
 * bytes with a domain tag of the form `brv.<kind>.v1\n`. The tag is
 * NEVER part of the payload — it is hashed-in-line during signing
 * and re-prefixed during verification. This prevents a signature
 * produced for one intent (e.g. an install cert) from accidentally
 * verifying against another (e.g. a parley handshake) when the two
 * payloads happen to share canonical bytes.
 *
 * The API surface is intentionally typed-per-intent. There is NO
 * `signRaw` / `signBytes` / `sign` helper exposed: callers cannot
 * bypass domain separation. A new signing intent requires a new
 * typed helper added here.
 *
 * Ed25519 is deterministic (no per-signature nonce), so calling
 * `signX(payload, key)` twice with the same input MUST produce the
 * same output. Tests assert this property.
 */

// ─── domain-tag registry ────────────────────────────────────────────────────

/**
 * Domain-tag registry (opencode round-1 MEDIUM — invariant documented).
 *
 * INVARIANT: every value MUST be byte-prefix-unique against every other
 * value AND against any conceivable JCS-canonical bytes. This is what
 * makes cross-protocol replay impossible:
 *
 *   Sign( "brv.cert.install.v1\n" || J(P1) )  // produces sigA
 *   Verify( "brv.parley.handshake.v1\n" || J(P1), sigA )  // MUST fail
 *
 * The current tags satisfy uniqueness by construction: each kind name
 * (`cert.install`, `cert.peer-tree`, etc.) is distinct, and the `v1\n`
 * suffix makes them non-extendable substrings of each other. The
 * trailing `\n` (0x0A) is BELOW 0x20, so a JCS-canonical payload (which
 * begins with `{`, `[`, `"`, `null`, `true`, `false`, `-`, or `0-9` —
 * NEVER 0x0A) cannot start with that byte. Thus the tag boundary is
 * unambiguous regardless of payload contents.
 *
 * Adding a new tag: pick a fresh `kind` name, ensure it does NOT
 * collide as a prefix or suffix of any existing tag, append to this
 * object, add a typed sign/verify helper pair below. The `satisfies`
 * clause enforces the `brv.<kind>.v1\n` shape at compile time.
 */
export const DOMAIN_TAGS = {
  'cert.install': 'brv.cert.install.v1\n',
  'cert.peer-tree': 'brv.cert.peer-tree.v1\n',
  consent: 'brv.consent.v1\n',
  'parley.handshake': 'brv.parley.handshake.v1\n',
  'parley.request-auth': 'brv.parley.request-auth.v1\n',
  'peer-record': 'brv.peer-record.v1\n',
  'response.error': 'brv.response.error.v1\n',
  'response.frame-digest': 'brv.response.v1\n',
  'response.terminal': 'brv.response.terminal.v1\n',
} as const satisfies Record<string, `brv.${string}.v1\n`>

export type DomainTag = (typeof DOMAIN_TAGS)[keyof typeof DOMAIN_TAGS]

// ─── core sign/verify (NOT exported — callers MUST use typed helpers) ──────

function signWithDomain(
  payload: unknown,
  domain: DomainTag,
  privateKey: KeyObject,
): string {
  const message = Buffer.concat([
    Buffer.from(domain, 'utf8'),
    Buffer.from(canonicalize(payload), 'utf8'),
  ])
  // node:crypto Ed25519 signing: pass `null` as the digest (Ed25519 hashes
  // internally) and the Ed25519 private key.
  const sig = ed25519Sign(null, message, privateKey)
  return sig.toString('base64')
}

function verifyWithDomain(
  payload: unknown,
  signature: string,
  domain: DomainTag,
  publicKey: KeyObject,
): boolean {
  // Verifier MUST be total: any malformed input returns false, never throws.
  //
  // Defense-in-depth (opencode round-1 MEDIUM): explicitly reject non-Ed25519
  // keys before calling ed25519Verify. ed25519Verify on a wrong-curve key
  // throws, which the outer try/catch would convert to `false` — but a
  // future refactor that removes the catch would expose the throw. Belt-
  // and-suspenders: fail closed before reaching the crypto call.
  if (publicKey.asymmetricKeyType !== 'ed25519') return false

  let sigBytes: Buffer
  try {
    sigBytes = Buffer.from(signature, 'base64')
    // Reject non-base64 inputs that Buffer would silently lossy-decode.
    // Ed25519 signatures are exactly 64 bytes.
    if (sigBytes.length !== 64) return false
  } catch {
    return false
  }

  let canonical: string
  try {
    canonical = canonicalize(payload)
  } catch {
    return false
  }

  const message = Buffer.concat([
    Buffer.from(domain, 'utf8'),
    Buffer.from(canonical, 'utf8'),
  ])

  try {
    return ed25519Verify(null, message, publicKey, sigBytes)
  } catch {
    return false
  }
}

// ─── typed-per-intent L1 signing helpers ────────────────────────────────────

/** Sign an InstallCertificate payload (subject == signer; self-signed). */
export function signInstallCert(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['cert.install'], privateKey)
}

export function verifyInstallCert(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['cert.install'], publicKey)
}

/**
 * Sign a PeerTreeCertificate payload with the L1 install key (binds L2
 * tree key to L1 install identity).
 */
export function signPeerTreeCert(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['cert.peer-tree'], privateKey)
}

export function verifyPeerTreeCert(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['cert.peer-tree'], publicKey)
}

/** Sign a Parley handshake envelope with the L1 install key. */
export function signParleyHandshake(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['parley.handshake'], privateKey)
}

export function verifyParleyHandshake(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['parley.handshake'], publicKey)
}

/**
 * Sign a discovery peer-record (ByteRover registry / DHT-side brv-only
 * records — not libp2p's own peer-record framing, which uses its own
 * signing path).
 */
export function signPeerRecord(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['peer-record'], privateKey)
}

export function verifyPeerRecord(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['peer-record'], publicKey)
}

/**
 * Sign a `RequestAuth` payload with the caller's L2 tree key. The
 * payload is canonical-JCS bytes of `{body_hash, requester_cert}`
 * (the request_auth object minus its own signature). See
 * IMPLEMENTATION_PHASE_9 §5.1 step 10 + parent cross-agent-trust §5.4.
 */
export function signRequestAuth(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['parley.request-auth'], privateKey)
}

export function verifyRequestAuth(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['parley.request-auth'], publicKey)
}

// ─── Parley response-side signing helpers (Slice 9.3a) ─────────────────────

/**
 * Sign a `transcript_seal` frame payload with the responder's L2 tree
 * key. Payload shape:
 *   {channel_id, turn_id, delivery_id, protocol, request_envelope_hash,
 *    ended_state, transcript_digest}
 * See IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE.md §5.2.
 */
export function signTranscriptSeal(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['response.frame-digest'], privateKey)
}

export function verifyTranscriptSeal(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['response.frame-digest'], publicKey)
}

/**
 * Sign a `stream_end` terminal frame payload with the responder's L2
 * tree key. Domain tag `brv.response.terminal.v1`. Payload binds the
 * full request context per §5.2 codex round-3 MEDIUM-2.
 */
export function signResponseTerminal(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['response.terminal'], privateKey)
}

export function verifyResponseTerminal(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['response.terminal'], publicKey)
}

/**
 * Sign an `error` terminal frame payload with the responder's L2 tree
 * key. Domain tag `brv.response.error.v1`. Payload binds the full
 * request context per §5.2 codex round-3 MEDIUM-2.
 */
export function signResponseError(payload: unknown, privateKey: KeyObject): string {
  return signWithDomain(payload, DOMAIN_TAGS['response.error'], privateKey)
}

export function verifyResponseError(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS['response.error'], publicKey)
}

/**
 * Sign a `permission_response_intent` payload with the caller's
 * (Alice's) L2 tree key. Domain tag `brv.consent.v1`. See §5.2 +
 * §5.3 — Alice's INTENT, not the final permission grant.
 */
export function signPermissionResponseIntent(
  payload: unknown,
  privateKey: KeyObject,
): string {
  return signWithDomain(payload, DOMAIN_TAGS.consent, privateKey)
}

export function verifyPermissionResponseIntent(
  payload: unknown,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verifyWithDomain(payload, signature, DOMAIN_TAGS.consent, publicKey)
}
