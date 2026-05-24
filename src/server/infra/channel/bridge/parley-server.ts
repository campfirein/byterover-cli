/* eslint-disable camelcase */
// Wire-shape field names mirror IMPLEMENTATION_PHASE_9 §5.1 + §5.2 on-
// wire JSON and are intentionally snake_case.

import * as lp from 'it-length-prefixed'
import {createHash, type KeyObject} from 'node:crypto'

import {type PeerTreeIdentityService} from '../../../../agent/core/trust/peer-tree-identity-service.js'
import {signResponseError, signResponseTerminal, signTranscriptSeal} from '../../../../agent/core/trust/sign.js'
import {type TofuStore} from '../../../../agent/core/trust/tofu-store.js'
import {BRIDGE_PARLEY_HEARTBEAT_INTERVAL_MS} from '../../../constants.js'
import {
  type ParleyQueryEnvelope,
  type ParleyResponseFrame,
  transcriptDigest,
} from '../../../core/domain/channel/parley-types.js'
import {type BridgeTranscriptService} from './bridge-transcript-service.js'
import {type Libp2pHost, type Libp2pStreamLike} from './libp2p-host.js'
import {type ParleyAdapterRegistry} from './parley-adapter-registry.js'
import {NonceLru} from './parley-nonce-lru.js'
import {HandshakeRateLimiter} from './parley-rate-limit.js'
import {
  mockEchoChunks,
  type ParleyResponseDataChunk,
  ParleyResponseError,
  type ParleyResponseGenerator,
} from './parley-response-generator.js'
import {type CertKind, type TofuPolicy, verifyHandshakeAndPin} from './parley-verifier.js'

/**
 * Phase 9 / Slice 9.3c-iv — `/brv/parley/query/v1` server.
 *
 * Registers a libp2p handler that:
 *   1. Reads one length-prefixed JSON envelope frame from the dialer.
 *   2. Runs the 11-step verifier (§5.1). On reject:
 *      - Records the failure to the rate-limit counter.
 *      - Emits one signed `error` frame + `transcript_seal` per §5.2.
 *   3. On accept, dispatches to the MockEchoHandler and streams
 *      `agent_message_chunk` + signed `stream_end` + `transcript_seal`.
 *
 * The 12-step verifier disclosure resolver is deferred to a later
 * slice; mock-echo doesn't need it.
 *
 * Stream lifecycle: server writes its frames and RETURNS without
 * closing (same libp2p quirk that bit Slice 9.2 — see
 * identity-server.ts file-level comment). The dialer reads its frames
 * then closes.
 */

export const PARLEY_QUERY_PROTOCOL = '/brv/parley/query/v1'

export interface RegisterParleyServerArgs {
  readonly acceptModes: ReadonlyArray<CertKind>
  readonly clockSkewMs?: number
  /**
   * Override the heartbeat ping cadence in milliseconds. Defaults to
   * `BRIDGE_PARLEY_HEARTBEAT_INTERVAL_MS`. Tests use a tiny value (e.g.
   * 50ms) to assert keep-alive behaviour without sleeping the suite
   * for real-time intervals.
   */
  readonly heartbeatIntervalMs?: number
  readonly host: Libp2pHost
  readonly l2Identity: PeerTreeIdentityService
  readonly nonceLru?: NonceLru
  readonly now?: () => Date
  /**
   * Phase 9.5.3 — absolute path to the project the bridge is serving.
   * Passed to `ParleyAdapterContext.projectRoot` so adapters that persist
   * per-project state (e.g. session IDs) can scope their storage correctly.
   * Optional for backwards-compat; adapters that need it should assert it.
   */
  readonly projectRoot?: string
  readonly rateLimiter?: HandshakeRateLimiter
  /**
   * Slice 9.4c — pluggable content generator. When omitted the server
   * falls back to `mockEchoChunks` (echoes the prompt text back as a
   * single `agent_message_chunk`). The daemon wires
   * `localAgentResponseGenerator` here when `BRV_BRIDGE_PARLEY_PROFILE`
   * is configured.
   *
   * Phase 9.5.2 — also accepts a `{registry, profile}` pair. When
   * supplied:
   *   - `profile` is defined and resolves in the registry → use the
   *     adapter's `generate`.
   *   - `profile` is defined but the registry returns `undefined` → the
   *     resolver returns a generator that throws
   *     `ParleyResponseError('PARLEY_ADAPTER_NOT_FOUND', ...)`, surfacing
   *     a signed error terminal to the sender (plan §2.3 strict resolution).
   *   - `profile` is `undefined` → use `mockEchoChunks` (same as today).
   *
   * A raw `ParleyResponseGenerator` is still accepted for backwards
   * compatibility — existing tests and callers keep working unchanged.
   */
  readonly responseGenerator?:
    | ParleyResponseGenerator
    | {readonly profile: string | undefined; readonly registry: ParleyAdapterRegistry}
  readonly tofuPolicy: TofuPolicy
  readonly tofuStore: TofuStore
  /**
   * Slice 9.4e — optional. When provided, the server runs the
   * auto-provision policy gate per §7.3 BEFORE dispatching to the
   * response generator, and persists the inbound prompt + response
   * chunks + terminal events to Bob's local channel store. Rejected
   * envelopes return `CHANNEL_AUTO_PROVISION_DECLINED` to the dialer.
   * When absent, the server runs the legacy (9.4c) path without any
   * Bob-side persistence.
   */
  readonly transcriptService?: BridgeTranscriptService
}

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * Per-request context needed to build a full `ParleyAdapterContext`.
 * Populated from the verified handshake fields after the verifier passes.
 */
