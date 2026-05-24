/* eslint-disable camelcase */
// Wire-shape field names mirror IMPLEMENTATION_PHASE_9 §5.1 + §5.2
// on-wire JSON and are intentionally snake_case.

import * as lp from 'it-length-prefixed'
import {createHash, createPublicKey, KeyObject, randomBytes} from 'node:crypto'

import {canonicalize} from '../../../../agent/core/trust/canonical.js'
import {type InstallIdentityService} from '../../../../agent/core/trust/install-identity-service.js'
import {derivePeerIdFromRawPublicKey} from '../../../../agent/core/trust/peer-id.js'
import {type PeerTreeIdentityService} from '../../../../agent/core/trust/peer-tree-identity-service.js'
import {
  signParleyHandshake as signParleyHandshakeHelper,
  signRequestAuth,
  verifyResponseError,
  verifyResponseTerminal,
  verifyTranscriptSeal,
} from '../../../../agent/core/trust/sign.js'
import {
  type ParleyQueryEnvelope,
  type ParleyResponseFrame,
  ParleyResponseFrameSchema,
  requestEnvelopeHash,
  transcriptDigest,
} from '../../../core/domain/channel/parley-types.js'
import {type Libp2pHost} from './libp2p-host.js'
import {PARLEY_QUERY_PROTOCOL} from './parley-server.js'

/**
 * Phase 9 / Slice 9.3d — Parley client.
 *
 * `sendParleyQuery` builds a signed `ParleyQueryEnvelope`, dials a
 * remote peer over `/brv/parley/query/v1`, sends the envelope, reads
 * response frames, and verifies the per-frame signatures + the
 * transcript_seal against the responder's L2 public key.
 *
 * Return value carries:
 *   - the body content (concatenated agent_message_chunk text)
 *   - the ended_state (completed / cancelled / errored)
 *   - any error code/message on the failure path
 *   - the raw frame log for diagnostics
 *
 * Verification of response frames happens client-side too — the seal
 * is the authoritative integrity binding, but a precondition is that
 * the SIGNED terminal frame matches the seal's `ended_state`
 * (PHASE_9 §5.2 round-2 NEW MAJOR-3).
 */

export interface SendParleyQueryArgs {
  readonly channel_id: string
  readonly delivery_id: string
  readonly host: Libp2pHost
  readonly install: InstallIdentityService
  readonly l2Identity: PeerTreeIdentityService
  readonly multiaddr: string
  readonly nonce?: Uint8Array
  /**
   * Phase 9.5.7 Issue 1 fix — called as soon as the libp2p dial +
   * initial payload send complete, before the body callback reads any
   * frames. The caller uses this to clear the dial-phase timeout so it
   * cannot fire during the frame-read phase.
   */
  readonly onDialComplete?: () => void
  /**
   * Phase 9.5.7 Issue 2 fix — called for every parsed response frame
   * (any kind: chunk, heartbeat, thought, tool_use, etc.) as it arrives.
   * The caller uses this to reset the idle timer so the turn can
   * proceed indefinitely as long as the responder keeps emitting frames.
   */
  readonly onFrameReceived?: (frame: {readonly kind: string; readonly seq: number}) => void
  readonly prompt: ReadonlyArray<{readonly text: string; readonly type: 'text'}>
  readonly remoteL2PubKey: KeyObject  // Bob's L2 public key for seal/terminal verify
  /**
   * Phase 9.5.7 §3.3 Layer C — optional AbortSignal. When provided:
   *   - Passed to `dialProtocol()` so the dial phase can be interrupted.
   *   - Wired to the established stream's `abort()` method for post-dial interruption.
   *   - Passed into `readResponseFrames` so each .next() races against it.
   * signal.reason is preserved verbatim as the thrown error.
   */
  readonly signal?: AbortSignal
  readonly turn_id: string
}

export type SendParleyQueryResult =
  | {
      code: string
      frames: ParleyResponseFrame[]
      message: string
      ok: false
    }
  | {
      content: string
      endedState: 'cancelled' | 'completed'
      frames: ParleyResponseFrame[]
      /**
       * Phase 9.5.7 §3.2 Layer A — whether integrity was degraded.
       * `true` when the seal was missing and the fallback to a signed stream_end
       * was used. `false` on the normal explicit-seal path.
       */
      integrityDegraded: boolean
      ok: true
      /**
       * Phase 9.5.7 §3.2 Layer A — origin of the turn's seal.
       * `'explicit'` — normal: a `transcript_seal` frame was received and verified.
       * `'implicit-from-signed-terminal'` — degraded: seal was missing; turn was
       * reconstructed from a verified `stream_end` terminal + unsigned chunks.
       */
      sealOrigin: 'explicit' | 'implicit-from-signed-terminal'
    }

