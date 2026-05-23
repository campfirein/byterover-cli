import {type ParleyQueryEnvelope} from '../../../core/domain/channel/parley-types.js'
import {type ParleyResponseDataChunk} from './parley-response-generator.js'

/**
 * Phase 9 / Phase 9.5.2 — typed adapter interface for pluggable parley
 * response generators.
 *
 * Formalises the de-facto adapter shape that already existed as
 * `ParleyResponseGenerator` (an async generator function). Adapters are
 * registered by profile name in a `ParleyAdapterRegistry` and resolved
 * at daemon startup. The parley-server's behaviour is identical to pre-
 * refactor; only the wiring path changes.
 *
 * Phase 9.5.3 — `ClaudeCodeHeadlessAdapter` added.
 * `ShellTemplateAdapter` deferred to a later phase.
 */

export interface AdapterWarmArgs {
  readonly log: (msg: string) => void
}

/**
 * Typed availability result for `warm()` (plan §2.2 / codex round-1).
 *
 * Returning `{available: false, reason}` lets the daemon log a clear
 * message and surface it via `brv channel doctor` without throwing.
 * Throwing is reserved for hard failures (corrupt state, etc.).
 */
export type AdapterWarmResult =
  | {readonly available: false; readonly reason: string}
  | {readonly available: true}

export interface ParleyAdapterContext {
  /**
   * Stream-lifecycle signal. MUST be the real signal tied to the libp2p
   * substream, not a never-aborted stub. Fires when the dialer closes,
   * the daemon shuts down, or the request is cancelled. Adapters that
   * spawn subprocesses MUST wire this to a SIGTERM on the child.
   */
  readonly abortSignal: AbortSignal
  readonly channelId: string
  readonly envelope: ParleyQueryEnvelope
  readonly logger: (msg: string) => void
  /** The sender's display handle, e.g. `@laptop`. May be empty — do NOT use as a persistence key. */
  readonly memberHandle: string
  /**
   * Absolute path to the project the channel is scoped to.
   * Used as part of the composite session-id key for adapters that
   * maintain per-project state (e.g. ClaudeCodeHeadlessAdapter).
   */
  readonly projectRoot: string
  /**
   * Verified peer ID from the parley handshake (Noise transport layer).
   * Cannot be spoofed by the application layer.
   * Use this (not `memberHandle`) as the persistent identity key.
   */
  readonly senderPeerId: string
  readonly turnId: string
}

export interface ParleyAdapter {
  /**
   * Produce response chunks for a single inbound parley query.
   * Implementations MUST NOT touch the channel store; the parley-server
   * handles transcript writes through BridgeTranscriptService.
   * On terminal failure throw `ParleyResponseError(code, message)`.
   * Adapters MUST NOT emit `transcript_seal` directly.
   */
  generate(args: ParleyAdapterContext): AsyncIterable<ParleyResponseDataChunk>

  /** Discriminator used by `brv channel doctor` and startup logs. */
  readonly kind: 'acp' | 'mock' | 'sdk-headless' | 'shell-template'

  /**
   * Stable profile name — used by `BRV_BRIDGE_PARLEY_PROFILE` and
   * `brv channel invite --profile <name>`.
   */
  readonly profile: string

  /** Optional lifecycle hooks for pool-managed adapters. */
  shutdown?(): Promise<void>
  /**
   * Optional warm-up. Returns a typed availability result. If the adapter
   * can't run (e.g. the `claude` binary is missing on PATH), return
   * `{available: false, reason}`. The daemon logs this at startup and
   * `brv channel doctor` surfaces it. Throwing is allowed for hard failures.
   */
  warm?(args: AdapterWarmArgs): Promise<AdapterWarmResult>
}
