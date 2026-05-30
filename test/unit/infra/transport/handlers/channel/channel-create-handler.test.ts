import {expect} from 'chai'

import {
  ChannelInvalidRequestError,
  ChannelNotImplementedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelCreateHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-create-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

describe('ChannelCreateHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    transport = createMockTransportServer()
    new ChannelCreateHandler(transport).setup()
  })

  async function invoke(payload: unknown): Promise<unknown> {
    const handler = transport._handlers.get(ChannelEvents.CREATE)
    if (handler === undefined) throw new Error('channel:create was not registered')
    try {
      await handler(payload, 'client-1')
    } catch (error) {
      return error
    }

    throw new Error('channel:create handler resolved but was expected to throw')
  }

  it('registers channel:create on setup', () => {
    expect(transport._handlers.has(ChannelEvents.CREATE)).to.equal(true)
  })

  it('throws CHANNEL_NOT_IMPLEMENTED for a valid payload', async () => {
    const error = await invoke({})

    expect(error).to.be.instanceOf(ChannelNotImplementedError)
  })

  it('throws CHANNEL_INVALID_REQUEST for a malformed payload', async () => {
    const error = await invoke({title: 42})

    expect(error).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
