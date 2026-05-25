import {expect} from 'chai'

import type {RequestContext, RequestHandler} from '../../../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {ChannelDisabledError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {
  channelsEnabled,
  registerDisabledStubs,
} from '../../../../../../src/server/infra/transport/handlers/channel-disabled-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'

// Slice 3.5b — when BRV_CHANNELS_ENABLED is off, every `channel:*` event
// MUST be answered by a stub that throws ChannelDisabledError. Without
// this, the CLI ack callback never fires (Socket.IO has no listener) and
// the request hangs until the client-side timeout (CHANNEL_REQUEST_TIMEOUT).

describe('Channels-disabled surface (Phase 3.5b)', () => {
describe('Disabled-channel stub handlers', () => {
  it('registers a CHANNEL_DISABLED stub for every `channel:*` event', async () => {
    const registered = new Map<string, RequestHandler<unknown, unknown>>()
    const transport = {
      onRequest<TReq, TRes>(event: string, h: RequestHandler<TReq, TRes>) {
        registered.set(event, h as RequestHandler<unknown, unknown>)
      },
    }

    const registeredEvents = registerDisabledStubs(transport)

    // Every event the full ChannelHandler would have registered is now a stub.
    expect(registered.has(ChannelEvents.CREATE)).to.equal(true)
    expect(registered.has(ChannelEvents.MENTION)).to.equal(true)
    expect(registered.has(ChannelEvents.ONBOARD)).to.equal(true)
    expect(registered.has(ChannelEvents.DOCTOR)).to.equal(true)
    expect(registered.has(ChannelEvents.PROFILE_LIST)).to.equal(true)
    expect(registered.has(ChannelEvents.ROTATE_TOKEN)).to.equal(true)

    // Broadcasts (turn-event / state-change / member-update) are emitted
    // by the orchestrator and are NOT registered via onRequest — they
    // remain absent under the stub regime too.
    expect(registered.has(ChannelEvents.TURN_EVENT)).to.equal(false)
    expect(registered.has(ChannelEvents.STATE_CHANGE)).to.equal(false)
    expect(registered.has(ChannelEvents.MEMBER_UPDATE)).to.equal(false)

    expect(registeredEvents.length).to.equal(registered.size)

    // Every stub throws ChannelDisabledError when invoked.
    const ctx: RequestContext = {auth: {token: 'irrelevant'}, cwd: '/tmp', transport: 'socket.io'}
    for (const handler of registered.values()) {
      let thrown: unknown
      try {
        // eslint-disable-next-line no-await-in-loop
        await handler({}, 'c1', ctx)
      } catch (error) {
        thrown = error
      }

      expect(thrown).to.be.instanceOf(ChannelDisabledError)
    }
  })
})

describe('channelsEnabled env parser', () => {
  it('returns true when the env var is unset (opt-out semantics)', () => {
    expect(channelsEnabled({})).to.equal(true)
  })

  it('returns false ONLY for explicit disable values (0 / false / no / off, case-insensitive)', () => {
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: '0'})).to.equal(false)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'false'})).to.equal(false)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'FALSE'})).to.equal(false)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'no'})).to.equal(false)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'off'})).to.equal(false)
  })

  it('returns true for truthy / unknown values (anything that is not explicitly disable)', () => {
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: '1'})).to.equal(true)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'true'})).to.equal(true)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'yes'})).to.equal(true)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'on'})).to.equal(true)
    expect(channelsEnabled({BRV_CHANNELS_ENABLED: 'enabled'})).to.equal(true)
  })
})
})
