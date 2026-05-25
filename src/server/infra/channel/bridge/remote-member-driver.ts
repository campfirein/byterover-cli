/* eslint-disable camelcase */
// `channel_id` / `turn_id` / `delivery_id` etc. mirror IMPLEMENTATION_PHASE_9
// §5.1 envelope shape and are intentionally snake_case on the wire.

import type {KeyObject} from 'node:crypto'

import {type InstallIdentityService} from '../../../../agent/core/trust/install-identity-service.js'
import {type PeerTreeIdentityService} from '../../../../agent/core/trust/peer-tree-identity-service.js'
import {
  type AcpDriverPromptArgs,
  type AcpDriverStatus,
  type AcpInitializeSnapshot,
  type IAcpDriver,
  type TurnEventPayload,
} from '../../../core/interfaces/channel/i-acp-driver.js'
import {type Libp2pHost} from './libp2p-host.js'
import {sendParleyQuery as defaultSendParleyQuery, l2PubKeyFromBase64, type SendParleyQueryArgs, type SendParleyQueryResult} from './parley-client.js'
import {parseParleyTimeoutEnv} from './parley-timeout-config.js'
import {PhaseStampedAbort} from './phase-stamped-abort.js'

/**
 * Phase 9.5.4 — enrich a dial-failure error with a copy-paste-ready recovery
 * hint when the cached multiaddr came from a one-time inbound dial
 * (addressability='bootstrap-only').
 *
 * Exported for unit testing only.
 */
export function enrichDialFailureError(args: {
  readonly addressability: 'bootstrap-only' | 'inbound-only' | 'pinned' | undefined
  readonly channelId: string
  readonly multiaddr: string
  readonly originalMessage: string
}): Error {
  if (args.addressability !== 'bootstrap-only') {
    return new Error(args.originalMessage)
  }

  const hint = [
    `BRIDGE_DIAL_FAILED: connection refused at ${args.multiaddr}`,
    '',
    "The cached multiaddr came from a one-time inbound (addressability='bootstrap-only').",
    'The remote peer may have rebound on a new port.',
    '',
    'Recovery:',
    `  brv bridge connect <fresh-multiaddr> --channel ${args.channelId}`,
    '',
    "Get the fresh multiaddr from the remote peer via 'brv bridge whoami'.",
  ].join('\n')
  return new Error(hint)
}

/**
 * Phase 9 / Slice 9.4 — `IAcpDriver` adapter for remote-peer channel
 * members.
 *
 * Wraps the slice 9.3 Parley client as a driver the existing
 * `ChannelOrchestrator` + `AcpDriverPool` can dispatch to without
 * knowing the member is remote. Each `prompt()` call opens a fresh
 * `/brv/parley/query/v1` stream, sends a signed envelope, projects the
 * response frames into `TurnEventPayload`s, and finishes.
 *
 * 9.4a scope:
 *   - Read-only Q&A only (no permission flow; mock-echo doesn't request).
 *   - Cancel is a stub — propagating cancel to Bob is slice 9.9.
 *   - No persistent libp2p connection per driver; host lifetime is
 *     owned by the daemon, passed in via deps.
 *   - L2 pubkey passed in as base64 (out-of-band 9.3 seam); 9.4b will
 *     read it from an in-band cert resolver.
 *
 * Lifecycle: `start()` is a no-op (no subprocess to spawn). `stop()` is
 * a no-op (the host is owned externally). Statuses transition
 * `stopped → idle` on start, `idle ↔ streaming` per prompt, `errored`
 * on any thrown error.
 */
export interface RemoteMemberDriverDeps {
  /**
   * Injectable sendParleyQuery implementation — used for unit testing the
   * timeout/abort behavior without ES-module stubbing. Defaults to the
   * real `sendParleyQuery` from parley-client.ts.
   * @internal
   */
  readonly _sendParleyQuery?: (args: SendParleyQueryArgs) => Promise<SendParleyQueryResult>
  readonly channelId: string
  readonly handle: string
  readonly host: Libp2pHost
  readonly install: InstallIdentityService
  readonly l2Identity: PeerTreeIdentityService
  readonly multiaddr: string
  readonly peerId: string
  /**
   * Phase 9.5.9 Issue 3b — persisted timeout values from bridge-config.json.
   * Precedence at prompt() time: env > persisted > default.
   * Pass `bridgeRuntime.parleyDialTimeoutMs` / `parleyTurnIdleTimeoutMs`
   * from the daemon startup so a respawn without BRV_BRIDGE_PARLEY_*_MS
   * in env still respects the persisted values.
   */
  readonly persistedTimeouts?: {
    readonly dialTimeoutMs?: number
    readonly idleTimeoutMs?: number
  }
  readonly remoteL2PubKey: string
}

