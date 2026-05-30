import {expect} from 'chai'

import type {IAnalyticsBackoffPolicy} from '../../../../../../src/server/core/interfaces/analytics/i-analytics-backoff-policy.js'
import type {IAnalyticsClient} from '../../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'

import {AnalyticsBatch} from '../../../../../../src/server/core/domain/analytics/batch.js'
import {
  AnalyticsStatusHandler,
  consecutiveFailuresToReachabilityState,
} from '../../../../../../src/server/infra/transport/handlers/analytics-status-handler.js'
import {AnalyticsEvents} from '../../../../../../src/shared/transport/events/analytics-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

/**
 * M4.6 tests for the analytics-status surface:
 *   - the pure `consecutiveFailuresToReachabilityState` mapper
 *   - the `AnalyticsStatusHandler` composition (runtime state +
 *     backoff state + endpoint + enabled flag)
 *
 * Test doubles below are hoisted above the top-level `describe` to
 * satisfy `unicorn/consistent-function-scoping`. They cover only the
 * surfaces the handler reads from each collaborator.
 */
type RuntimeStateSnapshot = {
  droppedCount: number
  lastSuccessfulFlushAt: number | undefined
  queueDepth: number
}

function makeClientStub(state: RuntimeStateSnapshot): IAnalyticsClient {
  return {
    abort() {},
    flush: async () => AnalyticsBatch.create([]),
    getRuntimeState: async () => state,
    async onAuthTransition() {},
    track() {},
  }
}

function makePolicyStub(
  consecutiveFailures: number,
  nextDelayMs: number,
  isRateLimited = false,
): IAnalyticsBackoffPolicy {
  return {
    applyServerHint() {},
    consecutiveFailures: () => consecutiveFailures,
    isRateLimited: () => isRateLimited,
    nextDelayMs: () => nextDelayMs,
    onFailure() {},
    onSuccess() {},
  }
}

describe('M4.6 analytics status handler', () => {
describe('consecutiveFailuresToReachabilityState', () => {
  it('returns "healthy" for zero failures', () => {
    expect(consecutiveFailuresToReachabilityState(0)).to.equal('healthy')
  })

  it('returns "degraded" for one failure', () => {
    expect(consecutiveFailuresToReachabilityState(1)).to.equal('degraded')
  })

  it('returns "degraded" for two failures', () => {
    expect(consecutiveFailuresToReachabilityState(2)).to.equal('degraded')
  })

  it('returns "unreachable" at the 3-failure threshold', () => {
    expect(consecutiveFailuresToReachabilityState(3)).to.equal('unreachable')
  })

  it('returns "unreachable" for many failures (counter is unbounded)', () => {
    expect(consecutiveFailuresToReachabilityState(50)).to.equal('unreachable')
  })

  it('treats negative or NaN input defensively as "healthy" (no caller should pass these, but the mapper must not crash)', () => {
    // Defense-in-depth: the policy never produces these values, but if a
    // future change accidentally pipes a malformed counter through, the
    // user should see the most-optimistic label rather than a runtime
    // error in the status command's hot path.
    expect(consecutiveFailuresToReachabilityState(-1)).to.equal('healthy')
    expect(consecutiveFailuresToReachabilityState(Number.NaN)).to.equal('healthy')
  })
})

describe('AnalyticsStatusHandler', () => {
  it('returns the composed wire response for an enabled, healthy daemon', async () => {
    const transport = createMockTransportServer()
    const handler = new AnalyticsStatusHandler({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: 1_700_000_000_000, queueDepth: 4}),
      backoffPolicy: makePolicyStub(0, 30_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
      transport,
    })
    handler.setup()

    const fn = transport._handlers.get(AnalyticsEvents.STATUS)
    if (!fn) throw new Error('STATUS handler not registered')
    const response = await fn(undefined, 'client-1')

    expect(response).to.deep.equal({
      backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'healthy'},
      droppedCount: 0,
      enabled: true,
      endpoint: 'https://telemetry-dev.byterover.dev',
      lastFlushAt: 1_700_000_000_000,
      queueDepth: 4,
    })
  })

  it('renders "degraded" reachability when 1-2 consecutive failures', async () => {
    const transport = createMockTransportServer()
    const handler = new AnalyticsStatusHandler({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
      backoffPolicy: makePolicyStub(2, 120_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
      transport,
    })
    handler.setup()
    const fn = transport._handlers.get(AnalyticsEvents.STATUS)!
    const response = await fn(undefined, 'client-1')

    expect(response.backoff).to.deep.equal({consecutiveFailures: 2, nextDelayMs: 120_000, state: 'degraded'})
  })

  it('renders "unreachable" reachability when 3+ consecutive failures', async () => {
    const transport = createMockTransportServer()
    const handler = new AnalyticsStatusHandler({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 5}),
      backoffPolicy: makePolicyStub(5, 300_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
      transport,
    })
    handler.setup()
    const fn = transport._handlers.get(AnalyticsEvents.STATUS)!
    const response = await fn(undefined, 'client-1')

    expect(response.backoff.state).to.equal('unreachable')
    expect(response.backoff.consecutiveFailures).to.equal(5)
  })

  it('forces backoff.state to "unreachable" when endpoint is missing (empty string)', async () => {
    // BRV_ANALYTICS_BASE_URL not configured: ticket says endpoint shows
    // "(not configured)" AND state is forced to "unreachable" regardless
    // of consecutive failures.
    const transport = createMockTransportServer()
    const handler = new AnalyticsStatusHandler({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
      backoffPolicy: makePolicyStub(0, 30_000),
      endpoint: '',
      isAnalyticsEnabled: () => true,
      transport,
    })
    handler.setup()
    const fn = transport._handlers.get(AnalyticsEvents.STATUS)!
    const response = await fn(undefined, 'client-1')

    expect(response.endpoint).to.equal('(not configured)')
    expect(response.backoff.state, 'override forces unreachable when endpoint missing').to.equal('unreachable')
  })

  it('keeps the JSON shape stable when analytics is disabled (CLI hides text fields; programmatic shape unchanged)', async () => {
    const transport = createMockTransportServer()
    const handler = new AnalyticsStatusHandler({
      analyticsClient: makeClientStub({droppedCount: 7, lastSuccessfulFlushAt: 1_700_000_000_000, queueDepth: 3}),
      backoffPolicy: makePolicyStub(1, 60_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => false,
      transport,
    })
    handler.setup()
    const fn = transport._handlers.get(AnalyticsEvents.STATUS)!
    const response = await fn(undefined, 'client-1')

    expect(response.enabled).to.equal(false)
    // All other fields still populated — CLI decides whether to render them.
    expect(response.queueDepth).to.equal(3)
    expect(response.droppedCount).to.equal(7)
    expect(response.lastFlushAt).to.equal(1_700_000_000_000)
    expect(response.backoff).to.deep.equal({consecutiveFailures: 1, nextDelayMs: 60_000, state: 'degraded'})
  })

  it('omits lastFlushAt from the wire when the daemon has never shipped', async () => {
    const transport = createMockTransportServer()
    const handler = new AnalyticsStatusHandler({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 2}),
      backoffPolicy: makePolicyStub(0, 30_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
      transport,
    })
    handler.setup()
    const fn = transport._handlers.get(AnalyticsEvents.STATUS)!
    const response = await fn(undefined, 'client-1')

    expect(response.lastFlushAt, 'undefined → key absent (CLI renders "never")').to.equal(undefined)
  })
})
})
