import {Command, Flags} from '@oclif/core'

import {
  SettingsEvents,
  type SettingsItemDTO,
  type SettingsListResponse,
} from '../../../shared/transport/events/settings-events.js'
// Side-effect import: registers the `analytics.status` readonly-info text
// formatter into the shared registry. Without this, a cold-start `brv settings`
// invocation that does not transitively load any other module containing the
// side-effect would render `analytics.status` rows as a raw JSON dump.
import '../../../shared/utils/format-analytics-status.js'
import {formatCount, formatDuration} from '../../../shared/utils/format-duration.js'
import {formatReadonlyInfoValue} from '../../../shared/utils/format-readonly-info.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'

type CategoryName = 'analytics' | 'concurrency' | 'llm' | 'task-history' | 'updates'

const CATEGORY_ORDER: readonly CategoryName[] = ['concurrency', 'llm', 'task-history', 'updates', 'analytics']

const CATEGORY_HEADERS: Readonly<Record<CategoryName, string>> = {
  analytics: 'ANALYTICS',
  concurrency: 'CONCURRENCY',
  llm: 'LLM',
  'task-history': 'TASK HISTORY',
  updates: 'UPDATES',
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
  if (item.type === 'readonly-info') {
    // List view is single-line per row. If the per-key formatter returns
    // a multi-line snapshot (e.g. `analytics.status`), surface only the
    // headline so the table stays aligned; users see the full block via
    // `brv settings get <key>`.
    const fullText = formatReadonlyInfoValue(item.key, item.current)
    const headline = fullText.split('\n')[0]
    return `  ${pad(item.key, 40)}  ${headline}`
  }

  const current = renderWritableValue(item, item.current)
  const defaultStr = item.default === undefined ? '' : renderWritableValue(item, item.default)
  const range = renderRange(item)
  return `  ${pad(item.key, 40)}  ${pad(current, 7)}  (default ${defaultStr})${''.padEnd(Math.max(0, 8 - defaultStr.length))}  ${range}`
}

function renderWritableValue(item: SettingsItemDTO, value: boolean | number | Readonly<Record<string, unknown>> | undefined): string {
  if (value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return renderInteger(item, value)
  // Defensive — writable descriptors never carry object payloads. If a
  // future regression smuggles one in, format-via-JSON instead of NaN.
  return JSON.stringify(value)
}

function renderInteger(item: SettingsItemDTO, value: number): string {
  if (item.unit === 'ms') return formatDuration(value)
  return formatCount(value)
}

function renderRange(item: SettingsItemDTO): string {
  if (item.type !== 'integer' || item.min === undefined || item.max === undefined) return ''
  const min = renderInteger(item, item.min)
  const max = renderInteger(item, item.max)
  const base = `${min}-${max}`
  if (item.key === 'llm.requestTimeoutMs') return `${base}, max loop budget`
  return base
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length)
}
