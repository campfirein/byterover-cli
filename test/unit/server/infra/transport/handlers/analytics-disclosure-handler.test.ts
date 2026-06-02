import {expect} from 'chai'

import {AnalyticsDisclosureHandler} from '../../../../../../src/server/infra/transport/handlers/analytics-disclosure-handler.js'
import {AnalyticsEvents} from '../../../../../../src/shared/transport/events/analytics-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

type DisclosureHandler = (
  data: unknown,
  clientId: string,
) => Promise<{sections: Array<{body: string; label: string}>}>

const FIXTURE = ['## What is collected', 'Event names.', '', '## How to disable', 'Toggle off.'].join('\n')

describe('AnalyticsDisclosureHandler', () => {
  it('registers a handler for analytics:getDisclosure on setup()', () => {
    const transport = createMockTransportServer()
    new AnalyticsDisclosureHandler({loadDisclosure: async () => FIXTURE, transport}).setup()
    expect(transport._handlers.has(AnalyticsEvents.GET_DISCLOSURE)).to.equal(true)
  })

  it('returns parsed sections from the markdown loaded by the injected loader', async () => {
    const transport = createMockTransportServer()
    new AnalyticsDisclosureHandler({loadDisclosure: async () => FIXTURE, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.GET_DISCLOSURE) as DisclosureHandler
    const result = await handler(undefined, 'client-1')

    expect(result).to.deep.equal({
      sections: [
        {body: 'Event names.', label: 'What is collected'},
        {body: 'Toggle off.', label: 'How to disable'},
      ],
    })
  })

  it('throws when the markdown has no H2 sections so the webui surfaces an error state', async () => {
    const transport = createMockTransportServer()
    new AnalyticsDisclosureHandler({loadDisclosure: async () => '# Only H1\n\nIntro.', transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.GET_DISCLOSURE) as DisclosureHandler
    await handler(undefined, 'client-1').then(
      () => expect.fail('expected promise to reject'),
      (error: Error) => expect(error.message).to.include('no sections'),
    )
  })

  it('propagates loader errors so the daemon does not silently serve empty disclosure', async () => {
    const transport = createMockTransportServer()
    const boom = new Error('ENOENT')
    new AnalyticsDisclosureHandler({
      async loadDisclosure() {
        throw boom
      },
      transport,
    }).setup()

    const handler = transport._handlers.get(AnalyticsEvents.GET_DISCLOSURE) as DisclosureHandler
    await handler(undefined, 'client-1').then(
      () => expect.fail('expected promise to reject'),
      (error: Error) => expect(error).to.equal(boom),
    )
  })
})
