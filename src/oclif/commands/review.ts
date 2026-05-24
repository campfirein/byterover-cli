import {Command, Flags} from '@oclif/core'

import {
  ReviewEvents,
  type ReviewGetDisabledResponse,
  type ReviewSetDisabledResponse,
} from '../../shared/transport/events/review-events.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../lib/daemon-client.js'
import {writeJsonResponse} from '../lib/json-response.js'

export default class Review extends Command {
  public static description = `Toggle the HITL review log for the current project

When disabled:
- 'brv curate' (sync mode) no longer prints the "X operations require review" prompt
- Curate-log entries no longer carry the per-operation review marker
- 'brv review pending' will not list any new entries until re-enabled`
  public static examples = [
    '# Show current state',
    '<%= config.bin %> <%= command.id %>',
    '',
    '# Disable the review log for this project',
    '<%= config.bin %> <%= command.id %> --disable',
    '',
    '# Re-enable the review log',
    '<%= config.bin %> <%= command.id %> --enable',
  ]
  public static flags = {
    disable: Flags.boolean({
      default: false,
      description: 'Disable the HITL review log for this project',
      exclusive: ['enable'],
    }),
    enable: Flags.boolean({
      default: false,
      description: 'Re-enable the HITL review log for this project',
      exclusive: ['disable'],
    }),
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Review)
    const format: 'json' | 'text' = flags.format === 'json' ? 'json' : 'text'

    try {
      if (flags.disable || flags.enable) {
        const target = flags.disable
        const response = await withDaemonRetry(
          (client) =>
            client.requestWithAck<ReviewSetDisabledResponse>(ReviewEvents.SET_DISABLED, {reviewDisabled: target}),
          this.getDaemonClientOptions(),
        )
        this.reportToggle(response.reviewDisabled, format)
        return
      }

      const response = await withDaemonRetry(
        (client) => client.requestWithAck<ReviewGetDisabledResponse>(ReviewEvents.GET_DISABLED, {}),
        this.getDaemonClientOptions(),
      )
      this.reportStatus(response.reviewDisabled, format)
    } catch (error) {
      this.reportError(error, format)
    }
  }

  private reportError(error: unknown, format: 'json' | 'text'): void {
    const message = error instanceof Error ? error.message : 'Review failed'
    if (format === 'json') {
      writeJsonResponse({
        command: 'review',
        data: {error: message, status: 'error'},
        success: false,
      })
      return
    }

    this.log(formatConnectionError(error))
  }

  private reportStatus(disabled: boolean, format: 'json' | 'text'): void {
    if (format === 'json') {
      writeJsonResponse({
        command: 'review',
        data: {reviewDisabled: disabled, status: 'success'},
        success: true,
      })
      return
    }

    this.log(disabled ? 'Review log is disabled.' : 'Review log is enabled.')
  }

  private reportToggle(disabled: boolean, format: 'json' | 'text'): void {
    if (format === 'json') {
      writeJsonResponse({
        command: 'review',
        data: {reviewDisabled: disabled, status: 'success'},
        success: true,
      })
      return
    }

    this.log(
      disabled
        ? `Review log disabled. To re-enable: ${this.config.bin} review --enable`
        : `Review log enabled. To disable: ${this.config.bin} review --disable`,
    )
  }
}
