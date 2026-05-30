import {expect} from 'chai'

import {
  ChannelInvalidRequestError,
  ChannelNotImplementedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelInviteHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-invite-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

describe('ChannelInviteHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    transport = createMockTransportServer()
    new ChannelInviteHandler(transport).setup()
  })

  async function invoke(payload: unknown): Promise<unknown> {
    const handler = transport._handlers.get(ChannelEvents.INVITE)
    if (handler === undefined) throw new Error('channel:invite was not registered')
    try {
      await handler(payload, 'client-1')
    } catch (error) {
      return error
    }

    throw new Error('channel:invite handler resolved but was expected to throw')
  }

  it('registers channel:invite on setup', () => {
    expect(transport._handlers.has(ChannelEvents.INVITE)).to.equal(true)
  })

  it('throws CHANNEL_NOT_IMPLEMENTED for a valid payload', async () => {
    const error = await invoke({channelId: 'c1', handle: '@bob'})

    expect(error).to.be.instanceOf(ChannelNotImplementedError)
  })

  it('throws CHANNEL_INVALID_REQUEST for a malformed handle', async () => {
    // handles must start with "@"
    const error = await invoke({channelId: 'c1', handle: 'bob'})

    expect(error).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
