/* eslint-disable camelcase -- JSON wire shape is snake_case per the M4.6 ticket schema. */
import {Command, Flags} from '@oclif/core'

import {PRIVACY_POLICY_URL} from '../../../shared/constants/privacy.js'
import {AnalyticsEvents, type AnalyticsStatusResponse} from '../../../shared/transport/events/analytics-events.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'

const COMMAND_ID = 'analytics:status'

const MS_PER_MIN = 60_000
const MS_PER_HOUR = 60 * MS_PER_MIN
const MS_PER_DAY = 24 * MS_PER_HOUR

/**
 * Humanise a millisecond delta to a short relative-time label, matching
 * the M4.6 ticket example: `(5m ago)`. Cut points:
 *   - < 1 minute → "just now"
 *   - < 1 hour   → "{n}m ago"
 *   - < 1 day    → "{n}h ago"
 *   - >= 1 day   → "{n}d ago"
 *
 * Exposed for tests (also exercised indirectly via the text-output cases).
 */
export function formatRelativeAgo(deltaMs: number): string {
  if (!Number.isFinite(deltaMs) || deltaMs < MS_PER_MIN) return 'just now'
  if (deltaMs < MS_PER_HOUR) return `${Math.floor(deltaMs / MS_PER_MIN)}m ago`
  if (deltaMs < MS_PER_DAY) return `${Math.floor(deltaMs / MS_PER_HOUR)}h ago`
  return `${Math.floor(deltaMs / MS_PER_DAY)}d ago`
}

export default class Status extends Command {
  public static description = `Show analytics state: enabled flag, last successful flush, queue depth, dropped event count, backoff state, endpoint.

Analytics is opt-in (default: off). When enabled, ByteRover collects anonymous
usage telemetry (event names, CLI version, OS, Node version, environment) to
improve the product. No content of your queries, files, or memory is collected.

Privacy policy: ${PRIVACY_POLICY_URL}  (placeholder until M1.5)
Toggle: brv analytics enable | brv analytics disable`
  public static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --format json']
  public static flags = {
    format: Flags.string({
      char: 'f',
      default: 'text',
      description: 'Output format',
      options: ['text', 'json'],
    }),
  }

  protected async fetchAnalyticsStatus(options?: DaemonClientOptions): Promise<AnalyticsStatusResponse> {
    return withDaemonRetry<AnalyticsStatusResponse>(
      async (client) => client.requestWithAck<AnalyticsStatusResponse>(AnalyticsEvents.STATUS),
      options,
    )
  }

  /**
   * Test seam — overridden in unit tests to pin the relative-time
   * calculation against a fixed wall-clock. Production uses Date.now().
   */
  protected now(): number {
    return Date.now()
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Status)
    const isJson = flags.format === 'json'

    let response: AnalyticsStatusResponse
    try {
      response = await this.fetchAnalyticsStatus({projectPath: process.cwd()})
    } catch (error) {
      if (isJson) {
        writeJsonResponse({command: COMMAND_ID, data: {error: formatConnectionError(error)}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }

      return
    }

    if (isJson) {
      writeJsonResponse({command: COMMAND_ID, data: this.toJsonShape(response), success: true})
      return
    }

    this.renderText(response)
  }

  private formatLastFlush(lastFlushAt: number | undefined): string {
    if (lastFlushAt === undefined) return 'never'
    const iso = new Date(lastFlushAt).toISOString()
    const ago = formatRelativeAgo(this.now() - lastFlushAt)
    return `${iso} (${ago})`
  }

  private renderText(response: AnalyticsStatusResponse): void {
    if (!response.enabled) {
      this.log('Analytics: disabled')
      return
    }

    this.log('Analytics: enabled')
    this.log(`Last successful flush: ${this.formatLastFlush(response.lastFlushAt)}`)
    this.log(`Queue depth: ${response.queueDepth} events`)
    this.log(`Dropped events (this session): ${response.droppedCount}`)
    this.log(
      `Backoff state: ${response.backoff.state} (consecutive_failures=${response.backoff.consecutiveFailures}, next_delay_ms=${response.backoff.nextDelayMs})`,
    )
    this.log(`Endpoint: ${response.endpoint}`)
  }

  /**
   * JSON wire shape per the ticket. `last_flush` is null when undefined;
   * snake_case keys for compatibility with downstream JSON consumers.
   */
  private toJsonShape(response: AnalyticsStatusResponse): {
    backoff: {consecutive_failures: number; next_delay_ms: number; state: string}
    dropped_events: number
    enabled: boolean
    endpoint: string
    last_flush: null | string
    queue_depth: number
  } {
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
}
