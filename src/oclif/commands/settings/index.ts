import {Command, Flags} from '@oclif/core'

import {
  SettingsEvents,
  type SettingsItemDTO,
  type SettingsListResponse,
} from '../../../shared/transport/events/settings-events.js'
import {formatCount, formatDuration} from '../../../shared/utils/format-duration.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'

type CategoryName = 'concurrency' | 'llm' | 'task-history'

const CATEGORY_ORDER: readonly CategoryName[] = ['concurrency', 'llm', 'task-history']

const CATEGORY_HEADERS: Readonly<Record<CategoryName, string>> = {
  concurrency: 'CONCURRENCY',
  llm: 'LLM',
  'task-history': 'TASK HISTORY',
}

const OTHER_HEADER = 'OTHER'

export default class Settings extends Command {
  public static description =
    'List user-configurable BRV settings. Changes apply after `brv restart`.'
  public static examples = ['<%= config.bin %> settings', '<%= config.bin %> settings --format json']
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  protected async fetchSettings(options?: DaemonClientOptions): Promise<SettingsListResponse> {
    return withDaemonRetry<SettingsListResponse>(
      async (client) => client.requestWithAck<SettingsListResponse>(SettingsEvents.LIST),
      options,
    )
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(Settings)
    const format = flags.format as 'json' | 'text'

    try {
      const response = await this.fetchSettings()

      if (format === 'json') {
        writeJsonResponse({command: 'settings', data: {items: response.items}, success: true})
        return
      }

      this.printGroupedList(response)
    } catch (error) {
      if (format === 'json') {
        writeJsonResponse({command: 'settings', data: {error: formatConnectionError(error)}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }
    }
  }

  private printGroupedList(response: SettingsListResponse): void {
    this.log('Settings - scope: global')
    this.log('Run `brv restart` to apply changes.')
    this.log('')

    if (response.items.length === 0) {
      this.log('No settings registered.')
      return
    }

    const byCategory = groupByCategory(response.items)

    for (const category of CATEGORY_ORDER) {
      const rows = byCategory.get(category)
      if (!rows || rows.length === 0) continue
      this.log(CATEGORY_HEADERS[category])
      for (const row of rows) this.log(formatRow(row))
      this.log('')
    }

    const otherRows = byCategory.get('__other__')
    if (otherRows && otherRows.length > 0) {
      this.log(OTHER_HEADER)
      for (const row of otherRows) this.log(formatRow(row))
      this.log('')
    }

    this.log('Set:   brv settings set <key> <value>')
    this.log('Reset: brv settings reset <key>')
  }
}

function groupByCategory(items: readonly SettingsItemDTO[]): Map<string, SettingsItemDTO[]> {
  const map = new Map<string, SettingsItemDTO[]>()
  for (const item of items) {
    const bucket = item.category ?? '__other__'
    const list = map.get(bucket) ?? []
    list.push(item)
    map.set(bucket, list)
  }

  return map
}

function formatRow(item: SettingsItemDTO): string {
  const current = renderValue(item, item.current)
  const defaultStr = renderValue(item, item.default)
  const range = renderRange(item)
  return `  ${pad(item.key, 40)}  ${pad(current, 7)}  (default ${defaultStr})${''.padEnd(Math.max(0, 8 - defaultStr.length))}  ${range}`
}

function renderValue(item: SettingsItemDTO, value: number): string {
  if (item.unit === 'ms') return formatDuration(value)
  return formatCount(value)
}

function renderRange(item: SettingsItemDTO): string {
  const min = renderValue(item, item.min)
  const max = renderValue(item, item.max)
  const base = `${min}-${max}`
  if (item.key === 'llm.requestTimeoutMs') return `${base}, max loop budget`
  return base
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}
