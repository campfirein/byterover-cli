import type {
  AgentDriverProfileInvocation,
  Channel,
  ChannelMember,
  ChannelMentionSyncResult,
  ContentBlock,
  Turn,
  TurnDelivery,
} from '../../../../shared/types/index.js'

/** Create a new channel. `channelId` is generated when omitted. */
export type CreateChannelArgs = {
  readonly channelId?: string
  readonly title?: string
}

/** Invite one local ACP agent — by saved profile name OR inline invocation. */
export type InviteMemberArgs = {
  readonly channelId: string
  readonly handle: string
  readonly invocation?: AgentDriverProfileInvocation
  readonly profileName?: string
}

/** Dispatch a prompt turn addressed at channel members. */
export type DispatchMentionArgs = {
  readonly channelId: string
  /** Client-supplied dedupe key (honored in a later milestone). */
  readonly idempotencyKey?: string
  /** Handles addressed explicitly, unioned with those parsed from the prompt. */
  readonly mentions?: string[]
  /** `'sync'` registers a pending result settled on terminal state. */
  readonly mode?: 'async' | 'sync'
  readonly prompt?: string
  readonly promptBlocks?: ContentBlock[]
  /** When true, `agent_thought_chunk` events are dropped from wire + transcript. */
  readonly suppressThoughts?: boolean
  /** Override for the sync wait budget (ms). */
  readonly timeoutMs?: number
}

/** Snapshot returned synchronously by `dispatchMention`. */
export type DispatchMentionResult = {
  readonly deliveries: TurnDelivery[]
  readonly turn: Turn
}

/**
 * Thin application-facing coordinator for the channel subsystem. Bound to one
 * project; the daemon keeps one instance per project so a member's driver,
 * registered at invite time, survives to mention time.
 *
 * Consumer-driven: each method exists because a transport handler needs it
 * (create / invite / mention). Read + cancel + fan-out + quorum land additively
 * as their consumers arrive.
 */
export interface IChannelOrchestrator {
  /** Returns the pending sync result for a turn (registered by `dispatchMention`). */
  awaitSyncMention(turnId: string): Promise<ChannelMentionSyncResult>

  /** Creates a new channel and returns its record. */
  createChannel(args: CreateChannelArgs): Promise<Channel>

  /**
   * Resolves the addressed member, creates the turn + delivery, kicks the
   * background stream, and returns the dispatch snapshot. In `sync` mode a
   * pending result is registered first; callers then await `awaitSyncMention`.
   */
  dispatchMention(args: DispatchMentionArgs): Promise<DispatchMentionResult>

  /** Spawns + registers the agent's driver and persists the member record. */
  inviteMember(args: InviteMemberArgs): Promise<ChannelMember>
}
