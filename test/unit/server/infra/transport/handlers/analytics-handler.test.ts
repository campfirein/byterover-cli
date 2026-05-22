/* eslint-disable camelcase */
import {expect} from 'chai'

import type {IAnalyticsClient} from '../../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {AnalyticsEventName} from '../../../../../../src/shared/analytics/event-names.js'
import type {PropsArg} from '../../../../../../src/shared/analytics/events/index.js'

import {AnalyticsBatch} from '../../../../../../src/server/core/domain/analytics/batch.js'
import {AnalyticsHandler} from '../../../../../../src/server/infra/transport/handlers/analytics-handler.js'
import {AnalyticsEventNames} from '../../../../../../src/shared/analytics/event-names.js'
import {AnalyticsEvents, type AnalyticsTrackPayload} from '../../../../../../src/shared/transport/events/analytics-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

type AnalyticsTrackHandler = (data: unknown, clientId: string) => Promise<void>

type TrackCall = {event: AnalyticsEventName; properties: unknown}

type MockAnalyticsClient = IAnalyticsClient & {
  readonly trackCalls: readonly TrackCall[]
  trackThrows?: Error
}

/**
 * Hand-rolled mock that preserves the generic signature on `track`. Sinon's
 * `stub()` collapses generics into a single SinonStub overload, which fails
 * to satisfy `IAnalyticsClient.track<E extends AnalyticsEventName>`.
 */
function makeMockAnalyticsClient(): MockAnalyticsClient {
  const trackCalls: TrackCall[] = []
  const mock: MockAnalyticsClient = {
    abort() {
      /* M4.4: not exercised in this test */
    },
    flush: () => Promise.resolve(AnalyticsBatch.create([])),
    getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: () => Promise.resolve(),
    track<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
      if (mock.trackThrows) throw mock.trackThrows
      const [properties] = rest
      trackCalls.push({event, properties})
    },
    trackCalls,
  }
  return mock
}

describe('AnalyticsHandler', () => {
  it('should register a handler for analytics:track on setup()', () => {
    const transport = createMockTransportServer()
    const analyticsClient = makeMockAnalyticsClient()

    new AnalyticsHandler({analyticsClient, transport}).setup()

    expect(transport._handlers.has(AnalyticsEvents.TRACK)).to.equal(true)
  })

  describe('per-event Zod validation + typed dispatch', () => {
    it('should route a valid known event + valid properties to analyticsClient.track', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      const payload: AnalyticsTrackPayload = {
        event: AnalyticsEventNames.CURATE_OPERATION_APPLIED,
        properties: {
          absolute_path: '/tmp/a.md',
          knowledge_path: 'kg/a.md',
          needs_review: false,
          operation_type: 'ADD',
          task_id: 't-1',
        },
      }
      await handler(payload, 'client-1')

      expect(analyticsClient.trackCalls).to.have.lengthOf(1)
      expect(analyticsClient.trackCalls[0].event).to.equal(AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      expect(analyticsClient.trackCalls[0].properties).to.deep.equal({
        absolute_path: '/tmp/a.md',
        knowledge_path: 'kg/a.md',
        needs_review: false,
        operation_type: 'ADD',
        task_id: 't-1',
      })
    })

    it('should route DAEMON_START (no required properties) without forwarding props', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      await handler({event: AnalyticsEventNames.DAEMON_START}, 'client-1')

      expect(analyticsClient.trackCalls).to.have.lengthOf(1)
      expect(analyticsClient.trackCalls[0].event).to.equal(AnalyticsEventNames.DAEMON_START)
      // PropsArg makes properties absent for events with no required props.
      expect(analyticsClient.trackCalls[0].properties).to.equal(undefined)
    })

    it('should drop UNKNOWN event names silently (no track call)', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      await handler({event: 'cli_invocation', properties: {x: 1}}, 'client-1')
      await handler({event: 'mystery_event'}, 'client-1')

      expect(analyticsClient.trackCalls, 'unknown events must NOT reach track').to.deep.equal([])
    })

    it('should drop KNOWN events with INVALID per-event properties silently', async () => {
      const transport = createMockTransportServer()
      const analyticsClient = makeMockAnalyticsClient()
      new AnalyticsHandler({analyticsClient, transport}).setup()

      const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
      // CURATE_OPERATION_APPLIED requires absolute_path / knowledge_path / etc.
      await handler({event: AnalyticsEventNames.CURATE_OPERATION_APPLIED, properties: {wrong: 'shape'}}, 'client-1')
      // QUERY_COMPLETED requires duration_ms / outcome / etc.
      await handler({event: AnalyticsEventNames.QUERY_COMPLETED, properties: {}}, 'client-1')

      expect(analyticsClient.trackCalls, 'invalid per-event props must NOT reach track').to.deep.equal([])
    })
  })

  it('should drop invalid wire envelope silently (no throw, no track call)', async () => {
    const transport = createMockTransportServer()
    const analyticsClient = makeMockAnalyticsClient()
    new AnalyticsHandler({analyticsClient, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler

    await handler({event: ''}, 'client-1')
    await handler({properties: {x: 1}}, 'client-1')
    await handler({event: 42}, 'client-1')
    await handler(null, 'client-1')

    expect(analyticsClient.trackCalls, 'track must NOT be called for invalid envelopes').to.deep.equal([])
  })

  it('should not throw when analyticsClient.track itself throws', async () => {
    const transport = createMockTransportServer()
    const analyticsClient = makeMockAnalyticsClient()
    analyticsClient.trackThrows = new Error('boom')
    new AnalyticsHandler({analyticsClient, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler

    let caught: unknown
    try {
      await handler({event: AnalyticsEventNames.DAEMON_START}, 'client-1')
    } catch (error) {
      caught = error
    }

    expect(caught, 'handler must NOT propagate track() errors').to.equal(undefined)
  })
})
