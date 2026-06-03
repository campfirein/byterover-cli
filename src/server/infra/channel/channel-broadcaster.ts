import type {IChannelBroadcaster} from '../../core/interfaces/channel/i-channel-broadcaster.js'
import type {ITransportServer} from '../../core/interfaces/transport/index.js'

/** The Socket.IO room every subscriber of a channel joins. */
const channelRoom = (channelId: string): string => `channel:${channelId}`

/**
 * Binds {@link IChannelBroadcaster} to the real transport server, fanning each
 * event out to the `channel:<channelId>` room. Fire-and-forget: emitting to a
 * room with no members is a harmless no-op (no subscribers until `subscribe`
 * lands in a later milestone).
 */
export class TransportChannelBroadcaster implements IChannelBroadcaster {
  private readonly transport: ITransportServer

  public constructor(transport: ITransportServer) {
    this.transport = transport
  }

  broadcastToChannel<T>(channelId: string, event: string, data: T): void {
    this.transport.broadcastTo(channelRoom(channelId), event, data)
  }
}
