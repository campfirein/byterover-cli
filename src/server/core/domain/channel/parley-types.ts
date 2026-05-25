/* eslint-disable camelcase */
// Parley wire-shape field names mirror IMPLEMENTATION_PHASE_9_CLOUD_BRIDGE
// §5.1 + §5.2 on-wire JSON shape (snake_case is normative).

import {createHash} from 'node:crypto'
import {z} from 'zod'

import {canonicalize} from '../../../../agent/core/trust/canonical.js'
import {DOMAIN_TAGS} from '../../../../agent/core/trust/sign.js'

/**
 * Phase 9 / Slice 9.3a — Parley wire-shape primitives.
 *
 * Defines:
 *   - Zod schemas for `ParleyQueryEnvelope`, `ParleyHandshake`,
 *     server-side `ParleyResponseFrame`, client-side `ParleyClientFrame`.
 *   - `requestEnvelopeHash(envelope)` — canonical-JCS sha256 of the
 *     envelope. Used in terminal/seal signature payloads to bind
 *     responses to the exact request (§5.2 round-2 MEDIUM-clarification).
 *   - `transcriptDigest(frames)` — domain-tagged sha256 over the
 *     canonical concat of non-heartbeat frames in seq order (§5.2).
 *
 * Schemas use `.strict()` so unknown fields are rejected: the verifier
 * is unforgiving by design to prevent malleability of attacker-supplied
 * envelopes flowing into signed-payload hashes.
 */

const Base64 = z.string().regex(/^[A-Za-z0-9+/]*=*$/, 'must be base64')

// ─── certificate sub-shapes (mirrors AMENDMENT_TOFU §A3.2) ─────────────────

const InstallCertificateSchema = z
  .object({
    cert_kind: z.literal('install'),
    display_handle: z.string().optional(),
    expires_at: z.string(),
    issued_at: z.string(),
    public_key: z
      .object({
        alg: z.literal('ed25519'),
        key: Base64,
      })
      .strict(),
    signature: Base64,
    subject_id: z.string(),
    version: z.literal(1),
  })
  .strict()

const PeerTreeCertificateSchema = z
  .object({
    cert_kind: z.literal('peer-tree'),
    expires_at: z.string(),
    issued_at: z.string(),
    parent_install: z
      .object({
        install_pubkey_fingerprint: z.string(),
        peer_id: z.string(),
      })
      .strict(),
    public_key: z
      .object({
        alg: z.literal('ed25519'),
        key: Base64,
      })
      .strict(),
    signature: Base64,
    subject_id: z.string(),
    version: z.literal(1),
  })
  .strict()

const CaIssuedTreeCertificateSchema = z
  .object({
    cert_kind: z.literal('ca-issued-tree'),
    expires_at: z.string(),
    issued_at: z.string(),
    issuer: z.string(),
    log_entry: z
      .object({
        index: z.number().int().nonnegative(),
        log_id: z.string(),
        proof: z.array(z.string()),
      })
      .strict(),
    owner: z
      .object({
        account_id: z.string(),
        kind: z.enum(['org', 'service', 'user']),
      })
      .strict(),
    public_key: z
      .object({
        alg: z.literal('ed25519'),
        key: Base64,
      })
      .strict(),
    serial: z.string(),
    signature: Base64,
    subject_id: z.string(),
    version: z.literal(1),
  })
  .strict()

const TreeCertificateSchema = z.discriminatedUnion('cert_kind', [
  PeerTreeCertificateSchema,
  CaIssuedTreeCertificateSchema,
])

// ─── content blocks (ACP-shaped prompt body) ────────────────────────────────

const ContentBlockSchema = z
  .object({
    text: z.string(),
    type: z.literal('text'),
  })
  .strict()

// ─── handshake + envelope schemas ──────────────────────────────────────────

export const ParleyHandshakeSchema = z
  .object({
    install_cert: InstallCertificateSchema,
    nonce: Base64,
    signature: Base64,
    tree_cert: TreeCertificateSchema,
    ts: z.string(),
    version: z.literal(1),
  })
  .strict()

export type ParleyHandshake = z.infer<typeof ParleyHandshakeSchema>

const RequestAuthSchema = z
  .object({
    body_hash: z.string().regex(/^[\da-f]{64}$/, 'body_hash must be 64 hex chars (sha256)'),
    requester_cert: TreeCertificateSchema,
    signature: Base64,
  })
  .strict()

export const ParleyQueryEnvelopeSchema = z
  .object({
    auth_audit: z.unknown().optional(),
    channel_id: z.string().min(1),
    delivery_id: z.string().min(1),
    disclosure_intent: z.enum(['delegate', 'query']),
    handshake: ParleyHandshakeSchema,
    prompt: z.array(ContentBlockSchema).min(1),
    protocol: z.enum(['delegate', 'query']),
    request_auth: RequestAuthSchema,
    suppress_thoughts: z.boolean().optional(),
    turn_id: z.string().min(1),
    version: z.literal(1),
  })
  .strict()

export type ParleyQueryEnvelope = z.infer<typeof ParleyQueryEnvelopeSchema>

/**
 * Phase 9 / Slice 9.10 (kimi round-1 LOW) — single source of truth
 * for the parley protocol enum. Helpers that need to type a
 * `bound.protocol` field import this rather than inlining the
 * literal union, so adding a future `'task'` protocol is a
 * one-place change.
 */
export type ParleyProtocol = ParleyQueryEnvelope['protocol']

