import {expect} from 'chai'

import type {DispatchMentionArgs, IChannelOrchestrator} from '../../../../../../src/server/core/interfaces/channel/i-channel-orchestrator.js'
import type {ChannelMentionSyncResult, Turn} from '../../../../../../src/shared/types/index.js'

import {ChannelInvalidRequestError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelMentionHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-mention-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

const turn: Turn = {
  author: {handle: 'you', kind: 'local-user'},
  channelId: 'c1',
  mentions: ['@bob'],
  promptBlocks: [{text: 'hi @bob', type: 'text'}],
  promptedBy: 'user',
  startedAt: '2026-06-02T08:00:00.000Z',
  state: 'dispatched',
  turnId: 't1',
}

const syncResult: ChannelMentionSyncResult = {
  durationMs: 5,
  endedState: 'completed',
  finalAnswer: 'hello',
  turnId: 't1',
}

const unused = (): never => {
  throw new Error('not expected in this test')
}

describe('ChannelMentionHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>
  let dispatched: DispatchMentionArgs | undefined
  let awaited: string | undefined

  beforeEach(() => {
    transport = createMockTransportServer()
    dispatched = undefined
    awaited = undefined
    const orchestrator: IChannelOrchestrator = {
      async awaitSyncMention(turnId) {
        awaited = turnId
        return syncResult
      },
      createChannel: unused,
      async dispatchMention(args) {
        dispatched = args
        return {deliveries: [], turn}
      },
      inviteMember: unused,
    }
    new ChannelMentionHandler({getOrchestrator: () => orchestrator, resolveProjectPath: () => '/proj', transport}).setup()
  })

  const invoke = async (payload: unknown): Promise<unknown> => {
    const handler = transport._handlers.get(ChannelEvents.MENTION)
    if (handler === undefined) throw new Error('channel:mention was not registered')
    return handler(payload, 'client-1')
  }

  it('registers channel:mention on setup', () => {
    expect(transport._handlers.has(ChannelEvents.MENTION)).to.equal(true)
  })

  it('dispatches then awaits the sync result for a sync mention', async () => {
    const response = await invoke({channelId: 'c1', mode: 'sync', prompt: 'hi @bob'})
    expect(dispatched?.mode).to.equal('sync')
    expect(awaited).to.equal('t1')
    expect(response).to.deep.equal({kind: 'sync', result: syncResult})
  })

  it('throws CHANNEL_INVALID_REQUEST when channelId is missing', async () => {
    let thrown: unknown
    try {
      await invoke({prompt: 'hi @bob'})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
