import {expect} from 'chai'

import {ChannelDisabledError} from '../../../../../src/server/core/domain/channel/errors.js'
import {
  channelsEnabled,
  registerDisabledStubs,
} from '../../../../../src/server/infra/transport/handlers/channel-disabled-handler.js'
import {ChannelEvents} from '../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../helpers/mock-factories.js'

const REQUEST_EVENTS = [
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

const BROADCAST_EVENTS = [
  ChannelEvents.TURN_EVENT,
  ChannelEvents.STATE_CHANGE,
  ChannelEvents.MEMBER_UPDATE,
] as const

describe('channel-disabled-handler', () => {
  describe('registerDisabledStubs', () => {
    it('registers a stub for every channel request event', () => {
      const transport = createMockTransportServer()

      const registered = registerDisabledStubs(transport)

      for (const event of REQUEST_EVENTS) {
        expect(transport._handlers.has(event), `expected ${event} to be stubbed`).to.equal(true)
      }

      expect(registered.length).to.equal(REQUEST_EVENTS.length)
    })

    it('does not stub broadcast events', () => {
      const transport = createMockTransportServer()

      registerDisabledStubs(transport)

      for (const event of BROADCAST_EVENTS) {
        expect(transport._handlers.has(event), `${event} must not be stubbed`).to.equal(false)
      }
    })

    it('every stub rejects with CHANNEL_DISABLED', async () => {
      const transport = createMockTransportServer()
      registerDisabledStubs(transport)

      for (const event of REQUEST_EVENTS) {
        const handler = transport._handlers.get(event)
        if (handler === undefined) throw new Error(`stub for ${event} was not registered`)

        let thrown: unknown
        try {
          // eslint-disable-next-line no-await-in-loop
          await handler({}, 'client-1')
        } catch (error) {
          thrown = error
        }

        expect(thrown, event).to.be.instanceOf(ChannelDisabledError)
        if (thrown instanceof ChannelDisabledError) {
          expect(thrown.code, event).to.equal('CHANNEL_DISABLED')
        }
      }
    })
  })

  describe('channelsEnabled', () => {
    it('is enabled by default when the env var is unset (opt-out)', () => {
      expect(channelsEnabled({})).to.equal(true)
    })

    it('is disabled for 0/false/no/off (case- and whitespace-insensitive)', () => {
      for (const value of ['0', 'false', 'FALSE', 'no', 'off', ' Off ']) {
        expect(channelsEnabled({BRV_CHANNELS_ENABLED: value}), value).to.equal(false)
      }
    })

    it('is enabled for any other value', () => {
      for (const value of ['1', 'true', 'yes', 'on', 'anything']) {
        expect(channelsEnabled({BRV_CHANNELS_ENABLED: value}), value).to.equal(true)
      }
    })
  })
})