export class RemoteMemberDriver implements IAcpDriver {
  public readonly acpInitialize: AcpInitializeSnapshot | undefined = undefined
  public readonly capabilities: string[] = ['text']
  public readonly handle: string
  public readonly protocolVersion: number | undefined = undefined
  private readonly channelId: string
  private readonly host: Libp2pHost
  private readonly install: InstallIdentityService
  private readonly l2Identity: PeerTreeIdentityService
  private readonly multiaddr: string
  private readonly peerId: string
  private readonly persistedTimeouts: {readonly dialTimeoutMs?: number; readonly idleTimeoutMs?: number}
  private readonly remoteL2PubKey: KeyObject
  private readonly sendParleyQueryFn: (args: SendParleyQueryArgs) => Promise<SendParleyQueryResult>
  private statusValue: AcpDriverStatus = 'stopped'

  public constructor(deps: RemoteMemberDriverDeps) {
    this.handle = deps.handle
    this.channelId = deps.channelId
    this.host = deps.host
    this.install = deps.install
    this.l2Identity = deps.l2Identity
    this.multiaddr = deps.multiaddr
    this.peerId = deps.peerId
    this.persistedTimeouts = deps.persistedTimeouts ?? {}
    this.remoteL2PubKey = l2PubKeyFromBase64(deps.remoteL2PubKey)
    this.sendParleyQueryFn = deps._sendParleyQuery ?? defaultSendParleyQuery
  }

  /**
   * Expose the peer_id for diagnostic use (e.g. `brv channel show` can
   * label remote-peer members with their bound peer_id).
   */
  public get remotePeerId(): string {
    return this.peerId
  }

  public get status(): AcpDriverStatus {
    return this.statusValue
  }

  public async cancel(_turnId?: string): Promise<void> {
    // Slice 9.4a — cancel propagation to Bob is deferred to 9.9
    // (Parley client-frame `cancel`). Marking the driver back to idle
    // locally so the orchestrator doesn't think a turn is still
    // in-flight after the operator hits Esc.
    // TODO(9.9): propagate cancel over Parley as a signed `cancel`
    // client-frame so Bob's daemon can terminate the in-flight echo /
    // ACP run.
    this.statusValue = 'idle'
  }

  public async probeSession(): Promise<boolean> {
    // Remote peers have no ACP `session/new` to probe; the driver is
    // dial-per-turn. Surfacing `true` lets Phase-3 onboarding treat
    // remote-peer members as a known-good driver class.
    return true
  }

