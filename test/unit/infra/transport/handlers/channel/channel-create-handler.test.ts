import {expect} from 'chai'

import type {CreateChannelArgs, IChannelOrchestrator} from '../../../../../../src/server/core/interfaces/channel/i-channel-orchestrator.js'
import type {Channel} from '../../../../../../src/shared/types/index.js'

import {ChannelInvalidRequestError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelCreateHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-create-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

const channel: Channel = {
  channelId: 'x',
  createdAt: '2026-06-02T08:00:00.000Z',
  memberCount: 0,
  members: [],
  updatedAt: '2026-06-02T08:00:00.000Z',
}

const unused = (): never => {
  throw new Error('not expected in this test')
}

describe('ChannelCreateHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>
  let created: CreateChannelArgs | undefined

  beforeEach(() => {
    transport = createMockTransportServer()
    created = undefined
    const orchestrator: IChannelOrchestrator = {
      awaitSyncMention: unused,
      async createChannel(args) {
        created = args
        return channel
      },
      dispatchMention: unused,
      inviteMember: unused,
    }
    new ChannelCreateHandler({getOrchestrator: () => orchestrator, resolveProjectPath: () => '/proj', transport}).setup()
  })

  const invoke = async (payload: unknown): Promise<unknown> => {
    const handler = transport._handlers.get(ChannelEvents.CREATE)
    if (handler === undefined) throw new Error('channel:create was not registered')
    return handler(payload, 'client-1')
  }

  it('registers channel:create on setup', () => {
    expect(transport._handlers.has(ChannelEvents.CREATE)).to.equal(true)
  })

  it('creates a channel via the project orchestrator for a valid payload', async () => {
    const response = await invoke({channelId: 'x', title: 'Demo'})
    expect(created).to.deep.equal({channelId: 'x', title: 'Demo'})
    expect(response).to.deep.equal({channel})
  })

  it('throws CHANNEL_INVALID_REQUEST for a malformed payload', async () => {
    let thrown: unknown
    try {
      await invoke({title: 42})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
