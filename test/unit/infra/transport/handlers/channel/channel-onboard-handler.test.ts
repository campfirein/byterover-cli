import {expect} from 'chai'

import type {IChannelOnboardService, OnboardArgs} from '../../../../../../src/server/infra/channel/onboard-service.js'
import type {AgentDriverProfile} from '../../../../../../src/shared/types/index.js'

import {ChannelInvalidRequestError} from '../../../../../../src/server/core/domain/channel/errors.js'
import {ChannelOnboardHandler} from '../../../../../../src/server/infra/transport/handlers/channel/channel-onboard-handler.js'
import {ChannelEvents} from '../../../../../../src/shared/transport/events/channel-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

const profile: AgentDriverProfile = {
  capabilities: [],
  displayName: 'Mock',
  driverClass: 'B',
  invocation: {args: ['x.js'], command: 'node', cwd: '/proj'},
  name: 'mock',
}

describe('ChannelOnboardHandler', () => {
  let transport: ReturnType<typeof createMockTransportServer>
  let onboarded: OnboardArgs | undefined

  beforeEach(() => {
    transport = createMockTransportServer()
    onboarded = undefined
    const onboardService: IChannelOnboardService = {
      async onboard(args) {
        onboarded = args
        return {diagnostics: [], profile}
      },
    }
    new ChannelOnboardHandler({onboardService, transport}).setup()
  })

  const invoke = async (payload: unknown): Promise<unknown> => {
    const handler = transport._handlers.get(ChannelEvents.ONBOARD)
    if (handler === undefined) throw new Error('channel:onboard was not registered')
    return handler(payload, 'client-1')
  }

  it('registers channel:onboard on setup', () => {
    expect(transport._handlers.has(ChannelEvents.ONBOARD)).to.equal(true)
  })

  it('probes and persists a profile via the onboard service for a valid payload', async () => {
    const response = await invoke({
      displayName: 'Mock',
      invocation: {args: ['x.js'], command: 'node', cwd: '/proj'},
      profileName: 'mock',
    })
    expect(onboarded?.profileName).to.equal('mock')
    expect(response).to.deep.equal({diagnostics: [], profile})
  })

  it('throws CHANNEL_INVALID_REQUEST when the invocation is missing', async () => {
    let thrown: unknown
    try {
      await invoke({displayName: 'Mock', profileName: 'mock'})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelInvalidRequestError)
  })
})
