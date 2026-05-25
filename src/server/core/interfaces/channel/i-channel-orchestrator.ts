import type {
  Channel,
  ChannelMember,
  ContentBlock,
  RequestPermissionOutcome,
  Turn,
  TurnDelivery,
  TurnEvent,
} from '../../../../shared/types/channel.js'

/**
 * Phase-1 channel orchestrator contract.
 *
 * Slice 1.4 lands the concrete implementation; Slice 1.2's transport handler
 * registers handlers that delegate here. Phase-2 methods (`mentionTurn`,
 * `cancelTurn`, `inviteMember`, `uninviteMember`) land alongside Phase 2 and
 * extend (do not replace) this interface.
 *
 * Project scoping: every method accepts a `projectRoot` so the orchestrator
 * routes to the right `.brv/context-tree/` per channel. The handler resolves
 * the active project from the request context.
 */

export type CreateChannelArgs = {
  readonly channelId?: string
  readonly projectRoot: string
  readonly title?: string
}

export type ListChannelsArgs = {
  readonly archived?: boolean
  readonly projectRoot: string
}

export type GetChannelArgs = {
  readonly channelId: string
  readonly projectRoot: string
}

export type ArchiveChannelArgs = GetChannelArgs

export type PostTurnArgs = {
  readonly channelId: string
  readonly idempotencyKey?: string
  readonly projectRoot: string
  readonly prompt?: string
  readonly promptBlocks?: import('../../../../shared/types/channel.js').ContentBlock[]
}

export type ListTurnsArgs = {
  readonly channelId: string
  readonly cursor?: string
  readonly limit?: number
  readonly projectRoot: string
}

export type ListTurnsResult = {
  readonly nextCursor?: string
  readonly turns: Turn[]
}

export type GetTurnArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turnId: string
}

export type GetTurnResult = {
  /**
   * Phase-2 active turns include per-delivery records reconstructed from
   * `deliveries/<id>.json` snapshots or replayed from `events.jsonl`.
   * Omitted for passive Phase-1 turns that have no deliveries.
   */
  readonly deliveries?: TurnDelivery[]
  readonly events: TurnEvent[]
  readonly turn: Turn
}

// ─── Phase-2 method args ────────────────────────────────────────────────────

export type InviteMemberArgs = {
  readonly capabilities?: string[]
  readonly channelId: string
  readonly handle: string
  readonly invocation?: {
    readonly args: string[]
    readonly command: string
    readonly cwd: string
    readonly env?: Record<string, string>
  }
  readonly profileName?: string
  readonly projectRoot: string
  /**
   * Phase 9 / Slice 9.4 — invite a remote brv install as a channel
   * member. When set, `invocation` + `profileName` MUST be absent;
   * the orchestrator constructs a `RemoteMemberDriver` instead of
   * spawning a local ACP subprocess.
   *
   * `remoteL2PubKey` is base64 of the remote's L2 tree pubkey. As of
   * slice 9.4d it is OPTIONAL — when absent, the orchestrator
   * auto-pins the peer via `/brv/identity/cert/v1` +
   * `/brv/identity/tree-cert/v1` to learn the L2 pubkey in-band.
   */
  readonly remotePeer?: {
    readonly displayName?: string
    readonly multiaddr: string
    readonly peerId: string
    readonly remoteL2PubKey?: string
  }
}

export type UninviteMemberArgs = {
  readonly channelId: string
  readonly memberHandle: string
  readonly projectRoot: string
}

export type DispatchMentionArgs = {
  readonly channelId: string
  readonly idempotencyKey?: string
  readonly mentions?: string[]
  // Slice 8.0 — sync mode + thought suppression. See
  // plan/channel-protocol/IMPLEMENTATION_PHASE_8.md §8.0.
  readonly mode?: 'stream' | 'sync'
  readonly projectRoot: string
  readonly prompt?: string
  readonly promptBlocks?: ContentBlock[]
  // Phase 10 D1 (V6 E2E retest) — when true, dispatchMention ignores
  // @-handles parsed from the prompt body and dispatches ONLY to the
  // explicit `mentions` array. Used by `dispatchOne` so single-agent
  // intent isn't diluted by context-documenting @-mentions in the prompt.
  // Default false preserves Phase 1–9 behaviour.
  readonly strictMentions?: boolean
  readonly suppressThoughts?: boolean
  readonly timeout?: number
}

export type DispatchMentionResult = {
  readonly deliveries: TurnDelivery[]
  readonly turn: Turn
}

