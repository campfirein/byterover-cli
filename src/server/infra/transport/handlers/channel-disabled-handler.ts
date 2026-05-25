import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {ChannelEvents} from '../../../../shared/transport/events/channel-events.js'
import {ChannelDisabledError} from '../../../core/domain/channel/errors.js'

/**
 * Phase-3 stub handlers (Slice 3.5b).
 *
 * When `BRV_CHANNELS_ENABLED` is unset/false, the daemon MUST still
 * respond to every `channel:*` event — otherwise the Socket.IO ack
 * callback never fires and the CLI hangs (per CHANNEL_PROTOCOL.md §13.1
 * Phase-3 spec edit). This module registers a stub for every event in
 * `ChannelEvents` that synchronously throws {@link ChannelDisabledError},
 * which the transport's `registerEventHandler` converts into a structured
 * `{success: false, code: 'CHANNEL_DISABLED'}` envelope.
 */
type TransportRegistry = Pick<ITransportServer, 'onRequest'>

/** Every event the FULL ChannelHandler would have registered. */
const STUBBABLE_EVENTS = [
  ChannelEvents.ARCHIVE,
  ChannelEvents.CANCEL,
  ChannelEvents.CREATE,
  ChannelEvents.DOCTOR,
  ChannelEvents.GET,
  ChannelEvents.GET_TURN,
  ChannelEvents.INVITE,
  ChannelEvents.LIST,
  ChannelEvents.LIST_TURNS,
  ChannelEvents.MENTION,
  ChannelEvents.MENTION_QUORUM,
  ChannelEvents.SHOW_QUORUM,
  ChannelEvents.ONBOARD,
  ChannelEvents.PERMISSION_DECISION,
  ChannelEvents.POST,
  ChannelEvents.PROFILE_CLEAR_DRIFT,
  ChannelEvents.PROFILE_LIST,
  ChannelEvents.PROFILE_RECORD_DRIFT,
  ChannelEvents.PROFILE_REMOVE,
  ChannelEvents.PROFILE_SHOW,
  ChannelEvents.ROTATE_TOKEN,
  ChannelEvents.UNINVITE,
] as const

export const registerDisabledStubs = (transport: TransportRegistry): readonly string[] => {
  for (const event of STUBBABLE_EVENTS) {
    transport.onRequest(event, async () => {
      throw new ChannelDisabledError()
    })
  }

  return STUBBABLE_EVENTS
}

/**
 * `BRV_CHANNELS_ENABLED` is opt-OUT. Channels are enabled by default; the
 * env var lets an operator disable the surface administratively. Accepts
 * `0`, `false`, `no`, `off` (case-insensitive) to disable; anything else
 * (including absence) is enabled.
 */
export const channelsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const v = env.BRV_CHANNELS_ENABLED
  if (v === undefined) return true
  return !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase())
}
