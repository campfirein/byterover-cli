// @brv/channel-client — TypeScript client for the brv channel-protocol
// wire surface. Drives `channel:*` requests + subscribes to broadcasts.
//
// Spec: ../../plan/channel-protocol/CHANNEL_PROTOCOL.md

export {
  ChannelClient,
  type ChannelClientConnectOptions,
  type ChannelMentionOptions,
  type ChannelMentionStreamAck,
  type ChannelMentionSyncResponse,
  type TurnEvent,
} from './channel-client.js'

export {
  CHANNEL_CLIENT_ERROR_CODE,
  type ChannelClientErrorCode,
  ChannelClientError,
} from './errors.js'

export {
  discoverDaemon,
  type DiscoverDaemonOptions,
  type DiscoveredDaemon,
} from './discovery.js'

export const VERSION = '0.1.0'