/**
 * Slice 8.0 — assembled response surfaced when `dispatchMention` is
 * called with `mode === 'sync'`. The orchestrator buffers per-member
 * `agent_message_chunk` content until the turn reaches a terminal state,
 * then resolves with this shape. Errors surface as `ChannelError`
 * subclasses (CHANNEL_SYNC_TIMEOUT / SYNC_OVERFLOW / TURN_CANCELLED /
 * DAEMON_SHUTDOWN), not via a separate failure shape.
 */
export type ChannelMentionSyncResult = {
  readonly channelId: string
  readonly durationMs: number
  readonly endedState: 'cancelled' | 'completed'
  readonly finalAnswer: string
  readonly toolCalls: ReadonlyArray<{
    readonly callId: string
    readonly name: string
    readonly status?: string
  }>
  readonly turnId: string
}

// Phase 10 Slice 10.2 — quorum dispatch types (codex Q4 + C5).
//
// `TerminalDelivery` is a structured shape carrying everything the
// `QuorumDispatcher` needs to extract findings + build a `MergeContext`.
// The orchestrator surfaces this directly so the dispatcher never parses
// wire events or shell-outs. Live-streaming subscription is intentionally
// out of scope here — Tier 2's Slice 10.7 (partition-tolerant convergence)
// gets its own event hook.
export type TerminalDelivery = {
  readonly artifactsTouched: ReadonlyArray<string>
  readonly deliveryId: string
  readonly endedAt: string
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly finalAnswer?: string
  readonly memberHandle: string
  readonly state: 'cancelled' | 'completed' | 'errored'
  readonly toolCallCount: number
}

export type DispatchHandle = {
  readonly deliveryId: string
  readonly terminal: Promise<TerminalDelivery>
  readonly turnId: string
}

export type DispatchOneArgs = {
  readonly channelId: string
  readonly idempotencyKey?: string
  readonly memberHandle: string
  readonly projectRoot: string
  readonly prompt: string
  readonly suppressThoughts?: boolean
  readonly timeoutMs: number
}

export type CancelTurnArgs = {
  readonly channelId: string
  readonly deliveryId?: string
  readonly projectRoot: string
  readonly turnId: string
}

export type CancelTurnResult = DispatchMentionResult

export type PermissionDecisionArgs = {
  readonly channelId: string
  readonly outcome: RequestPermissionOutcome
  readonly permissionRequestId: string
  readonly projectRoot: string
  readonly turnId: string
}

/**
 * Phase-1 orchestrator surface. Implementations MUST validate inputs against
 * the channel-events.ts zod request schemas before calling these methods —
 * the handler does this; orchestrator methods can trust their arguments.
 *
 * Errors thrown MUST be `ChannelError` subclasses from
 * `src/server/core/domain/channel/errors.js`. The handler maps them onto the
 * wire error envelope.
 */
export interface IChannelOrchestrator {
  archiveChannel(args: ArchiveChannelArgs): Promise<Channel>
  /**
   * Slice 8.0 — paired with `dispatchMention` when `args.mode === 'sync'`.
   * Returns a promise that resolves with the assembled answer when the
   * turn reaches a terminal state, or rejects with one of the four
   * Phase-8 sync-mode `ChannelError` subclasses on timeout / overflow /
   * cancel / shutdown. Call exactly once per sync dispatch.
   */
  awaitSyncMention(turnId: string): Promise<ChannelMentionSyncResult>
  cancelTurn(args: CancelTurnArgs): Promise<CancelTurnResult>
  createChannel(args: CreateChannelArgs): Promise<Channel>
  dispatchMention(args: DispatchMentionArgs): Promise<DispatchMentionResult>
  /**
   * Phase 10 Slice 10.2 — single-agent dispatch returning a `DispatchHandle`.
   * The `terminal` Promise resolves ONLY when the orchestrator observes a
   * `delivery_state_change` with `to ∈ {'completed', 'errored', 'cancelled'}`
   * (codex Q8). Non-terminal intermediate state changes never resolve it.
   * Used by `QuorumDispatcher` (and, in time, the single-agent CLI surface).
   */
  dispatchOne(args: DispatchOneArgs): Promise<DispatchHandle>
  getChannel(args: GetChannelArgs): Promise<Channel>
  getTurn(args: GetTurnArgs): Promise<GetTurnResult>
  inviteMember(args: InviteMemberArgs): Promise<ChannelMember>
  listChannels(args: ListChannelsArgs): Promise<Channel[]>
  listTurns(args: ListTurnsArgs): Promise<ListTurnsResult>
  permissionDecision(args: PermissionDecisionArgs): Promise<TurnEvent>
  postTurn(args: PostTurnArgs): Promise<Turn>
  uninviteMember(args: UninviteMemberArgs): Promise<ChannelMember>
}
