import {expect} from 'chai'

import {
  ChannelInvalidRequestError,
  ChannelNotImplementedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelShowHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-show-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

describe('ChannelShowHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    transport = createMockTransportServer()
    new ChannelShowHandler(transport).setup()
  })

  async function invoke(payload: unknown): Promise<unknown> {
    const handler = transport._handlers.get(ChannelEvents.SHOW)
    if (handler === undefined) throw new Error('channel:show was not registered')
    try {
      await handler(payload, 'client-1')
    } catch (error) {
      return error
    }

    throw new Error('channel:show handler resolved but was expected to throw')
  }

  it('registers channel:show on setup', () => {
    expect(transport._handlers.has(ChannelEvents.SHOW)).to.equal(true)
  })

  it('throws CHANNEL_NOT_IMPLEMENTED for a valid payload', async () => {
    const error = await invoke({channelId: 'c1', turnId: 't1'})

    expect(error).to.be.instanceOf(ChannelNotImplementedError)
  })

  it('throws CHANNEL_INVALID_REQUEST when turnId is missing', async () => {
    const error = await invoke({channelId: 'c1'})

    expect(error).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