interface RequestContext {
  /** AbortController tied to the libp2p stream lifecycle (see `dispatchResponseStream`). */
  readonly abortController: AbortController
  /** Absolute project root for session-id persistence (from `bridgeRuntime.projectRoot`). */
  readonly projectRoot: string
  /** Verified peer ID from the Noise transport handshake. Cannot be spoofed. */
  readonly senderPeerId: string
}

/**
 * Phase 9.5.2 / 9.5.3 — resolve the effective `ParleyResponseGenerator`
 * from the `responseGenerator` option, which may be a raw function, a
 * registry+profile pair, or undefined.
 *
 * Phase 9.5.3: `requestCtx` carries the per-request fields that adapters
 * need for subprocess control and session persistence. The `abortController`
 * is signalled when the libp2p stream closes, the daemon shuts down, or
 * the request is cancelled — replacing the never-aborted stub from 9.5.2.
 *
 * The returned function has the `ParleyResponseGenerator` shape so
 * `dispatchResponseStream` is unchanged.
 */
function resolveGenerator(
  responseGenerator: RegisterParleyServerArgs['responseGenerator'],
  requestCtx: RequestContext,
): ParleyResponseGenerator {
  if (responseGenerator === undefined) {
    return mockEchoChunks
  }

  // Raw function — backwards-compatible path used by existing tests and
  // callers that haven't migrated to the registry yet.
  if (typeof responseGenerator === 'function') {
    return responseGenerator
  }

  // Registry+profile pair.
  const {profile, registry} = responseGenerator
  if (profile === undefined) {
    return mockEchoChunks
  }

  const adapter = registry.resolve(profile)
  if (adapter === undefined) {
    // Explicit profile that doesn't resolve → surface a signed error
    // terminal to the sender rather than silently falling back to echo.
    // The parley-server owns terminal seal emission; throw here so
    // dispatchResponseStream projects it as PARLEY_ADAPTER_NOT_FOUND.
    // (codex round-2 MUST-FIX — plan §2.3)
    const names = registry
      .list()
      .map((a) => `"${a.profile}"`)
      .join(', ')
    return () => {
      throw new ParleyResponseError(
        'PARLEY_ADAPTER_NOT_FOUND',
        `Parley adapter profile "${profile}" is not registered. Available: [${names || 'none'}].`,
      )
    }
  }

  // Wrap the adapter's generate() in the ParleyResponseGenerator shape.
  // Phase 9.5.3: real senderPeerId, projectRoot, and abortSignal are
  // wired in here (replaces the never-aborted stub from 9.5.2).
  return ({envelope}) =>
    adapter.generate({
      abortSignal: requestCtx.abortController.signal,
      channelId: envelope.channel_id,
      envelope,
      logger(msg) {
        console.debug(`[parley:${profile}] ${msg}`)
      },
      memberHandle: envelope.handshake.install_cert.display_handle ?? '',
      projectRoot: requestCtx.projectRoot,
      senderPeerId: requestCtx.senderPeerId,
      turnId: envelope.turn_id,
    })
}