// ─── server-side response frames (§5.2) ────────────────────────────────────

const AgentMessageChunkSchema = z
  .object({
    content: z.string(),
    kind: z.literal('agent_message_chunk'),
    seq: z.number().int().positive(),
  })
  .strict()

const AgentThoughtChunkSchema = z
  .object({
    content: z.string(),
    kind: z.literal('agent_thought_chunk'),
    seq: z.number().int().positive(),
  })
  .strict()

const ToolCallUpdateSchema = z
  .object({
    kind: z.literal('tool_call_update'),
    seq: z.number().int().positive(),
    tool_call: z.unknown(),
  })
  .strict()

const PermissionRequestSchema = z
  .object({
    kind: z.literal('permission_request'),
    options: z.array(z.unknown()),
    request_id: z.string(),
    seq: z.number().int().positive(),
    tool_call: z.unknown(),
  })
  .strict()

const PermissionResolvedSchema = z
  .object({
    decided_by: z.literal('bob'),
    kind: z.literal('permission_resolved'),
    option_id: z.string(),
    request_id: z.string(),
    seq: z.number().int().positive(),
  })
  .strict()

const HeartbeatPingSchema = z
  .object({
    kind: z.literal('heartbeat_ping'),
    seq: z.number().int().positive(),
  })
  .strict()

const HeartbeatPongSchema = z
  .object({
    in_response_to_seq: z.number().int().positive(),
    kind: z.literal('heartbeat_pong'),
    seq: z.number().int().positive(),
  })
  .strict()

const TranscriptSealSchema = z
  .object({
    kind: z.literal('transcript_seal'),
    seq: z.number().int().positive(),
    signature: Base64,
    transcript_digest: z.string().regex(/^[\da-f]{64}$/),
  })
  .strict()

const ErrorFrameSchema = z
  .object({
    code: z.string().min(1),
    kind: z.literal('error'),
    message: z.string(),
    seq: z.number().int().positive(),
    signature: Base64,
  })
  .strict()

const StreamEndFrameSchema = z
  .object({
    ended_state: z.enum(['cancelled', 'completed']),
    kind: z.literal('stream_end'),
    seq: z.number().int().positive(),
    signature: Base64,
  })
  .strict()

export const ParleyResponseFrameSchema = z.discriminatedUnion('kind', [
  AgentMessageChunkSchema,
  AgentThoughtChunkSchema,
  ToolCallUpdateSchema,
  PermissionRequestSchema,
  PermissionResolvedSchema,
  HeartbeatPingSchema,
  HeartbeatPongSchema,
  TranscriptSealSchema,
  ErrorFrameSchema,
  StreamEndFrameSchema,
])

export type ParleyResponseFrame = z.infer<typeof ParleyResponseFrameSchema>

// ─── client-side frames (§5.2) ─────────────────────────────────────────────

const PermissionResponseIntentSchema = z
  .object({
    alice_decision: z.enum(['allow', 'defer', 'deny']),
    kind: z.literal('permission_response_intent'),
    request_id: z.string(),
    seq: z.number().int().positive(),
    signature: Base64,
  })
  .strict()

const CancelFrameSchema = z
  .object({
    kind: z.literal('cancel'),
    seq: z.number().int().positive(),
    signature: Base64,
  })
  .strict()

export const ParleyClientFrameSchema = z.discriminatedUnion('kind', [
  PermissionResponseIntentSchema,
  CancelFrameSchema,
  HeartbeatPingSchema,
  HeartbeatPongSchema,
])

export type ParleyClientFrame = z.infer<typeof ParleyClientFrameSchema>

// ─── digest + hash helpers (§5.2) ──────────────────────────────────────────

/**
 * Canonical-JCS sha256 of a `ParleyQueryEnvelope`. Used as
 * `request_envelope_hash` in terminal/seal signature payloads to bind
 * responses to the EXACT request.
 *
 * Per spec §5.2 round-2 MEDIUM-clarification: "request_envelope_hash
 * covers protocol, channel_id, turn_id, delivery_id, prompt canonical
 * bytes, the request_auth.signature, and the handshake.signature."
 * Implementation hashes the entire canonical envelope — both inner
 * signatures are part of that, so the spec semantics fall out
 * naturally without an exclusion list.
 */
export function requestEnvelopeHash(envelope: unknown): string {
  const canonical = canonicalize(envelope)
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Hex sha256 over the canonical concat of non-heartbeat response
 * frames (kind + seq + canonical-JCS payload, in seq order), prefixed
 * with the domain tag `brv.response.v1\n`. Heartbeat frames are
 * EXCLUDED from the digest per §5.2 (their timing must not affect
 * signature reproducibility) but DO count toward seq monotonicity at
 * verify time (the verifier checks elsewhere).
 *
 * The verifier reconstructs this hash from the frames it observes and
 * compares against the signed `transcript_seal.transcript_digest`. Any
 * mismatch is `TRANSCRIPT_DIGEST_MISMATCH`.
 */
export function transcriptDigest(
  frames: ReadonlyArray<Record<string, unknown> & {readonly kind: string}>,
): string {
  const h = createHash('sha256')
  h.update(Buffer.from(DOMAIN_TAGS['response.frame-digest'], 'utf8'))
  for (const frame of frames) {
    if (frame.kind === 'heartbeat_ping' || frame.kind === 'heartbeat_pong') continue
    h.update(Buffer.from(canonicalize(frame), 'utf8'))
  }

  return h.digest('hex')
}
