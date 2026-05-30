import type {ITransportServer} from '../../../core/interfaces/transport/index.js'

import {ChannelEvents} from '../../../../shared/transport/events/channel-events.js'
import {ChannelDisabledError} from '../../../core/domain/channel/errors.js'

/** Every `channel:*` request event the live per-event handlers register. */
const STUBBABLE_EVENTS = [
  ChannelEvents.CREATE,
  ChannelEvents.LIST,
  ChannelEvents.GET,
  ChannelEvents.INVITE,
  ChannelEvents.ONBOARD,
  ChannelEvents.MENTION,
  ChannelEvents.SHOW,
  ChannelEvents.LIST_TURNS,
  ChannelEvents.SUBSCRIBE,
  ChannelEvents.CANCEL,
] as const

/**
 * Registers a stub for every `channel:*` request event that throws
 * {@link ChannelDisabledError}. Without it, a `channel:*` request sent while the
 * surface is disabled would never receive an ack and the client would hang.
 * Returns the list of stubbed events.
 */
export const registerDisabledStubs = (transport: ITransportServer): readonly string[] => {
  for (const event of STUBBABLE_EVENTS) {
    transport.onRequest(event, () => {
      throw new ChannelDisabledError()
    })
  }

  return STUBBABLE_EVENTS
}

/**
 * Reports whether the channel surface is enabled. Opt-out: enabled unless
 * `BRV_CHANNELS_ENABLED` is `0`, `false`, `no`, or `off` (case-insensitive).
 */
export const channelsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env.BRV_CHANNELS_ENABLED
  if (value === undefined) return true
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase())
}