export async function registerParleyServer(args: RegisterParleyServerArgs): Promise<void> {
  const nonceLru = args.nonceLru ?? new NonceLru()
  const rateLimiter = args.rateLimiter ?? new HandshakeRateLimiter()
  const now = args.now ?? (() => new Date())
  const clockSkewMs = args.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS

  await args.host.handle(PARLEY_QUERY_PROTOCOL, async (stream) => {
    const transportPeerId = stream.remotePeerId

    // Pre-flight: if the dialer is already rate-limited, do not even
    // read their envelope. The libp2p connection will be hung up by
    // the bad-sig counter elsewhere; this just short-circuits the
    // handler.
    if (rateLimiter.isBlocked(transportPeerId)) return

    const envelope = await readOneEnvelope(stream)
    if (envelope === undefined) {
      // Dialer hung up before sending a frame — nothing to do, no
      // policy reject to signal. Rate-limit considers this a failure
      // so a peer can't slow-loris us.
      rateLimiter.recordFailure(transportPeerId)
      return
    }

    let verifyResult: Awaited<ReturnType<typeof verifyHandshakeAndPin>>
    try {
      verifyResult = await verifyHandshakeAndPin({
        acceptModes: args.acceptModes,
        clockSkewMs,
        envelope,
        nonceLru,
        now: now(),
        tofuPolicy: args.tofuPolicy,
        tofuStore: args.tofuStore,
        transportPeerId,
      })
    } catch (error) {
      rateLimiter.recordFailure(transportPeerId)
      const msg = error instanceof Error ? error.message : String(error)
      await writeErrorTerminal({
        code: 'IMPLEMENTATION_THROW',
        context: undefined,
        l2Identity: args.l2Identity,
        message: msg,
        stream,
      })
      return
    }

    if (!verifyResult.ok) {
      rateLimiter.recordFailure(transportPeerId)
      // Bind the error terminal to the REAL request context when the
      // envelope parsed (kimi round-1 BLOCKING). Only ENVELOPE_MALFORMED
      // / IMPLEMENTATION_THROW pre-parse paths fall back to sentinel.
      const context =
        verifyResult.envelope === undefined || verifyResult.requestEnvelopeHash === undefined
          ? undefined
          : {
              channel_id: verifyResult.envelope.channel_id,
              delivery_id: verifyResult.envelope.delivery_id,
              protocol: verifyResult.envelope.protocol,
              request_envelope_hash: verifyResult.requestEnvelopeHash,
              turn_id: verifyResult.envelope.turn_id,
            }
      await writeErrorTerminal({
        code: verifyResult.reason,
        context,
        l2Identity: args.l2Identity,
        message: `verifier rejected: ${verifyResult.reason}`,
        stream,
      })
      return
    }

    const l2 = await args.l2Identity.loadOrGenerate()

    // Phase 9.5.3 — create the per-request AbortController that is
    // signalled when the response stream ends (success, error, or cancel).
    // This replaces the never-aborted stub from 9.5.2 so adapters that
    // spawn subprocesses (ClaudeCodeHeadlessAdapter) can kill them on
    // stream close / Alice-side Ctrl-C / daemon shutdown.
    const requestAbortController = new AbortController()

    const requestCtx: RequestContext = {
      abortController: requestAbortController,
      projectRoot: args.projectRoot ?? '',
      senderPeerId: transportPeerId,
    }

    const generator = resolveGenerator(args.responseGenerator, requestCtx)

    // Slice 9.4e — auto-provision policy gate. When the transcript
    // service is wired, ask it to decide whether to accept this
    // envelope BEFORE dispatching to the local agent. Rejected
    // envelopes throw `CHANNEL_AUTO_PROVISION_DECLINED` via the
    // generator-error path so the dialer sees a signed `error`
    // terminal with the bound context.
    let transcriptContext: undefined | {deliveryId: string; mirrorHandle: string}
    if (args.transcriptService !== undefined) {
      const beginResult = await args.transcriptService.beginTurn({
        channelId: verifyResult.envelope.channel_id,
        prompt: verifyResult.envelope.prompt,
        senderDisplayHandle: verifyResult.envelope.handshake.install_cert.display_handle,
        senderPeerId: transportPeerId,
        senderPinState: verifyResult.pinned.pin_state,
        turnId: verifyResult.envelope.turn_id,
      })
      if (!beginResult.accepted) {
        // kimi round-1 HIGH-2 — do NOT bump the handshake rate limiter
        // on policy decline. The verifier already passed; rejecting on
        // §7.3 policy is an AUTHORISATION concern, not an
        // authentication/DoS one. Counting it here would burst-disconnect
        // legitimate peers that simply haven't been promoted from
        // `auto-tofu` to `user-confirmed` yet.
        await writeErrorTerminal({
          code: 'CHANNEL_AUTO_PROVISION_DECLINED',
          context: {
            channel_id: verifyResult.envelope.channel_id,
            delivery_id: verifyResult.envelope.delivery_id,
            protocol: verifyResult.envelope.protocol,
            request_envelope_hash: verifyResult.requestEnvelopeHash,
            turn_id: verifyResult.envelope.turn_id,
          },
          l2Identity: args.l2Identity,
          message: beginResult.reason,
          stream,
        })
        return
      }

      transcriptContext = {deliveryId: beginResult.deliveryId, mirrorHandle: beginResult.mirrorHandle}
    }

    await dispatchResponseStream({
      envelope: verifyResult.envelope,
      generator,
      heartbeatIntervalMs: args.heartbeatIntervalMs ?? BRIDGE_PARLEY_HEARTBEAT_INTERVAL_MS,
      l2PrivateKey: l2.privateKey,
      requestAbortController,
      requestEnvelopeHash: verifyResult.requestEnvelopeHash,
      stream,
      transcriptContext,
      transcriptService: args.transcriptService,
    })
    // Do NOT close — dialer closes after reading. See file-level
    // comment.
  })
}

