import {expect} from 'chai'

import type {IChannelOrchestrator, InviteMemberArgs} from '../../../../../../src/server/core/interfaces/channel/i-channel-orchestrator.js'
import type {ChannelMember} from '../../../../../../src/shared/types/index.js'

import {ChannelInvalidRequestError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelInviteHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-invite-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

const member: ChannelMember = {
  agentName: 'bob',
  capabilities: [],
  driverClass: 'B',
  handle: '@bob',
  invocation: {args: [], command: 'node', cwd: '/proj'},
  joinedAt: '2026-06-02T08:00:00.000Z',
  memberKind: 'acp-agent',
  status: 'idle',
}

const unused = (): never => {
  throw new Error('not expected in this test')
}

describe('ChannelInviteHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>
  let invited: InviteMemberArgs | undefined

  beforeEach(() => {
    transport = createMockTransportServer()
    invited = undefined
    const orchestrator: IChannelOrchestrator = {
      awaitSyncMention: unused,
      createChannel: unused,
      dispatchMention: unused,
      async inviteMember(args) {
        invited = args
        return member
      },
    }
    new ChannelInviteHandler({getOrchestrator: () => orchestrator, resolveProjectPath: () => '/proj', transport}).setup()
  })

  const invoke = async (payload: unknown): Promise<unknown> => {
    const handler = transport._handlers.get(ChannelEvents.INVITE)
    if (handler === undefined) throw new Error('channel:invite was not registered')
    return handler(payload, 'client-1')
  }

  it('registers channel:invite on setup', () => {
    expect(transport._handlers.has(ChannelEvents.INVITE)).to.equal(true)
  })

  it('invites the member via the orchestrator for a valid payload', async () => {
    const response = await invoke({channelId: 'c1', handle: '@bob', profileName: 'bob'})
    expect(invited).to.deep.equal({channelId: 'c1', handle: '@bob', invocation: undefined, profileName: 'bob'})
    expect(response).to.deep.equal({member})
  })

  it('throws CHANNEL_INVALID_REQUEST for a handle missing the @ prefix', async () => {
    let thrown: unknown
    try {
      await invoke({channelId: 'c1', handle: 'bob'})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
