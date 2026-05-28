import {Args, Command, Flags} from '@oclif/core'

import {
  SettingsEvents,
  type SettingsGetRequest,
  type SettingsGetResponse,
  type SettingsItemDTO,
} from '../../../shared/transport/events/settings-events.js'
import {formatCount, formatDuration} from '../../../shared/utils/format-duration.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'

export default class SettingsGet extends Command {
  public static args = {
    key: Args.string({description: 'Settings key to read', required: true}),
  }
  public static description =
    'Read one settings value. Changes apply after `brv restart`.'
  public static examples = [
    '<%= config.bin %> settings get agentPool.maxSize',
    '<%= config.bin %> settings get agentPool.maxSize --format json',
  ]
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  protected async fetchSetting(key: string, options?: DaemonClientOptions): Promise<SettingsGetResponse> {
    return withDaemonRetry<SettingsGetResponse>(
      async (client) =>
        client.requestWithAck<SettingsGetResponse>(SettingsEvents.GET, {key} satisfies SettingsGetRequest),
      options,
    )
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(SettingsGet)
    const format = flags.format as 'json' | 'text'

    try {
      const response = await this.fetchSetting(args.key)

      if (response.ok) {
        if (format === 'json') {
          writeJsonResponse({
            command: 'settings get',
            data: this.toJsonPayload(response),
            success: true,
          })
        } else {
          this.printTextBlock(response)
        }

        return
      }

      process.exitCode = 1
      if (format === 'json') {
        writeJsonResponse({command: 'settings get', data: {error: response.error}, success: false})
      } else {
        this.log(response.error.message)
      }
    } catch (error) {
      process.exitCode = 1
      if (format === 'json') {
        writeJsonResponse({command: 'settings get', data: {error: formatConnectionError(error)}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }
    }
  }

  private printTextBlock(item: SettingsItemDTO): void {
    this.log(item.key)
    this.log(`  current: ${renderValue(item, item.current)}`)
    this.log(`  default: ${renderValue(item, item.default)}`)
    if (item.type === 'integer' && item.min !== undefined && item.max !== undefined) {
      const range = `${renderInteger(item, item.min)}-${renderInteger(item, item.max)}`
      this.log(`  range:   ${range}`)
    }

    this.log(`  scope:   ${item.scope ?? 'global'}`)
  }

  private toJsonPayload(item: SettingsItemDTO): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      current: item.current,
      default: item.default,
      description: item.description,
      key: item.key,
      max: item.max,
      min: item.min,
      restartRequired: item.restartRequired,
      type: item.type,
    }
    if (item.category !== undefined) payload.category = item.category
    if (item.unit !== undefined) payload.unit = item.unit
    if (item.scope !== undefined) payload.scope = item.scope
    return payload
  }
}

function renderValue(item: SettingsItemDTO, value: boolean | number): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return renderInteger(item, value)
}

function renderInteger(item: SettingsItemDTO, value: number): string {
  if (item.unit === 'ms') return formatDuration(value)
  return formatCount(value)
}
