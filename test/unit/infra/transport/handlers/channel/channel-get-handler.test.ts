import {expect} from 'chai'

import {
  ChannelInvalidRequestError,
  ChannelNotImplementedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelGetHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-get-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

describe('ChannelGetHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    transport = createMockTransportServer()
    new ChannelGetHandler(transport).setup()
  })

  async function invoke(payload: unknown): Promise<unknown> {
    const handler = transport._handlers.get(ChannelEvents.GET)
    if (handler === undefined) throw new Error('channel:get was not registered')
    try {
      await handler(payload, 'client-1')
    } catch (error) {
      return error
    }

    throw new Error('channel:get handler resolved but was expected to throw')
  }

  it('registers channel:get on setup', () => {
    expect(transport._handlers.has(ChannelEvents.GET)).to.equal(true)
  })

  it('throws CHANNEL_NOT_IMPLEMENTED for a valid payload', async () => {
    const error = await invoke({channelId: 'c1'})

    expect(error).to.be.instanceOf(ChannelNotImplementedError)
  })

  it('throws CHANNEL_INVALID_REQUEST for a malformed payload', async () => {
    const error = await invoke({channelId: 42})

    expect(error).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