export async function sendParleyQuery(args: SendParleyQueryArgs): Promise<SendParleyQueryResult> {
  const envelope = await buildEnvelope(args)
  const envelopeJson = new TextEncoder().encode(JSON.stringify(envelope))
  const framed = await encodeLengthPrefixed(envelopeJson)
  const expectedReHash = requestEnvelopeHash(envelope)

  const frames = await args.host.dialAndSendAndConsume(
    args.multiaddr,
    PARLEY_QUERY_PROTOCOL,
    framed,
    {
      // §3.3 Layer C: pass signal into body so the frame reader can race reads.
      // Issue 1: call onDialComplete at the start of body (after dial+send) so
      //   the caller can clear the dial-phase timeout before frame reading starts.
      // Issue 2: pass onFrameReceived so the caller can reset the idle timer per-frame.
      async body(source, signal) {
        args.onDialComplete?.()
        return readResponseFrames(source, signal, args.onFrameReceived)
      },
      signal: args.signal,
    },
  )

  return verifyResponseStream({
    expectedChannelId: args.channel_id,
    expectedDeliveryId: args.delivery_id,
    expectedReHash,
    expectedTurnId: args.turn_id,
    frames,
    protocol: 'query',
    remoteL2PubKey: args.remoteL2PubKey,
  })  // await implicit — sendParleyQuery is async, verifyResponseStream is now async
}

// ─── envelope build ────────────────────────────────────────────────────────

async function buildEnvelope(args: SendParleyQueryArgs): Promise<ParleyQueryEnvelope> {
  const aliceL1 = await args.install.loadOrGenerate()
  const aliceL2 = await args.l2Identity.loadOrGenerate()
  const aliceL1Priv = await args.install.getL1PrivateKey()

  const protocol = 'query' as const
  const body_hash = createHash('sha256')
    .update(
      canonicalize({
        channel_id: args.channel_id,
        delivery_id: args.delivery_id,
        prompt: args.prompt,
        protocol,
        turn_id: args.turn_id,
      }),
      'utf8',
    )
    .digest('hex')

  const requestAuthPayload = {body_hash, requester_cert: aliceL2.cert}
  const reqAuthSig = signRequestAuth(requestAuthPayload, aliceL2.privateKey)

  const nonceBytes = args.nonce ?? randomNonce()
  const handshakeInner = {
    install_cert: aliceL1.cert,
    nonce: Buffer.from(nonceBytes).toString('base64'),
    tree_cert: aliceL2.cert,
    ts: new Date().toISOString(),
    version: 1 as const,
  }
  const handshakeSig = signParleyHandshakeHelper(handshakeInner, aliceL1Priv)

  return {
    channel_id: args.channel_id,
    delivery_id: args.delivery_id,
    disclosure_intent: protocol,
    handshake: {...handshakeInner, signature: handshakeSig},
    prompt: args.prompt as ParleyQueryEnvelope['prompt'],
    protocol,
    request_auth: {...requestAuthPayload, signature: reqAuthSig},
    turn_id: args.turn_id,
    version: 1,
  }
}

function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(16))
}

// ─── frame read + verify ──────────────────────────────────────────────────

/**
 * Phase 9.5.7 §3.3 Layer C — exported for unit testing only.
 *
 * Reads length-prefixed response frames from a libp2p-like stream, parsing
 * each into a `ParleyResponseFrame`. When a signal is provided, each
 * `iterator.next()` call is raced against the signal-abort promise so the
 * loop can be interrupted without waiting for the next network chunk.
 *
 * signal.reason is preserved verbatim — if the reason is not an Error, a
 * generic PARLEY_ABORT_VIA_SIGNAL error is thrown instead.
 *
 * @internal
 * @yields {ParleyResponseFrame} Each parsed response frame from the stream.
 */
export async function* readResponseFramesForTest(
  source: AsyncIterable<{readonly subarray: () => Uint8Array}>,
  signal?: AbortSignal,
  onFrameReceived?: (frame: {readonly kind: string; readonly seq: number}) => void,
): AsyncIterable<ParleyResponseFrame> {
  yield* readResponseFramesInternal(source, signal, onFrameReceived)
}

