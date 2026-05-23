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
import {l2PubKeyFromBase64, sendParleyQuery} from './parley-client.js'

/**
 * Phase 9.5.4 — enrich a dial-failure error with a copy-paste-ready recovery
 * hint when the cached multiaddr came from a one-time inbound dial
 * (addressability='bootstrap-only').
 *
 * Exported for unit testing only.
 */
export function enrichDialFailureError(args: {
  readonly addressability: 'bootstrap-only' | 'pinned' | undefined
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
  readonly channelId: string
  readonly handle: string
  readonly host: Libp2pHost
  readonly install: InstallIdentityService
  readonly l2Identity: PeerTreeIdentityService
  readonly multiaddr: string
  readonly peerId: string
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
  private readonly remoteL2PubKey: KeyObject
  private statusValue: AcpDriverStatus = 'stopped'

  public constructor(deps: RemoteMemberDriverDeps) {
    this.handle = deps.handle
    this.channelId = deps.channelId
    this.host = deps.host
    this.install = deps.install
    this.l2Identity = deps.l2Identity
    this.multiaddr = deps.multiaddr
    this.peerId = deps.peerId
    this.remoteL2PubKey = l2PubKeyFromBase64(deps.remoteL2PubKey)
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

      const result = await sendParleyQuery({
        channel_id: this.channelId,
        delivery_id,
        host: this.host,
        install: this.install,
        l2Identity: this.l2Identity,
        multiaddr: this.multiaddr,
        prompt: promptBlocks,
        remoteL2PubKey: this.remoteL2PubKey,
        turn_id: args.turnId,
      })

      if (!result.ok) {
        throw new Error(`PARLEY_REJECTED [${result.code}]: ${result.message}`)
      }

      // Surface ANY server-emitted error frame on the response stream
      // (kimi round-1 MEDIUM — previously silently swallowed because the
      // loop only handled `agent_message_chunk`). The seal-verify path
      // in `sendParleyQuery` already enforces signature integrity, so
      // an error frame here is authoritative.
      for (const frame of result.frames) {
        if (frame.kind === 'error') {
          throw new Error(`PARLEY_STREAM_ERROR [${frame.code}]: ${frame.message}`)
        }
      }

      // Project agent_message_chunk frames as the corresponding
      // TurnEventPayload. Slice 9.4 only handles text; tool calls /
      // permission requests / thoughts are deferred to follow-ups.
      for (const frame of result.frames) {
        if (frame.kind === 'agent_message_chunk') {
          yield {content: frame.content, kind: 'agent_message_chunk'}
        }
      }

      this.statusValue = 'idle'
    } catch (error) {
      this.statusValue = 'errored'
      throw error
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