export interface DispatchResponseStreamArgs {
  readonly envelope: ParleyQueryEnvelope
  readonly generator: ParleyResponseGenerator
  readonly heartbeatIntervalMs: number
  readonly l2PrivateKey: KeyObject
  /**
   * Phase 9.5.3 — AbortController whose signal is wired to
   * `ParleyAdapterContext.abortSignal`. Signalled in the `finally` block
   * so adapters that spawn subprocesses can SIGTERM them on stream close.
   * When absent (legacy/test callers), no signal is fired.
   */
  readonly requestAbortController?: AbortController
  readonly requestEnvelopeHash: string
  readonly stream: Libp2pStreamLike
  readonly transcriptContext?: {deliveryId: string; mirrorHandle: string}
  readonly transcriptService?: BridgeTranscriptService
}

/**
 * Drive the `responseGenerator`, project each chunk into a Parley
 * response frame with a fresh seq, append the signed
 * `stream_end` + `transcript_seal` once the generator returns
 * cleanly, OR project any thrown error as a signed `error` +
 * `transcript_seal` per §5.2 normative terminal order.
 *
 * Emits `heartbeat_ping` frames at `BRIDGE_PARLEY_HEARTBEAT_INTERVAL_MS`
 * cadence while the generator is idle so the libp2p Yamux substream
 * does not hit its idle timeout when the responding agent is mid-LLM-
 * call (e.g. codex waiting between bash `brv curate` invocations).
 * The wire schema specifies heartbeats; `transcriptDigest` and
 * `audit-parley-seal.ts` filter them so they do not perturb the seal.
 *
 * The heartbeat timer is CANCELLED before emitting the terminal
 * (`stream_end` / `error`) and the `sendChain` is drained, so the
 * pre-seal-1 frame is guaranteed to be the terminal — `parley-client.ts`
 * picks the terminal by `sealIdx - 1`, not by kind-filter.
 */
