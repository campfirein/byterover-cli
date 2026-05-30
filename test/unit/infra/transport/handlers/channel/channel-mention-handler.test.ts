import {expect} from 'chai'

import {
  ChannelInvalidRequestError,
  ChannelNotImplementedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelMentionHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-mention-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

describe('ChannelMentionHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    transport = createMockTransportServer()
    new ChannelMentionHandler(transport).setup()
  })

  async function invoke(payload: unknown): Promise<unknown> {
    const handler = transport._handlers.get(ChannelEvents.MENTION)
    if (handler === undefined) throw new Error('channel:mention was not registered')
    try {
      await handler(payload, 'client-1')
    } catch (error) {
      return error
    }

    throw new Error('channel:mention handler resolved but was expected to throw')
  }

  it('registers channel:mention on setup', () => {
    expect(transport._handlers.has(ChannelEvents.MENTION)).to.equal(true)
  })

  it('throws CHANNEL_NOT_IMPLEMENTED for a valid payload', async () => {
    const error = await invoke({channelId: 'c1', prompt: 'hi @bob'})

    expect(error).to.be.instanceOf(ChannelNotImplementedError)
  })

  it('throws CHANNEL_INVALID_REQUEST when channelId is missing', async () => {
    const error = await invoke({prompt: 'hi @bob'})

    expect(error).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