  public async *prompt(args: AcpDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
    this.statusValue = 'streaming'

    // Phase 9.5.7 §3.3 Layer A — split timeouts.
    // Issue 3b fix: precedence is env > persisted > default.
    // Parse env at prompt() time so live env changes between turns are
    // respected (matches bridge-config-store.ts precedence pattern).
    const envTimeouts = parseParleyTimeoutEnv(process.env)
    // env values from parseParleyTimeoutEnv already fall back to defaults
    // internally, so we must check the raw env to distinguish "env set" from
    // "env absent, default applied".  Use the persisted value only when the
    // raw env var is unset.
    const dialTimeoutMs =
      process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS !== undefined && process.env.BRV_BRIDGE_PARLEY_DIAL_TIMEOUT_MS.trim() !== ''
        ? envTimeouts.dialTimeoutMs                  // env wins
        : (this.persistedTimeouts.dialTimeoutMs ?? envTimeouts.dialTimeoutMs)  // persisted > default
    const idleTimeoutMs =
      process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS !== undefined && process.env.BRV_BRIDGE_PARLEY_TURN_IDLE_TIMEOUT_MS.trim() !== ''
        ? envTimeouts.idleTimeoutMs                  // env wins
        : (this.persistedTimeouts.idleTimeoutMs ?? envTimeouts.idleTimeoutMs)  // persisted > default

    // Issue 1 fix: two separate AbortControllers — one for dial phase, one
    // for idle/no-progress detection. The dial AbortController aborts as soon
    // as dialTimeoutMs elapses WITHOUT a response from onDialComplete; if
    // onDialComplete fires first the dial timer is cleared. The idle
    // AbortController only becomes active AFTER onDialComplete fires.
    const dialAbortController = new AbortController()
    const idleAbortController = new AbortController()

    // Frame-tracking state (Issue 2 + Issue 3): updated by onFrameReceived.
    const turnStartedAt = Date.now()
    let lastActivityAt = turnStartedAt
    let frameCount = 0
    let lastFrameKind: string | undefined
    let lastFrameSeq: number | undefined

    // Dial-phase timeout — covers dialProtocol + initial send ONLY.
    // Cleared by onDialComplete when the dial succeeds.
    // Issue 3: abort with PhaseStampedAbort(phase='dial').
    const dialTimeoutHandle = setTimeout(() => {
      dialAbortController.abort(
        new PhaseStampedAbort({
          elapsedMs: Date.now() - turnStartedAt,
          frameCount: 0,
          localTimeoutFired: true,
          phase: 'dial',
        }),
      )
    }, dialTimeoutMs)

    // Idle check interval — only meaningful AFTER dial completes.
    // Issue 2: checks elapsed since LAST FRAME (lastActivityAt), not since turn start.
    // Issue 3: abort with PhaseStampedAbort(phase='frame_read').
    let idleCheckHandle: ReturnType<typeof setInterval> | undefined
    const startIdleCheck = (): void => {
      idleCheckHandle = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt
        if (idleMs > idleTimeoutMs) {
          idleAbortController.abort(
            new PhaseStampedAbort({
              elapsedMs: Date.now() - turnStartedAt,
              frameCount,
              lastFrameKind,
              lastFrameSeq,
              localTimeoutFired: true,
              phase: 'frame_read',
            }),
          )
        }
      }, Math.min(Math.floor(idleTimeoutMs / 10), 30_000))
    }

    // Combined signal: fires if EITHER the dial OR the idle controller aborts.
    // We link idleAbortController's signal into sendParleyQuery because that
    // is what guards the frame-read phase.
    // The dial timer fires dialAbortController; that propagates here.
    // We abort the combined signal when either fires.
    const combinedAbortController = new AbortController()
    const onDialAbort = (): void => {
      combinedAbortController.abort(dialAbortController.signal.reason)
    }

    const onIdleAbort = (): void => {
      combinedAbortController.abort(idleAbortController.signal.reason)
    }

    dialAbortController.signal.addEventListener('abort', onDialAbort, {once: true})
    idleAbortController.signal.addEventListener('abort', onIdleAbort, {once: true})

    try {
      // Fail fast on non-text blocks rather than silently dropping
      // them (kimi round-1 MEDIUM). ACP may add `resource_link` /
      // `image` block types; without this guard the operator gets
      // either an empty prompt OR a Parley reject they can't
      // diagnose.
      const nonText = args.prompt.find((b) => b.type !== 'text')
      if (nonText !== undefined) {
        throw new Error(
          `REMOTE_PROMPT_UNSUPPORTED_BLOCK_TYPE: ${nonText.type} blocks are not yet supported by remote-peer drivers (slice 9.4 only handles text)`,
        )
      }

      const promptBlocks = args.prompt
        .filter((b): b is {text: string; type: 'text'} => b.type === 'text')
        .map((b) => ({text: b.text, type: 'text' as const}))

      if (promptBlocks.length === 0) {
        throw new Error('REMOTE_PROMPT_EMPTY: no text content blocks in prompt')
      }

      const delivery_id = `remote-${args.turnId}`

      const result = await this.sendParleyQueryFn({
        channel_id: this.channelId,
        delivery_id,
        host: this.host,
        install: this.install,
        l2Identity: this.l2Identity,
        multiaddr: this.multiaddr,
        // Issue 1: onDialComplete clears the dial timer and starts the idle timer.
        // Reset lastActivityAt to "now" so the idle window measures from
        // post-dial, not turn start (codex round-2: with a short configured
        // idle timeout and a slow-but-successful dial, the post-dial idle
        // window would otherwise be shortened by the dial duration).
        onDialComplete() {
          clearTimeout(dialTimeoutHandle)
          lastActivityAt = Date.now()
          startIdleCheck()
        },
        // Issue 2: onFrameReceived resets lastActivityAt so the idle timer
        // measures silence since last frame, not since turn start.
        onFrameReceived(frame) {
          lastActivityAt = Date.now()
          frameCount += 1
          lastFrameKind = frame.kind
          lastFrameSeq = frame.seq
        },
        prompt: promptBlocks,
        remoteL2PubKey: this.remoteL2PubKey,
        // §3.3 Layer C — thread the combined AbortSignal through so either
        // the dial timeout or the idle timeout can interrupt frame reading.
        signal: combinedAbortController.signal,
        turn_id: args.turnId,
      })

      if (!result.ok) {
        throw new Error(`PARLEY_REJECTED [${result.code}]: ${result.message}`)
      }

      // §9.5.8 codex round-2 fix: yield chunks + parley_integrity meta
      // BEFORE surfacing any error frame, so the orchestrator persists
      // both the streamed content AND the integrity markers before the
      // turn transitions to errored. Previously the error-frame scan ran
      // first and threw, dropping the chunks + integrity meta on the
      // floor for the chunks+signed_error+no_seal case.

      // Project agent_message_chunk frames as the corresponding
      // TurnEventPayload. Slice 9.4 only handles text; tool calls /
      // permission requests / thoughts are deferred to follow-ups.
      for (const frame of result.frames) {
        if (frame.kind === 'agent_message_chunk') {
          yield {content: frame.content, kind: 'agent_message_chunk'}
        }
      }

      // Surface integrity-degraded markers as an agent_meta event so the
      // orchestrator can persist them into the delivery record and
      // `brv channel show` can display them. Only emitted when
      // sealOrigin !== 'explicit' (i.e. the fallback paths were taken).
      // Normal explicit-seal turns produce no event.
      if (result.sealOrigin !== 'explicit') {
        const integrityPayload: Record<string, unknown> = {
          integrityDegraded: result.integrityDegraded,
          sealOrigin: result.sealOrigin,
        }
        if (result.terminalMissing === true) {
          integrityPayload.terminalMissing = true
        }

        yield {
          kind: 'agent_meta',
          payload: integrityPayload,
          subKind: 'parley_integrity',
        }
      }

      // Now surface ANY server-emitted error frame on the response stream
      // (kimi round-1 MEDIUM — previously silently swallowed). Runs AFTER
      // chunk/meta yield so the orchestrator captures the integrity record
      // before transitioning the delivery to errored.
      for (const frame of result.frames) {
        if (frame.kind === 'error') {
          throw new Error(`PARLEY_STREAM_ERROR [${frame.code}]: ${frame.message}`)
        }
      }

      this.statusValue = 'idle'
    } catch (error) {
      this.statusValue = 'errored'
      throw error
    } finally {
      // Always clean up timers to prevent leaks across turns.
      clearTimeout(dialTimeoutHandle)
      if (idleCheckHandle !== undefined) clearInterval(idleCheckHandle)
      dialAbortController.signal.removeEventListener('abort', onDialAbort)
      idleAbortController.signal.removeEventListener('abort', onIdleAbort)
    }
  }

  public async respondToPermission(_permissionRequestId: string, _response: unknown): Promise<void> {
    throw new Error(
      'REMOTE_PERMISSION_UNSUPPORTED: slice 9.4 mock-echo does not request permissions; ' +
      'full delegate path is slice 9.9',
    )
  }

  public async start(): Promise<void> {
    // No subprocess. The libp2p host is owned by the daemon and is
    // assumed to be started by the time the driver is created.
    this.statusValue = 'idle'
  }

  public async stop(): Promise<void> {
    // No subprocess to stop. The libp2p host is NOT torn down here —
    // it's shared across drivers and owned by the daemon.
    this.statusValue = 'stopped'
  }
}