// Exported for unit tests only — not part of the public API.
export async function dispatchResponseStream(args: DispatchResponseStreamArgs): Promise<void> {
  const {
    envelope,
    generator,
    heartbeatIntervalMs,
    l2PrivateKey,
    requestAbortController,
    requestEnvelopeHash,
    stream,
    transcriptContext,
    transcriptService,
  } = args
  const emittedFrames: ParleyResponseFrame[] = []
  let seq = 0
  const nextSeq = () => {
    seq += 1
    return seq
  }

  // Sequential send queue — serializes the heartbeat-timer's writes and
  // the chunk-loop's writes so two `stream.send()` calls cannot
  // interleave bytes mid-frame on the Yamux substream. The seq number
  // is assigned INSIDE the lock so monotonicity is preserved even when
  // a heartbeat is scheduled between two chunk frames.
  let sendChain: Promise<void> = Promise.resolve()
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined
  // kimi-flagged race (post-merge code review) — a heartbeat callback
  // already enqueued in `sendChain` when we call `stopHeartbeats()` MUST
  // bail synchronously so it cannot emit between the last data chunk
  // and the terminal frame. Microtask ordering guarantees the flag we
  // set in `stopHeartbeats()` is visible to any heartbeat `.then()`
  // body that has not yet started executing.
  let terminalQueued = false

  // kimi round-1 HIGH-3 — assume the worst (errored) so the finally
  // path cleans up `inFlight`/`seqByTurn` even if BOTH the success
  // path AND the catch block throw before we can update this. The
  // success path overwrites with `completed`; the catch block
  // overwrites with the real error code.
  let finalState: {endedState: 'completed' | 'errored'; error?: {code: string; message: string}} = {
    endedState: 'errored',
    error: {code: 'GENERATOR_ERROR', message: 'Stream terminated before terminal frame'},
  }

  // Drain + cancel the heartbeat timer. Idempotent. Called before the
  // terminal frame on both the success and error paths so the
  // pre-seal-1 frame is guaranteed to be the terminal.
  const stopHeartbeats = async (): Promise<void> => {
    terminalQueued = true
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }

    await sendChain.catch(() => {
      /* drain — caller will surface any real send error on its own next emit */
    })
  }

  try {
    // Emit `heartbeat_ping` frames every BRIDGE_PARLEY_HEARTBEAT_INTERVAL_MS
    // to keep the libp2p Yamux substream alive while the generator is
    // idle. Heartbeats are excluded from the transcript digest and from
    // the audit-side terminal lookup, so they perturb nothing on the
    // wire contract.
    heartbeatTimer = setInterval(() => {
      sendChain = sendChain
        .then(async () => {
          // kimi-flagged race — bail if `stopHeartbeats()` has been
          // called between the time this callback was enqueued and the
          // time the chain executes it, so we never emit a heartbeat
          // after the terminal has been queued.
          if (terminalQueued) return
          const frame: ParleyResponseFrame = {kind: 'heartbeat_ping', seq: nextSeq()}
          await sendFrame(stream, frame)
        })
        .catch((error) => {
          // Fix 9.5.3 (codex K79P0sTCkPTOaaZefPoh1 Fix 1a): heartbeat send
          // failure means the libp2p substream is dead. Abort EARLY so
          // adapters that spawned subprocesses (ClaudeCodeHeadlessAdapter)
          // get SIGTERMed immediately, not after the generator unwinds.
          if (!terminalQueued) {
            const msg = error instanceof Error ? error.message : String(error)
            console.warn(`[parley] heartbeat send failed for turn ${envelope.turn_id}: ${msg} — aborting request`)
            requestAbortController?.abort()
          }
        })
    }, heartbeatIntervalMs)

    try {
      for await (const chunk of generator({envelope})) {
        // kimi round-1 MED-8 — persist BEFORE emit so a local disk
        // error aborts the turn before Alice sees a ghost chunk. A
        // slow `eventsWriter.append` does block frame emission; that
        // is the intended ordering for a transcript-of-record path
        // (we want Bob's history to be the truth, not Alice's).
        //
        // Wrapped in `sendChain` so seq assignment + send happen inside
        // the write mutex, preventing reorder against heartbeats.
        const chunkRef = chunk
        const emit = sendChain.then(async () => {
          const frame = projectChunkToFrame(chunkRef, nextSeq())
          emittedFrames.push(frame)
          if (transcriptService !== undefined && transcriptContext !== undefined) {
            await transcriptService.recordChunk({
              channelId: envelope.channel_id,
              chunk: chunkRef,
              deliveryId: transcriptContext.deliveryId,
              memberHandle: transcriptContext.mirrorHandle,
              turnId: envelope.turn_id,
            })
          }

          await sendFrame(stream, frame)
        })
        sendChain = emit.catch((error) => {
          // Fix 9.5.3 (codex K79P0sTCkPTOaaZefPoh1 Fix 1b): stream-write
          // failure means the receiver is gone. Abort EARLY so the adapter
          // subprocess (if any) gets SIGTERMed before the generator unwinds.
          if (!terminalQueued) {
            const msg = error instanceof Error ? error.message : String(error)
            console.warn(`[parley] sendFrame failed for turn ${envelope.turn_id}: ${msg} — aborting request`)
            requestAbortController?.abort()
          }
        })
        await emit
      }
    } catch (error) {
      await stopHeartbeats()

      // Extract a stable code + a SAFE public message from the thrown
      // value (kimi round-1 MEDIUMs). Generators using
      // `ParleyResponseError` carry an authoritative code + a message
      // they marked safe-to-expose. Anything else gets a generic code +
      // a generic message; the original details are logged locally so
      // the operator can still debug.
      let code = 'GENERATOR_ERROR'
      let publicMessage = 'Internal generator error'
      if (error instanceof ParleyResponseError) {
        code = error.code
        publicMessage = error.message
      }

      const localDetails = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.warn(`[parley] generator failed for turn ${envelope.turn_id}: ${localDetails}`)
      finalState = {endedState: 'errored', error: {code, message: publicMessage}}

      const errorFrame = buildErrorTerminalFrame({
        bound: contextFromEnvelope(envelope, requestEnvelopeHash),
        code,
        l2PrivateKey,
        message: publicMessage,
        seq: nextSeq(),
      })
      emittedFrames.push(errorFrame)
      await sendFrame(stream, errorFrame)
      try {
        await sendFrame(
          stream,
          buildTranscriptSealFrame({
            bound: contextFromEnvelope(envelope, requestEnvelopeHash),
            endedState: 'errored',
            frames: emittedFrames,
            l2PrivateKey,
            seq: nextSeq(),
          }),
        )
      } catch (error_) {
        // §3.2 Layer B — diagnostic seal-send. Seal loss is logged but NOT
        // re-thrown: work product is on disk; the dialer's implicit-seal
        // fallback (Layer A) covers the wire-level failure.
        console.warn(
          `[parley-server] Failed to send transcript_seal frame (error path) for turn=${envelope.turn_id} ` +
          `(channelId=${envelope.channel_id}): ` +
          `${error_ instanceof Error ? error_.message : String(error_)}. ` +
          `Stream likely torn down by dialer; work product is on disk.`,
        )
      }

      return
    }

    await stopHeartbeats()

    // Success path — emit signed stream_end + transcript_seal.
    const terminal = buildStreamEndTerminalFrame({
      bound: contextFromEnvelope(envelope, requestEnvelopeHash),
      endedState: 'completed',
      l2PrivateKey,
      seq: nextSeq(),
    })
    emittedFrames.push(terminal)
    await sendFrame(stream, terminal)

    try {
      await sendFrame(
        stream,
        buildTranscriptSealFrame({
          bound: contextFromEnvelope(envelope, requestEnvelopeHash),
          endedState: 'completed',
          frames: emittedFrames,
          l2PrivateKey,
          seq: nextSeq(),
        }),
      )
    } catch (error) {
      // §3.2 Layer B — diagnostic seal-send. Seal loss is logged but NOT
      // re-thrown: work product is on disk; the dialer's implicit-seal
      // fallback (Layer A) covers the wire-level failure.
      console.warn(
        `[parley-server] Failed to send transcript_seal frame (success path) for turn=${envelope.turn_id} ` +
        `(channelId=${envelope.channel_id}): ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Stream likely torn down by dialer; work product is on disk.`,
      )
    }

    finalState = {endedState: 'completed'}
  } finally {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = undefined
    }

    // Phase 9.5.3 — signal the per-request AbortController so adapters
    // that spawned subprocesses (ClaudeCodeHeadlessAdapter) can SIGTERM
    // them. Fires on success, error, and cancel paths alike.
    requestAbortController?.abort()

    if (transcriptService !== undefined && transcriptContext !== undefined) {
      try {
        await transcriptService.finaliseTurn({
          channelId: envelope.channel_id,
          deliveryId: transcriptContext.deliveryId,
          endedState: finalState.endedState,
          memberHandle: transcriptContext.mirrorHandle,
          turnId: envelope.turn_id,
          ...(finalState.error === undefined ? {} : {error: finalState.error}),
        })
      } catch (finaliseError) {
        // Last-resort: don't let a transcript-persistence error mask
        // the in-flight terminal frame outcome — log + swallow so the
        // dialer still sees the seal we already emitted.
        const details =
          finaliseError instanceof Error
            ? (finaliseError.stack ?? finaliseError.message)
            : String(finaliseError)
        console.warn(`[parley] finaliseTurn failed for turn ${envelope.turn_id}: ${details}`)
      }
    }
  }
}

