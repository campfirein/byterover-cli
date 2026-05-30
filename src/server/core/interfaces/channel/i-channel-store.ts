import type {Channel, ChannelMember, ChannelSettings} from '../../../../shared/types/index.js'

/** Add a full member record to a channel. */
export type ChannelStoreAddMemberArgs = {
  readonly channelId: string
  readonly member: ChannelMember
}

/** Create a new channel record. */
export type ChannelStoreCreateArgs = {
  readonly channelId: string
  readonly settings?: ChannelSettings
  readonly title?: string
}

/** Remove a member from a channel by handle. */
export type ChannelStoreRemoveMemberArgs = {
  readonly channelId: string
  readonly memberHandle: string
}

/** Apply a metadata patch to an existing channel (title / settings / archive). */
export type ChannelStoreUpdateArgs = {
  readonly archivedAt?: string
  readonly channelId: string
  readonly settings?: ChannelSettings
  readonly title?: string
}

/**
 * Persistence port for channel + member METADATA only. It owns the durable
 * {@link Channel} record and the full {@link ChannelMember} records behind it;
 * `Channel.members` remains the summarised projection the adapter derives from
 * those records.
 *
 * It deliberately does NOT store transcripts (turns / events) — that is
 * `ITranscriptStore`'s responsibility. Splitting the two lets transcript
 * retention / GC evolve independently, without touching channel metadata. Member
 * CRUD (`addMember` / `removeMember` / `listMembers`) is the seam invite /
 * uninvite drives.
 */
export interface IChannelStore {
  /** Persists a new member record under a channel. */
  addMember(args: ChannelStoreAddMemberArgs): Promise<void>

  /** Creates and persists a new channel; rejects when `channelId` already exists. */
  createChannel(args: ChannelStoreCreateArgs): Promise<Channel>

  /** Lists all channels (summary view). */
  listChannels(): Promise<Channel[]>

  /** Lists the full member records of a channel. */
  listMembers(channelId: string): Promise<ChannelMember[]>

  /** Reads one channel record, or `undefined` when it does not exist. */
  readChannel(channelId: string): Promise<Channel | undefined>

  /** Removes a member record from a channel by handle. No-op when absent. */
  removeMember(args: ChannelStoreRemoveMemberArgs): Promise<void>

  /** Applies a metadata patch to an existing channel; returns the updated record. */
  updateChannel(args: ChannelStoreUpdateArgs): Promise<Channel>
}
