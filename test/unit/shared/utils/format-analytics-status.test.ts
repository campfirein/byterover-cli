/* eslint-disable camelcase -- legacy `brv analytics status --format json` envelope is snake_case. */
import {expect} from 'chai'

import type {AnalyticsStatusResponse} from '../../../../src/shared/transport/events/analytics-events.js'

import {
  formatAnalyticsStatusJson,
  formatAnalyticsStatusText,
} from '../../../../src/shared/utils/format-analytics-status.js'

const PINNED_NOW = 1_700_000_000_000

const HEALTHY: AnalyticsStatusResponse = {
  backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'healthy'},
  droppedCount: 0,
  enabled: true,
  endpoint: 'https://telemetry-dev.byterover.dev',
  lastFlushAt: PINNED_NOW - 5 * 60_000,
  queueDepth: 4,
}

function formatAt(response: AnalyticsStatusResponse): string {
  return formatAnalyticsStatusText(response, () => PINNED_NOW)
}

describe('format-analytics-status (M16.3)', () => {
 describe('formatAnalyticsStatusText', () => {
  const format = formatAt

  it('disabled state: only shows "Analytics: disabled" (other fields suppressed)', () => {
    const text = format({...HEALTHY, enabled: false})
    expect(text).to.equal('Analytics: disabled')
  })

  it('enabled, never flushed: "Last successful flush: never"', () => {
    const text = format({...HEALTHY, lastFlushAt: undefined})
    expect(text).to.include('Analytics: enabled')
    expect(text).to.include('Last successful flush: never')
  })

  it('enabled, flushed 5 minutes ago: ISO timestamp with relative time', () => {
    const text = format(HEALTHY)
    expect(text).to.include('Last successful flush:')
    expect(text).to.include('2023-11-14T22:08:20')
    expect(text).to.include('(5m ago)')
  })

  it('"just now" for sub-minute deltas', () => {
    const text = format({...HEALTHY, lastFlushAt: PINNED_NOW - 30_000})
    expect(text).to.include('(just now)')
  })

  it('hours-then-days relative formatting', () => {
    expect(format({...HEALTHY, lastFlushAt: PINNED_NOW - 3 * 60 * 60_000})).to.include('(3h ago)')
    expect(format({...HEALTHY, lastFlushAt: PINNED_NOW - 2 * 24 * 60 * 60_000})).to.include('(2d ago)')
  })

  it('backoff state "degraded": label + consecutive failures + humanized delay', () => {
    const text = format({
      ...HEALTHY,
      backoff: {consecutiveFailures: 2, nextDelayMs: 120_000, state: 'degraded'},
    })
    expect(text).to.include('Backoff state: degraded')
    expect(text).to.include('2 consecutive failures')
    expect(text).to.include('next attempt in 2m')
  })

  it('singularises "1 consecutive failure" on a single-failure backoff', () => {
    const text = format({
      ...HEALTHY,
      backoff: {consecutiveFailures: 1, nextDelayMs: 60_000, state: 'degraded'},
    })
    expect(text).to.include('1 consecutive failure')
    expect(text).to.not.include('1 consecutive failures')
    expect(text).to.include('next attempt in 1m')
  })

  it('endpoint not configured: shows literal placeholder + unreachable backoff', () => {
    const text = format({
      ...HEALTHY,
      backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'unreachable'},
      endpoint: '(not configured)',
    })
    expect(text).to.include('Endpoint: (not configured)')
    expect(text).to.include('Backoff state: unreachable')
  })

  it('shows queue depth and dropped events on enabled state', () => {
    const text = format({...HEALTHY, droppedCount: 7, queueDepth: 12})
    expect(text).to.include('Queue depth: 12 events')
    expect(text).to.include('Dropped events (this session): 7')
  })

  it('returns the unavailable placeholder when value is not a valid snapshot shape', () => {
    const noValue: {value?: unknown} = {}
    expect(formatAnalyticsStatusText(noValue.value)).to.equal('(unavailable)')
    expect(formatAnalyticsStatusText({garbage: true})).to.equal('(unavailable)')
    expect(formatAnalyticsStatusText(null)).to.equal('(unavailable)')
  })
 })

 describe('formatAnalyticsStatusJson', () => {
  it('emits the legacy snake_case envelope on enabled state', () => {
    const flushAt = PINNED_NOW - 5 * 60_000
    const json = formatAnalyticsStatusJson({...HEALTHY, lastFlushAt: flushAt})
    expect(json).to.deep.equal({
      backoff: {
        consecutive_failures: 0,
        next_delay_ms: 30_000,
        state: 'healthy',
      },
      dropped_events: 0,
      enabled: true,
      endpoint: 'https://telemetry-dev.byterover.dev',
      last_flush: new Date(flushAt).toISOString(),
      queue_depth: 4,
    })
  })

  it('last_flush is null when undefined', () => {
    const json = formatAnalyticsStatusJson({...HEALTHY, lastFlushAt: undefined})
    if ('unavailable' in json) {
      expect.fail('expected a valid JSON shape')
      return
    }

    expect(json.last_flush).to.equal(null)
  })

  it('returns the unavailable shape when value is not a valid snapshot', () => {
    const json = formatAnalyticsStatusJson({garbage: true})
    expect(json).to.deep.equal({unavailable: true})
  })
 })
})