// Must stay in sync with `ParleyResponseDataChunk` — when 9.9 widens
// the chunk vocabulary with tool-call / permission-request variants,
// this projection grows new branches.
function projectChunkToFrame(chunk: ParleyResponseDataChunk, seq: number): ParleyResponseFrame {
  return {content: chunk.content, kind: chunk.kind, seq}
}

interface BoundContext {
  readonly channel_id: string
  readonly delivery_id: string
  readonly protocol: 'delegate' | 'query'
  readonly request_envelope_hash: string
  readonly turn_id: string
}

function contextFromEnvelope(envelope: ParleyQueryEnvelope, requestEnvelopeHash: string): BoundContext {
  return {
    channel_id: envelope.channel_id,
    delivery_id: envelope.delivery_id,
    protocol: envelope.protocol,
    request_envelope_hash: requestEnvelopeHash,
    turn_id: envelope.turn_id,
  }
}

interface BuildTerminalArgs {
  readonly bound: BoundContext
  readonly endedState: 'cancelled' | 'completed'
  readonly l2PrivateKey: KeyObject
  readonly seq: number
}

function buildStreamEndTerminalFrame(args: BuildTerminalArgs): ParleyResponseFrame {
  const payload = {
    channel_id: args.bound.channel_id,
    delivery_id: args.bound.delivery_id,
    protocol: args.bound.protocol,
    request_envelope_hash: args.bound.request_envelope_hash,
    seq: args.seq,
    terminal_payload: {ended_state: args.endedState, kind: 'stream_end' as const},
    turn_id: args.bound.turn_id,
  }
  return {
    ended_state: args.endedState,
    kind: 'stream_end',
    seq: args.seq,
    signature: signResponseTerminal(payload, args.l2PrivateKey),
  }
}

