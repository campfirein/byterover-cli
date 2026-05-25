/* eslint-disable camelcase */
// Bound-context wire fields use snake_case (parley §5.2).

import type {KeyObject} from 'node:crypto'

import {verifyTranscriptSeal} from '../../../../agent/core/trust/sign.js'
import {
  type ParleyProtocol,
  type ParleyResponseFrame,
  transcriptDigest,
} from '../../../core/domain/channel/parley-types.js'

/**
 * Phase 9 / Slice 9.10 — pure transcript-seal auditor.
 *
 * Extracts the seal-verification logic from `parley-client.ts`'s
 * `verifyResponseStream` so it can be re-run AFTER a parley round
 * has completed and its frames + seal have been persisted to disk.
 * The receive-time path in `parley-client.ts` continues to call its
 * own inline verifier; later audit paths (operator-facing
 * `brv channel verify` CLI, a daemon-level integrity sweep) read
 * the persisted ParleyResponseFrame stream + persisted bound
 * context and call this function with the responder's L2 pubkey to
 * confirm the on-disk transcript is still a faithful representation
 * of what the responder produced.
 *
 * What it CHECKS:
 *   - Exactly one seal frame is present AND it is the LAST element
 *     (kimi round-1 MED — trailing-frames-after-seal rejected so an
 *     attacker can't append garbage past a valid seal).
 *   - A terminal frame (`stream_end` or `error`) precedes the seal
 *     and is the last non-heartbeat frame before it (kimi round-1
 *     MED — degenerate / heartbeat-only / empty pre-seal rejected).
 *   - `transcript_digest` over the pre-seal frames matches the
 *     persisted seal's `transcript_digest`.
 *   - The seal signature verifies under the responder's L2 pubkey
 *     over the canonical bound context. The audit checks this
 *     UNCONDITIONALLY, including on `ended_state === 'errored'`
 *     (kimi round-1 LOW — the dispatch code signs errored seals
 *     too, so skipping sig-verify here would create a tampering
 *     blindspot. The receive-time path's allowance for sentinel
 *     pre-parse rejects does NOT apply on the audit path because
 *     sentinel-rejected envelopes are never persisted in the first
 *     place).
 *
 * The function does NOT check:
 *   - Frame seq monotonicity (transport-layer concern; persisted
 *     data may legitimately lack heartbeats which would break a
 *     strict seq walk).
 *   - Individual terminal frame signatures (those are checked at
 *     receive time and their signed payloads are not currently
 *     persisted in a re-verifiable form — future scope).
 */

export type AuditParleySealResult =
  | {ok: false; reason: AuditParleySealFailReason}
  | {ok: true}

export type AuditParleySealFailReason =
  | 'MISSING_SEAL'
  | 'STRUCTURE_INVALID'
  | 'TRAILING_FRAMES_AFTER_SEAL'
  | 'TRANSCRIPT_DIGEST_MISMATCH'
  | 'TRANSCRIPT_SEAL_SIG_INVALID'

export interface AuditParleySealArgs {
  readonly bound: {
    readonly channel_id: string
    readonly delivery_id: string
    readonly ended_state: 'cancelled' | 'completed' | 'errored'
    readonly protocol: ParleyProtocol
    readonly request_envelope_hash: string
    readonly turn_id: string
  }
  /** Full frame sequence including the seal at the last position. */
  readonly frames: ReadonlyArray<ParleyResponseFrame>
  readonly remoteL2PubKey: KeyObject
}

export function auditParleySeal(args: AuditParleySealArgs): AuditParleySealResult {
  const sealIdx = args.frames.findIndex((f) => f.kind === 'transcript_seal')
  if (sealIdx === -1) return {ok: false, reason: 'MISSING_SEAL'}
  const seal = args.frames[sealIdx]
  if (seal.kind !== 'transcript_seal') return {ok: false, reason: 'MISSING_SEAL'}

  // kimi round-1 MED — seal MUST be the last frame. Any trailing
  // bytes after the signed seal are unsigned and would otherwise
  // pass audit silently if we ignored them.
  if (sealIdx !== args.frames.length - 1) {
    return {ok: false, reason: 'TRAILING_FRAMES_AFTER_SEAL'}
  }

  // kimi round-1 MED — structural check on the pre-seal sequence.
  // The wire protocol requires the last non-heartbeat frame before
  // the seal to be either `stream_end` or `error`. An empty or
  // heartbeat-only pre-seal would be a degenerate (truncated)
  // transcript that should NOT pass audit even if the digest matches.
  const preSeal = args.frames.slice(0, sealIdx)
  const lastNonHeartbeat = [...preSeal]
    .reverse()
    .find((f) => f.kind !== 'heartbeat_ping' && f.kind !== 'heartbeat_pong')
  if (
    lastNonHeartbeat === undefined ||
    (lastNonHeartbeat.kind !== 'stream_end' && lastNonHeartbeat.kind !== 'error')
  ) {
    return {ok: false, reason: 'STRUCTURE_INVALID'}
  }

  const expectedDigest = transcriptDigest(preSeal)
  if (expectedDigest !== seal.transcript_digest) {
    return {ok: false, reason: 'TRANSCRIPT_DIGEST_MISMATCH'}
  }

  const sealPayload = {
    channel_id: args.bound.channel_id,
    delivery_id: args.bound.delivery_id,
    ended_state: args.bound.ended_state,
    protocol: args.bound.protocol,
    request_envelope_hash: args.bound.request_envelope_hash,
    transcript_digest: seal.transcript_digest,
    turn_id: args.bound.turn_id,
  }
  if (!verifyTranscriptSeal(sealPayload, seal.signature, args.remoteL2PubKey)) {
    return {ok: false, reason: 'TRANSCRIPT_SEAL_SIG_INVALID'}
  }

  return {ok: true}
}
