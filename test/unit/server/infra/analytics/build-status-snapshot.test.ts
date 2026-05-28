import {expect} from 'chai'

import type {IAnalyticsBackoffPolicy} from '../../../../../src/server/core/interfaces/analytics/i-analytics-backoff-policy.js'
import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {buildAnalyticsStatusSnapshot} from '../../../../../src/server/infra/analytics/build-status-snapshot.js'

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

function makePolicyStub(consecutiveFailures: number, nextDelayMs: number): IAnalyticsBackoffPolicy {
  return {
    consecutiveFailures: () => consecutiveFailures,
    nextDelayMs: () => nextDelayMs,
    onFailure() {},
    onSuccess() {},
  }
}

describe('buildAnalyticsStatusSnapshot (M16.3)', () => {
  it('composes the wire response with all fields populated', async () => {
    const snapshot = await buildAnalyticsStatusSnapshot({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: 1_700_000_000_000, queueDepth: 4}),
      backoffPolicy: makePolicyStub(0, 30_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
    })

    expect(snapshot).to.deep.equal({
      backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'healthy'},
      droppedCount: 0,
      enabled: true,
      endpoint: 'https://telemetry-dev.byterover.dev',
      lastFlushAt: 1_700_000_000_000,
      queueDepth: 4,
    })
  })

  it('substitutes the (not configured) placeholder and forces unreachable when endpoint is empty', async () => {
    const snapshot = await buildAnalyticsStatusSnapshot({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
      backoffPolicy: makePolicyStub(0, 30_000),
      endpoint: '',
      isAnalyticsEnabled: () => true,
    })

    expect(snapshot.endpoint).to.equal('(not configured)')
    expect(snapshot.backoff.state).to.equal('unreachable')
  })

  it('omits lastFlushAt when the daemon has never shipped', async () => {
    const snapshot = await buildAnalyticsStatusSnapshot({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 2}),
      backoffPolicy: makePolicyStub(0, 30_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
    })

    expect(snapshot.lastFlushAt).to.equal(undefined)
  })

  it('preserves the disabled flag without dropping operational fields', async () => {
    const snapshot = await buildAnalyticsStatusSnapshot({
      analyticsClient: makeClientStub({droppedCount: 7, lastSuccessfulFlushAt: 1_700_000_000_000, queueDepth: 3}),
      backoffPolicy: makePolicyStub(1, 60_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => false,
    })

    expect(snapshot.enabled).to.equal(false)
    expect(snapshot.queueDepth).to.equal(3)
    expect(snapshot.droppedCount).to.equal(7)
    expect(snapshot.lastFlushAt).to.equal(1_700_000_000_000)
    expect(snapshot.backoff).to.deep.equal({consecutiveFailures: 1, nextDelayMs: 60_000, state: 'degraded'})
  })

  it('maps 1-2 consecutive failures to degraded', async () => {
    const snapshot = await buildAnalyticsStatusSnapshot({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
      backoffPolicy: makePolicyStub(2, 120_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
    })

    expect(snapshot.backoff.state).to.equal('degraded')
  })

  it('maps 3+ consecutive failures to unreachable', async () => {
    const snapshot = await buildAnalyticsStatusSnapshot({
      analyticsClient: makeClientStub({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 5}),
      backoffPolicy: makePolicyStub(5, 300_000),
      endpoint: 'https://telemetry-dev.byterover.dev',
      isAnalyticsEnabled: () => true,
    })

    expect(snapshot.backoff.state).to.equal('unreachable')
  })
})