interface BuildErrorTerminalArgs {
  readonly bound: BoundContext
  readonly code: string
  readonly l2PrivateKey: KeyObject
  readonly message: string
  readonly seq: number
}

function buildErrorTerminalFrame(args: BuildErrorTerminalArgs): ParleyResponseFrame {
  const payload = {
    channel_id: args.bound.channel_id,
    delivery_id: args.bound.delivery_id,
    protocol: args.bound.protocol,
    request_envelope_hash: args.bound.request_envelope_hash,
    seq: args.seq,
    terminal_payload: {code: args.code, kind: 'error' as const, message: args.message},
    turn_id: args.bound.turn_id,
  }
  return {
    code: args.code,
    kind: 'error',
    message: args.message,
    seq: args.seq,
    signature: signResponseError(payload, args.l2PrivateKey),
  }
}

interface BuildSealArgs {
  readonly bound: BoundContext
  readonly endedState: 'cancelled' | 'completed' | 'errored'
  readonly frames: ParleyResponseFrame[]
  readonly l2PrivateKey: KeyObject
  readonly seq: number
}

function buildTranscriptSealFrame(args: BuildSealArgs): ParleyResponseFrame {
  const digest = transcriptDigest(args.frames)
  const payload = {
    channel_id: args.bound.channel_id,
    delivery_id: args.bound.delivery_id,
    ended_state: args.endedState,
    protocol: args.bound.protocol,
    request_envelope_hash: args.bound.request_envelope_hash,
    transcript_digest: digest,
    turn_id: args.bound.turn_id,
  }
  return {
    kind: 'transcript_seal',
    seq: args.seq,
    signature: signTranscriptSeal(payload, args.l2PrivateKey),
    transcript_digest: digest,
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

async function readOneEnvelope(stream: Libp2pStreamLike): Promise<undefined | unknown> {
  // Same async-iterator dance used in identity-client to pull exactly
  // ONE length-prefixed frame off a duplex stream.
  const iter = lp.decode(stream as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
  const first = await iter.next()
  if (first.done) return undefined
  const bytes = first.value.subarray()
  const json = new TextDecoder('utf8').decode(bytes)
  try {
    return JSON.parse(json)
  } catch {
    return null  // null distinguishes "parse failed" from "stream EOF"
  }
}

async function sendFrame(stream: Libp2pStreamLike, frame: ParleyResponseFrame): Promise<void> {
  const json = JSON.stringify(frame)
  const bytes = new TextEncoder().encode(json)
  const framed = await encodeLengthPrefixed(bytes)
  await stream.send(framed)
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

/**
 * Request context the verifier was able to extract from a parsed
 * envelope. When `undefined`, the envelope did not parse and the
 * server falls back to a sentinel hash for the error-terminal
 * signature (the dialer cannot authenticate these — kimi round-1
 * documented as the irreducible "indistinguishable from transport
 * drop" path).
 */
export interface ErrorTerminalContext {
  readonly channel_id: string
  readonly delivery_id: string
  readonly protocol: 'delegate' | 'query'
  readonly request_envelope_hash: string
  readonly turn_id: string
}

interface WriteErrorTerminalArgs {
  readonly code: string
  readonly context: ErrorTerminalContext | undefined
  readonly l2Identity: PeerTreeIdentityService
  readonly message: string
  readonly stream: Libp2pStreamLike
}

async function writeErrorTerminal(args: WriteErrorTerminalArgs): Promise<void> {
  const {code, context, l2Identity, message, stream} = args
  const l2 = await l2Identity.loadOrGenerate()
  // Bind signatures to the real request context when the envelope was
  // parsed. Only the no-parse path falls back to a sentinel hash + the
  // 'unknown' placeholder ids (kimi round-1 BLOCKING fix).
  const sentinelHash = createHash('sha256').update('NO_REQUEST_HASH', 'utf8').digest('hex')
  const bound = context ?? {
    channel_id: 'unknown',
    delivery_id: 'unknown',
    protocol: 'query' as const,
    request_envelope_hash: sentinelHash,
    turn_id: 'unknown',
  }

  const errorFramePayload = {
    channel_id: bound.channel_id,
    delivery_id: bound.delivery_id,
    protocol: bound.protocol,
    request_envelope_hash: bound.request_envelope_hash,
    seq: 1,
    terminal_payload: {code, kind: 'error' as const, message},
    turn_id: bound.turn_id,
  }
  const errorFrame: ParleyResponseFrame = {
    code,
    kind: 'error',
    message,
    seq: 1,
    signature: signResponseError(errorFramePayload, l2.privateKey),
  }

  const digest = transcriptDigest([errorFrame])
  const sealPayload = {
    channel_id: bound.channel_id,
    delivery_id: bound.delivery_id,
    ended_state: 'errored',
    protocol: bound.protocol,
    request_envelope_hash: bound.request_envelope_hash,
    transcript_digest: digest,
    turn_id: bound.turn_id,
  }
  const seal: ParleyResponseFrame = {
    kind: 'transcript_seal',
    seq: 2,
    signature: signTranscriptSeal(sealPayload, l2.privateKey),
    transcript_digest: digest,
  }

  await sendFrame(stream, errorFrame)
  await sendFrame(stream, seal)
}
