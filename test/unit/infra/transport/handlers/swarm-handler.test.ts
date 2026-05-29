/* eslint-disable camelcase */
import {expect} from 'chai'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {AnalyticsEventName} from '../../../../../src/shared/analytics/event-names.js'
import type {PropsArg} from '../../../../../src/shared/analytics/events/index.js'
import type {SwarmTrackResponse} from '../../../../../src/shared/transport/events/swarm-events.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {SwarmHandler} from '../../../../../src/server/infra/transport/handlers/swarm-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {SwarmEvents} from '../../../../../src/shared/transport/events/swarm-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

type TrackCall = {event: AnalyticsEventName; properties: unknown}

type MockAnalyticsClient = IAnalyticsClient & {
  readonly trackCalls: readonly TrackCall[]
  trackThrows?: Error
}

/**
 * Hand-rolled mock preserving `track<E>(event, ...rest: PropsArg<E>)` generics.
 * Mirrors the pattern from `migrate-handler-analytics.test.ts`.
 */
function makeMockAnalyticsClient(): MockAnalyticsClient {
  const trackCalls: TrackCall[] = []
  const mock: MockAnalyticsClient = {
    abort(): void {
      /* not exercised */
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

describe('SwarmHandler', () => {
  let transport: MockTransportServer
  let analyticsClient: MockAnalyticsClient

  beforeEach(() => {
    transport = createMockTransportServer()
    analyticsClient = makeMockAnalyticsClient()
    new SwarmHandler({analyticsClient, transport}).setup()
  })

  describe('swarm:trackQueryCompleted', () => {
    it('forwards a valid SwarmQueryCompletedProps payload to analyticsClient.track', async () => {
      const handler = transport._handlers.get(SwarmEvents.TRACK_QUERY_COMPLETED)
      if (handler === undefined) throw new Error('handler not registered')

      const response = (await handler(
        {
          duration_ms: 142,
          outcome: 'success',
          result_count: 7,
          swarm_scope: 'mixed',
          tags: ['k1', 'k2'],
        },
        'client-1',
      )) as SwarmTrackResponse

      expect(response).to.deep.equal({tracked: true})
      expect(analyticsClient.trackCalls).to.have.length(1)
      const [call] = analyticsClient.trackCalls
      expect(call.event).to.equal(AnalyticsEventNames.SWARM_QUERY_COMPLETED)
      const props = call.properties as Record<string, unknown>
      expect(props.duration_ms).to.equal(142)
      expect(props.outcome).to.equal('success')
      expect(props.result_count).to.equal(7)
      expect(props.swarm_scope).to.equal('mixed')
    })

    it('returns {tracked: false, reason: schema-rejection} for a payload missing required outcome', async () => {
      const handler = transport._handlers.get(SwarmEvents.TRACK_QUERY_COMPLETED)
      if (handler === undefined) throw new Error('handler not registered')

      const response = (await handler({duration_ms: 5}, 'client-1')) as SwarmTrackResponse

      expect(response.tracked).to.equal(false)
      expect(response.reason).to.equal('schema-rejection')
      expect(analyticsClient.trackCalls).to.have.length(0)
    })

    it('emits failure_kind when the producer indicated a failure', async () => {
      const handler = transport._handlers.get(SwarmEvents.TRACK_QUERY_COMPLETED)
      if (handler === undefined) throw new Error('handler not registered')

      await handler(
        {
          duration_ms: 88,
          failure_kind: 'provider_timeout',
          outcome: 'failure',
        },
        'client-1',
      )

      const props = analyticsClient.trackCalls[0].properties as Record<string, unknown>
      expect(props.outcome).to.equal('failure')
      expect(props.failure_kind).to.equal('provider_timeout')
    })
  })

  describe('swarm:trackStoreCompleted', () => {
    it('forwards a valid SwarmStoreCompletedProps payload', async () => {
      const handler = transport._handlers.get(SwarmEvents.TRACK_STORE_COMPLETED)
      if (handler === undefined) throw new Error('handler not registered')

      const response = (await handler(
        {
          duration_ms: 234,
          operation: 'update',
          outcome: 'success',
          skipped: 1,
          stored: 2,
          updated: 1,
        },
        'client-1',
      )) as SwarmTrackResponse

      expect(response).to.deep.equal({tracked: true})
      const [call] = analyticsClient.trackCalls
      expect(call.event).to.equal(AnalyticsEventNames.SWARM_STORE_COMPLETED)
      const props = call.properties as Record<string, unknown>
      expect(props.operation).to.equal('update')
      expect(props.stored).to.equal(2)
    })

    it('rejects when `operation` field is missing (required by schema)', async () => {
      const handler = transport._handlers.get(SwarmEvents.TRACK_STORE_COMPLETED)
      if (handler === undefined) throw new Error('handler not registered')

      const response = (await handler({duration_ms: 5, outcome: 'success'}, 'client-1')) as SwarmTrackResponse
      expect(response.tracked).to.equal(false)
      expect(response.reason).to.equal('schema-rejection')
    })
  })

  describe('swarm:trackOnboarded', () => {
    it('forwards a valid SwarmOnboardedProps payload', async () => {
      const handler = transport._handlers.get(SwarmEvents.TRACK_ONBOARDED)
      if (handler === undefined) throw new Error('handler not registered')

      const response = (await handler(
        {
          duration_ms: 1024,
          member_count: 3,
          outcome: 'success',
          swarm_kind: 'new',
        },
        'client-1',
      )) as SwarmTrackResponse

      expect(response).to.deep.equal({tracked: true})
      const [call] = analyticsClient.trackCalls
      expect(call.event).to.equal(AnalyticsEventNames.SWARM_ONBOARDED)
      const props = call.properties as Record<string, unknown>
      expect(props.swarm_kind).to.equal('new')
      expect(props.member_count).to.equal(3)
    })
  })

  describe('graceful degradation', () => {
    // Run the degradation checks across every event so a future divergence
    // (e.g. one handler refactored, others not) fails loudly.
    const VALID_PAYLOAD_BY_EVENT: Record<string, Record<string, unknown>> = {
      [SwarmEvents.TRACK_ONBOARDED]: {duration_ms: 1, member_count: 1, outcome: 'success', swarm_kind: 'new'},
      [SwarmEvents.TRACK_QUERY_COMPLETED]: {duration_ms: 1, outcome: 'success'},
      [SwarmEvents.TRACK_STORE_COMPLETED]: {duration_ms: 1, operation: 'create', outcome: 'success'},
    }

    for (const eventName of Object.values(SwarmEvents)) {
      it(`returns {tracked: false, reason: analytics-unavailable} for ${eventName} when no analyticsClient is wired`, async () => {
        const standaloneTransport = createMockTransportServer()
        new SwarmHandler({transport: standaloneTransport}).setup()
        const handler = standaloneTransport._handlers.get(eventName)
        if (handler === undefined) throw new Error('handler not registered')

        const response = (await handler(VALID_PAYLOAD_BY_EVENT[eventName], 'client-1')) as SwarmTrackResponse

        expect(response.tracked).to.equal(false)
        expect(response.reason).to.equal('analytics-unavailable')
      })

      it(`returns {tracked: false, reason: analytics-throw} for ${eventName} when track() throws`, async () => {
        const handler = transport._handlers.get(eventName)
        if (handler === undefined) throw new Error('handler not registered')
        analyticsClient.trackThrows = new Error('queue full')

        const response = (await handler(VALID_PAYLOAD_BY_EVENT[eventName], 'client-1')) as SwarmTrackResponse

        expect(response.tracked).to.equal(false)
        expect(response.reason).to.equal('analytics-throw')
      })
    }
  })
})
