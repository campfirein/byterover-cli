import {expect} from 'chai'

import {AnalyticsDisclosureHandler} from '../../../../../../src/server/infra/transport/handlers/analytics-disclosure-handler.js'
import {AnalyticsEvents} from '../../../../../../src/shared/transport/events/analytics-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

type DisclosureHandler = (data: unknown, clientId: string) => Promise<{markdown: string}>

describe('AnalyticsDisclosureHandler', () => {
  it('registers a handler for analytics:getDisclosure on setup()', () => {
    const transport = createMockTransportServer()
    new AnalyticsDisclosureHandler({loadDisclosure: async () => 'noop', transport}).setup()
    expect(transport._handlers.has(AnalyticsEvents.GET_DISCLOSURE)).to.equal(true)
  })

  it('returns the markdown loaded from the injected loader', async () => {
    const transport = createMockTransportServer()
    const markdown = '# Disclosure\n\nLorem.'
    new AnalyticsDisclosureHandler({loadDisclosure: async () => markdown, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.GET_DISCLOSURE) as DisclosureHandler
    const result = await handler(undefined, 'client-1')

    expect(result).to.deep.equal({markdown})
  })

  it('throws when the loader returns an empty string so the webui surfaces an error state', async () => {
    const transport = createMockTransportServer()
    new AnalyticsDisclosureHandler({loadDisclosure: async () => '', transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.GET_DISCLOSURE) as DisclosureHandler
    await handler(undefined, 'client-1').then(
      () => expect.fail('expected promise to reject'),
      (error: Error) => expect(error.message).to.include('missing'),
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
