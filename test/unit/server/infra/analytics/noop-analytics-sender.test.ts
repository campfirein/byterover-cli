/* eslint-disable camelcase */
import {expect} from 'chai'

import type {StoredAnalyticsRecord} from '../../../../../src/shared/analytics/stored-record.js'

import {NoopAnalyticsSender} from '../../../../../src/server/infra/analytics/noop-analytics-sender.js'

function makeRecord(id: string): StoredAnalyticsRecord {
  return {
    attempts: 0,
    id,
    identity: {device_id: '550e8400-e29b-41d4-a716-446655440000', user_id: 'user-123'},
    name: 'daemon_start',
    properties: {cli_version: '3.12.0'},
    status: 'pending',
    timestamp: 1_700_000_000_000,
  } satisfies StoredAnalyticsRecord
}

describe('NoopAnalyticsSender (graceful-degradation sender)', () => {
  it('marks every input id as succeeded so JSONL drains', async () => {
    const sender = new NoopAnalyticsSender()
    const result = await sender.send([makeRecord('a'), makeRecord('b'), makeRecord('c')])
    expect(result).to.deep.equal({failed: [], succeeded: ['a', 'b', 'c']})
  })

  it('returns empty arrays for an empty batch', async () => {
    const sender = new NoopAnalyticsSender()
    const result = await sender.send([])
    expect(result).to.deep.equal({failed: [], succeeded: []})
  })

  it('ignores the AbortSignal option and never throws', async () => {
    const sender = new NoopAnalyticsSender()
    const controller = new AbortController()
    controller.abort()
    const result = await sender.send([makeRecord('a')], {signal: controller.signal})
    expect(result.succeeded).to.deep.equal(['a'])
    expect(result.failed).to.deep.equal([])
  })

  it('does not invoke any collaborator (no deps to inject means none can be touched)', async () => {
    // Structural assertion: NoopAnalyticsSender has a zero-arg constructor.
    // If a future refactor introduces deps, this no-arg construction line
    // would fail to type-check, surfacing the regression at compile time.
    const sender = new NoopAnalyticsSender()
    expect(sender).to.be.an.instanceOf(NoopAnalyticsSender)
  })
})