/** Resolve `signal.reason` to an Error, falling back to a generic marker. */
function abortReasonAsError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('PARLEY_ABORT_VIA_SIGNAL')
}

/**
 * Internal implementation for both the exported-for-test surface and the
 * production `readResponseFrames` collector.
 *
 * @yields {ParleyResponseFrame} Each parsed response frame from the stream.
 */
async function* readResponseFramesInternal(
  source: AsyncIterable<{readonly subarray: () => Uint8Array}>,
  signal?: AbortSignal,
  // Issue 2: per-frame callback so callers can reset idle timers.
  onFrameReceived?: (frame: {readonly kind: string; readonly seq: number}) => void,
): AsyncIterable<ParleyResponseFrame> {
  // §3.3 Layer C: throw early if already aborted at function entry.
  if (signal?.aborted === true) {
    throw abortReasonAsError(signal)
  }

  // Promise that rejects when the signal aborts — used to race each read.
  // Never resolves if no signal is provided.
  const abortPromise: Promise<never> =
    signal === undefined
      ? new Promise<never>(() => {})
      : new Promise<never>((_, reject) => {
          signal.addEventListener(
            'abort',
            () => { reject(abortReasonAsError(signal)) },
            {once: true},
          )
        })

  // Use the iterator protocol explicitly so we can race .next() against abort.
  const decoded = lp.decode(source as AsyncIterable<Uint8Array>)
  const iterator = decoded[Symbol.asyncIterator]()
  while (true) {
    // Race: either the next length-prefixed chunk arrives, or the signal fires.
    // eslint-disable-next-line no-await-in-loop
    const next = await Promise.race([iterator.next(), abortPromise])
    if (next.done) return

    const bytes = next.value.subarray() as Uint8Array
    const json = new TextDecoder('utf8').decode(bytes)
    let raw: unknown
    try {
      raw = JSON.parse(json)
    } catch {
      throw new Error('PARLEY_RESPONSE_PARSE_FAILED')
    }

    const parsed = ParleyResponseFrameSchema.safeParse(raw)
    if (!parsed.success) throw new Error('PARLEY_RESPONSE_FRAME_INVALID')
    // Issue 2: notify the caller of each received frame before yielding.
    onFrameReceived?.({kind: parsed.data.kind, seq: parsed.data.seq})
    yield parsed.data
    if (parsed.data.kind === 'transcript_seal') return
  }
}

async function readResponseFrames(
  source: AsyncIterable<{readonly subarray: () => Uint8Array}>,
  signal?: AbortSignal,
  onFrameReceived?: (frame: {readonly kind: string; readonly seq: number}) => void,
): Promise<ParleyResponseFrame[]> {
  const out: ParleyResponseFrame[] = []
  for await (const frame of readResponseFramesInternal(source, signal, onFrameReceived)) {
    out.push(frame)
  }

  return out
}

interface VerifyResponseStreamArgs {
  readonly expectedChannelId: string
  readonly expectedDeliveryId: string
  readonly expectedReHash: string
  readonly expectedTurnId: string
  readonly frames: ParleyResponseFrame[]
  readonly protocol: 'delegate' | 'query'
  readonly remoteL2PubKey: KeyObject
}

/**
 * Exported for unit testing only. The internal function is async
 * (degraded-completion fallback needs to verify the stream_end signature
 * before accepting it as the implicit seal).
 * @internal
 */
export async function verifyResponseStreamForTest(args: VerifyResponseStreamArgs): Promise<SendParleyQueryResult> {
  return verifyResponseStream(args)
}

