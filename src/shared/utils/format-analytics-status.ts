/* eslint-disable camelcase -- legacy `brv analytics status --format json` envelope is snake_case. */
import type {AnalyticsStatusResponse} from '../transport/events/analytics-events.js'

import {AnalyticsStatusResponseSchema} from '../transport/events/analytics-events.js'
import {registerReadonlyInfoFormatter} from './format-readonly-info.js'

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 60 * MS_PER_MIN
const MS_PER_DAY = 24 * MS_PER_HOUR

const UNAVAILABLE_TEXT = '(unavailable)'

/**
 * Humanise a millisecond delta to a short relative-time label, matching
 * the M4.6 ticket example: `(5m ago)`. Cut points:
 *   - < 1 minute -> "just now"
 *   - < 1 hour   -> "{n}m ago"
 *   - < 1 day    -> "{n}h ago"
 *   - >= 1 day   -> "{n}d ago"
 */
export function formatRelativeAgo(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < MS_PER_MIN) return 'just now'
  if (deltaMs < MS_PER_HOUR) return `${Math.floor(deltaMs / MS_PER_MIN)}m ago`
  if (deltaMs < MS_PER_DAY) return `${Math.floor(deltaMs / MS_PER_HOUR)}h ago`
  return `${Math.floor(deltaMs / MS_PER_DAY)}d ago`
}

/**
 * Humanise a forward-looking delay in milliseconds. Cut points mirror the
 * M4.5 backoff schedule (30s, 60s, 2m, 5m).
 */
export function formatDelayMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  if (ms < MS_PER_MIN) return `${Math.floor(ms / 1000)}s`
  if (ms < MS_PER_HOUR) return `${Math.floor(ms / MS_PER_MIN)}m`
  return `${Math.floor(ms / MS_PER_HOUR)}h`
}

/**
 * Renders the analytics-status snapshot as the multi-line text block the
 * legacy `brv analytics status` command printed. The output is consumed by
 * both `brv settings get analytics.status` and `brv settings list`
 * (per-key readonly-info formatter) — and by the TUI settings page via
 * the same shared registry.
 *
 * Accepts `unknown` because the formatter registry surface is wider than
 * any single key's snapshot shape. Falls back to `(unavailable)` when
 * the value does not match `AnalyticsStatusResponseSchema`.
 */
export function formatAnalyticsStatusText(value: unknown, now: () => number = Date.now): string {
  const parsed = AnalyticsStatusResponseSchema.safeParse(value)
  if (!parsed.success) return UNAVAILABLE_TEXT

  const response = parsed.data
  if (!response.enabled) return 'Analytics: disabled'

  return [
    'Analytics: enabled',
    `Last successful flush: ${formatLastFlush(response.lastFlushAt, now)}`,
    `Queue depth: ${response.queueDepth} events`,
    `Dropped events (this session): ${response.droppedCount}`,
    `Backoff state: ${response.backoff.state} (${formatBackoffSummary(response.backoff)})`,
    `Endpoint: ${response.endpoint}`,
  ].join('\n')
}

/**
 * JSON wire shape matching the legacy `brv analytics status --format json`
 * envelope (snake_case fields). Consumed by
 * `brv settings get analytics.status --format json` so callers depending
 * on the legacy programmatic shape do not break when the legacy command
 * is deleted in M16.4.
 */
export function formatAnalyticsStatusJson(value: unknown): Readonly<Record<string, unknown>> {
  const parsed = AnalyticsStatusResponseSchema.safeParse(value)
  if (!parsed.success) return {unavailable: true}

  const response = parsed.data
  return {
    backoff: {
      consecutive_failures: response.backoff.consecutiveFailures,
      next_delay_ms: response.backoff.nextDelayMs,
      state: response.backoff.state,
    },
    dropped_events: response.droppedCount,
    enabled: response.enabled,
    endpoint: response.endpoint,
    last_flush: response.lastFlushAt === undefined ? null : new Date(response.lastFlushAt).toISOString(),
    queue_depth: response.queueDepth,
  }
}

function formatLastFlush(lastFlushAt: number | undefined, now: () => number): string {
  if (lastFlushAt === undefined) return 'never'
  const iso = new Date(lastFlushAt).toISOString()
  const ago = formatRelativeAgo(now() - lastFlushAt)
  return `${iso} (${ago})`
}

function formatBackoffSummary(backoff: AnalyticsStatusResponse['backoff']): string {
  const failurePart =
    backoff.consecutiveFailures === 1
      ? '1 consecutive failure'
      : `${backoff.consecutiveFailures} consecutive failures`
  return `${failurePart}, next attempt in ${formatDelayMs(backoff.nextDelayMs)}`
}

// Self-register the analytics.status formatter so any consumer of
// `formatReadonlyInfoValue('analytics.status', ...)` (CLI list/get,
// TUI settings page, future WebUI cleanup) gets the legacy text shape
// without an explicit boot-time registration step. M16.1's
// double-register guard makes accidental re-imports a no-op.
registerReadonlyInfoFormatter('analytics.status', formatAnalyticsStatusText)
