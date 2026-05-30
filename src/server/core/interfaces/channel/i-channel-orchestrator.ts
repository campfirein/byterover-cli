import type {Channel, ContentBlock, Turn} from '../../../../shared/types/index.js'

/** Cancel an in-flight turn. */
export type CancelTurnArgs = {
  readonly channelId: string
  readonly turnId: string
}

/** Create a new channel. */
export type CreateChannelArgs = {
  readonly channelId: string
  readonly title?: string
}

/** Post a new turn (a user or local-agent prompt) into a channel. */
export type PostTurnArgs = {
  readonly channelId: string
  /** Optional client-supplied idempotency key for safe retries. */
  readonly idempotencyKey?: string
  /** Handles explicitly mentioned in the prompt; drives dispatch. */
  readonly mentions?: string[]
  readonly promptBlocks: ContentBlock[]
}

/**
 * Thin application-facing coordinator for the channel subsystem. Deliberately
 * smaller than the POC's god-object: it exposes only the read + lifecycle
 * operations the foundation needs. The interface is EXTENDED (never replaced) as
 * the subsystem grows — member management, streaming dispatch, quorum fan-out,
 * and permission decisions land additively once their domain types and consumers
 * exist.
 *
 * Implementations validate inputs against the transport request schemas before
 * these methods run (the handler does this), so orchestrator methods can trust
 * their arguments.
 */
export interface IChannelOrchestrator {
  /** Cancels an in-flight turn and its deliveries. */
  cancelTurn(args: CancelTurnArgs): Promise<void>

  /** Creates a new channel and returns its record. */
  createChannel(args: CreateChannelArgs): Promise<Channel>

  /** Reads one channel, or `undefined` when it does not exist. */
  getChannel(channelId: string): Promise<Channel | undefined>

  /** Reads one turn within a channel, or `undefined` when it does not exist. */
  getTurn(channelId: string, turnId: string): Promise<Turn | undefined>

  /** Lists all channels. */
  listChannels(): Promise<Channel[]>

  /** Lists the turns of a channel; ordering is defined by the adapter. */
  listTurns(channelId: string): Promise<Turn[]>

  /** Posts a new turn into a channel and returns the created turn record. */
  postTurn(args: PostTurnArgs): Promise<Turn>
}