async function verifyResponseStream(args: VerifyResponseStreamArgs): Promise<SendParleyQueryResult> {
  // Seq monotonicity check (kimi round-1 HIGH). All server-emitted
  // frames carry strictly increasing seq starting at 1, INCLUDING
  // heartbeats. A gap or regression means the stream was tampered or
  // a frame was dropped/reordered — reject.
  let expectedSeq = 1
  for (const f of args.frames) {
    const {seq} = f as {seq?: number}
    if (seq !== expectedSeq) {
      throw new Error(`STREAM_SEQ_INVALID: expected seq ${expectedSeq}, got ${seq}`)
    }

    expectedSeq += 1
  }

  const seal = args.frames.find((f) => f.kind === 'transcript_seal')
  if (!seal || seal.kind !== 'transcript_seal') {
    // §3.2 Layer A — degraded-completion fallback.
    //
    // The seal is cryptographically signed over the response digest; if it's
    // missing, we do NOT have the integrity binding it provides. However, if:
    //   (a) there is a signed stream_end terminal frame that verifies against
    //       the responder's L2 pub key using the SAME payload binding as the
    //       normal verifyResponseTerminal path (channel_id, delivery_id,
    //       protocol, request_envelope_hash, seq, turn_id, terminal_payload),
    //   (b) stream_end is the LAST non-heartbeat frame (no chunks after it),
    //   (c) at least one agent_message_chunk exists,
    // then we can reconstruct the turn result as "completed but integrity-
    // degraded" — the responder said it's done (via the signed terminal), and
    // the chunks were transported under the same authenticated libp2p session.
    //
    // Strict enforcement: any of these pre-conditions missing → still throw.
    // We never fall back on an unsigned or misbound terminal.
    const streamEndFrame = args.frames.find((f) => f.kind === 'stream_end')
    const chunks = args.frames.filter((f) => f.kind === 'agent_message_chunk')
    // lastNonHeartbeat: stream_end must be the LAST non-heartbeat frame
    const lastNonHeartbeat = [...args.frames].reverse().find((f) => f.kind !== 'heartbeat_ping')

    if (
      streamEndFrame !== undefined &&
      streamEndFrame.kind === 'stream_end' &&
      lastNonHeartbeat?.kind === 'stream_end' &&
      chunks.length > 0
    ) {
      // Verify stream_end using the SAME payload binding as verifyResponseTerminal
      // (codex round-3 constraint: must not under-bind the fallback check).
      const terminalPayload = {
        channel_id: args.expectedChannelId,
        delivery_id: args.expectedDeliveryId,
        protocol: args.protocol,
        request_envelope_hash: args.expectedReHash,
        seq: streamEndFrame.seq,
        terminal_payload: {ended_state: streamEndFrame.ended_state, kind: 'stream_end' as const},
        turn_id: args.expectedTurnId,
      }
      const signatureValid = verifyResponseTerminal(terminalPayload, streamEndFrame.signature, args.remoteL2PubKey)
      if (signatureValid) {
        const content = chunks
          .map((f) => (f as {content: string}).content)
          .join('')
        return {
          content,
          endedState: streamEndFrame.ended_state,
          frames: args.frames,
          integrityDegraded: true,
          ok: true,
          sealOrigin: 'implicit-from-signed-terminal',
        }
      }
    }

    throw new Error('TRANSCRIPT_TERMINAL_MISSING: no transcript_seal frame')
  }

  // Locate the terminal frame (stream_end OR error) immediately before
  // the seal. Per §5.2 it MUST be the last frame before the seal.
  const sealIdx = args.frames.indexOf(seal)
  const terminal = args.frames[sealIdx - 1]
  if (!terminal) {
    throw new Error('TRANSCRIPT_TERMINAL_MISSING: seal has no preceding terminal frame')
  }

  if (terminal.kind !== 'error' && terminal.kind !== 'stream_end') {
    throw new Error(`TRANSCRIPT_TERMINAL_MISSING: frame before seal is ${terminal.kind}, expected error/stream_end`)
  }

  const endedState: 'cancelled' | 'completed' | 'errored' = terminal.kind === 'error' ? 'errored' : terminal.ended_state

  // Verify the terminal frame's individual signature. Both stream_end
  // and error paths are strict-checked (kimi round-1 BLOCKING — the
  // error path was previously a best-effort no-op).
  if (terminal.kind === 'stream_end') {
    const terminalPayload = {
      channel_id: args.expectedChannelId,
      delivery_id: args.expectedDeliveryId,
      protocol: args.protocol,
      request_envelope_hash: args.expectedReHash,
      seq: terminal.seq,
      terminal_payload: {ended_state: terminal.ended_state, kind: 'stream_end' as const},
      turn_id: args.expectedTurnId,
    }
    if (!verifyResponseTerminal(terminalPayload, terminal.signature, args.remoteL2PubKey)) {
      throw new Error('STREAM_END_SIG_INVALID')
    }
  } else {
    // error frame — verify against the EXPECTED request context. The
    // server now binds error terminals to the parsed envelope's real
    // context (kimi round-1 BLOCKING fix), so this check is meaningful
    // for any reject that happened AFTER step 1 (envelope parse).
    //
    // Pre-parse rejects (ENVELOPE_MALFORMED / IMPLEMENTATION_THROW)
    // use a sentinel hash and 'unknown' ids; the dialer cannot tell
    // those apart from a transport drop, but a MITM cannot forge a
    // post-parse code via the pre-parse sentinel either, because the
    // sentinel-bound payload doesn't match the expected request
    // context.
    const errorPayload = {
      channel_id: args.expectedChannelId,
      delivery_id: args.expectedDeliveryId,
      protocol: args.protocol,
      request_envelope_hash: args.expectedReHash,
      seq: terminal.seq,
      terminal_payload: {code: terminal.code, kind: 'error' as const, message: terminal.message},
      turn_id: args.expectedTurnId,
    }
    if (!verifyResponseError(errorPayload, terminal.signature, args.remoteL2PubKey)) {
      // Don't throw — surface the unauthenticated error code so the
      // operator sees SOMETHING. Mark with a synthetic code so the
      // caller can tell it apart from an authenticated reject.
      return {
        code: 'ERROR_TERMINAL_UNAUTHENTICATED',
        frames: args.frames,
        message: `unauthenticated server reject; raw code was ${terminal.code}: ${terminal.message}`,
        ok: false,
      }
    }
  }

  // Recompute transcript_digest over all frames before the seal and
  // compare.
  const expectedDigest = transcriptDigest(args.frames.slice(0, sealIdx))
  if (expectedDigest !== seal.transcript_digest) {
    throw new Error('TRANSCRIPT_DIGEST_MISMATCH')
  }

  // Verify the seal's own signature.
  const sealPayload = {
    channel_id: args.expectedChannelId,
    delivery_id: args.expectedDeliveryId,
    ended_state: endedState,
    protocol: args.protocol,
    request_envelope_hash: args.expectedReHash,
    transcript_digest: seal.transcript_digest,
    turn_id: args.expectedTurnId,
  }
  if (!verifyTranscriptSeal(sealPayload, seal.signature, args.remoteL2PubKey) && // Server-side error path uses sentinel hash + 'unknown' values, so
    // the seal verify fails there too. The terminal `error` frame's
    // own `code`/`message` are still surfaced — the dialer cannot
    // distinguish "MITM forged this error" from "server legitimately
    // rejected" in the unauthenticated path, but in 9.3 the server is
    // the only authority producing frames signed by its L2 key. v2
    // hardens this with a per-rejection per-request signature.
    endedState !== 'errored') {
      throw new Error('TRANSCRIPT_SEAL_SIG_INVALID')
    }

  if (terminal.kind === 'error') {
    return {code: terminal.code, frames: args.frames, message: terminal.message, ok: false}
  }

  const content = args.frames
    .filter((f) => f.kind === 'agent_message_chunk')
    .map((f) => (f as {content: string}).content)
    .join('')

  return {
    content,
    endedState: terminal.ended_state,
    frames: args.frames,
    integrityDegraded: false,
    ok: true,
    sealOrigin: 'explicit',
  }
}

async function encodeLengthPrefixed(bytes: Uint8Array): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  for await (const buf of lp.encode([bytes])) {
    chunks.push(buf.subarray())
  }

  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }

  return out
}

// ─── helpers used in negative tests (publicly exported intentionally) ─────

/**
 * Build a peer_id from a raw Ed25519 pubkey (32 bytes). Re-exported
 * here so the CLI can derive peer_ids from cert payloads it just read
 * off the wire (Slice 9.2 returns the cert; the dialer needs the
 * peer_id to validate transport identity).
 */
export function derivePeerIdFromBase64Pubkey(base64Pub: string): string {
  return derivePeerIdFromRawPublicKey(new Uint8Array(Buffer.from(base64Pub, 'base64')))
}

/**
 * Build a Node KeyObject from a base64 Ed25519 pubkey string. Used by
 * the dialer to construct the verifier key for response frames.
 */
export function l2PubKeyFromBase64(base64Pub: string): KeyObject {
  return createPublicKey({
    format: 'jwk',
    key: {crv: 'Ed25519', kty: 'OKP', x: Buffer.from(base64Pub, 'base64').toString('base64url')},
  })
}
