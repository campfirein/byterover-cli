import {expect} from 'chai'

import {
  ChannelInvalidRequestError,
  ChannelNotImplementedError,
} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelOnboardHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-onboard-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

describe('ChannelOnboardHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    transport = createMockTransportServer()
    new ChannelOnboardHandler(transport).setup()
  })

  async function invoke(payload: unknown): Promise<unknown> {
    const handler = transport._handlers.get(ChannelEvents.ONBOARD)
    if (handler === undefined) throw new Error('channel:onboard was not registered')
    try {
      await handler(payload, 'client-1')
    } catch (error) {
      return error
    }

    throw new Error('channel:onboard handler resolved but was expected to throw')
  }

  it('registers channel:onboard on setup', () => {
    expect(transport._handlers.has(ChannelEvents.ONBOARD)).to.equal(true)
  })

  it('throws CHANNEL_NOT_IMPLEMENTED for a valid payload', async () => {
    const error = await invoke({channelId: 'c1', handle: '@bob'})

    expect(error).to.be.instanceOf(ChannelNotImplementedError)
  })

  it('throws CHANNEL_INVALID_REQUEST when the handle is missing', async () => {
    const error = await invoke({channelId: 'c1'})

    expect(error).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
