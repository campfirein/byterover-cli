import {expect} from 'chai'

import {
  ChannelInvalidRequestError,
  ChannelNotImplementedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelListTurnsHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-list-turns-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

describe('ChannelListTurnsHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    transport = createMockTransportServer()
    new ChannelListTurnsHandler(transport).setup()
  })

  async function invoke(payload: unknown): Promise<unknown> {
    const handler = transport._handlers.get(ChannelEvents.LIST_TURNS)
    if (handler === undefined) throw new Error('channel:list-turns was not registered')
    try {
      await handler(payload, 'client-1')
    } catch (error) {
      return error
    }

    throw new Error('channel:list-turns handler resolved but was expected to throw')
  }

  it('registers channel:list-turns on setup', () => {
    expect(transport._handlers.has(ChannelEvents.LIST_TURNS)).to.equal(true)
  })

  it('throws CHANNEL_NOT_IMPLEMENTED for a valid payload', async () => {
    const error = await invoke({channelId: 'c1'})

    expect(error).to.be.instanceOf(ChannelNotImplementedError)
  })

  it('throws CHANNEL_INVALID_REQUEST for a non-positive limit', async () => {
    const error = await invoke({channelId: 'c1', limit: 0})

    expect(error).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
