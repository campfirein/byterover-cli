import {Args, Command, Flags} from '@oclif/core'

import {
  SettingsEvents,
  type SettingsGetRequest,
  type SettingsGetResponse,
  type SettingsItemDTO,
  type SettingsSetRequest,
  type SettingsSetResponse,
} from '../../../shared/transport/events/settings-events.js'
import {
  type DurationParseError,
  formatCount,
  formatDuration,
  parseDuration,
} from '../../../shared/utils/format-duration.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'

const DURATION_RE = /\d+\s*(?:ms|s|m|h)/i

export default class SettingsSet extends Command {
  public static args = {
    key: Args.string({description: 'Settings key to write', required: true}),
    value: Args.string({
      description:
        'New value (integer for count keys, duration like 30m / 1h 30m / 1800000 for ms keys, boolean true/false/on/off/1/0/yes/no for boolean keys)',
      required: true,
    }),
  }
  public static description =
    'Update one settings value. Changes apply after `brv restart`.'
  public static examples = [
    '<%= config.bin %> settings set agentPool.maxSize 25',
    '<%= config.bin %> settings set llm.iterationBudgetMs 30m',
    '<%= config.bin %> settings set agentPool.maxSize 25 --format json',
  ]
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  protected async fetchDescriptor(key: string, options?: DaemonClientOptions): Promise<SettingsGetResponse> {
    return withDaemonRetry<SettingsGetResponse>(
      async (client) =>
        client.requestWithAck<SettingsGetResponse>(SettingsEvents.GET, {key} satisfies SettingsGetRequest),
      options,
    )
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(SettingsSet)
    const format = flags.format as 'json' | 'text'

    try {
      const descriptor = await this.fetchDescriptor(args.key)
      if (!descriptor.ok) {
        process.exitCode = 1
        if (format === 'json') {
          writeJsonResponse({command: 'settings set', data: {error: descriptor.error}, success: false})
        } else {
          this.log(descriptor.error.message)
        }

        return
      }

      const parsed = parseValue(descriptor, args.value)
      if (parsed.kind === 'error') {
        process.exitCode = 1
        if (format === 'json') {
          writeJsonResponse({
            command: 'settings set',
            data: {error: {code: 'invalid_value', key: args.key, message: parsed.message, value: args.value}},
            success: false,
          })
        } else {
          this.log(parsed.message)
        }

        return
      }

      const response = await this.writeSetting(args.key, parsed.value)

      if (response.ok) {
        if (format === 'json') {
          writeJsonResponse({
            command: 'settings set',
            data: {restartRequired: response.restartRequired, value: parsed.value},
            success: true,
          })
        } else {
          const base = `Setting saved: ${args.key} = ${parsed.display}.`
          this.log(response.restartRequired ? `${base} Run \`brv restart\` to apply.` : base)
        }

        return
      }

      process.exitCode = 1
      if (format === 'json') {
        writeJsonResponse({command: 'settings set', data: {error: response.error}, success: false})
      } else {
        this.log(response.error.message)
      }
    } catch (error) {
      process.exitCode = 1
      if (format === 'json') {
        writeJsonResponse({command: 'settings set', data: {error: formatConnectionError(error)}, success: false})
      } else {
        this.log(formatConnectionError(error))
      }
    }
  }

  protected async writeSetting(
    key: string,
    value: boolean | number,
    options?: DaemonClientOptions,
  ): Promise<SettingsSetResponse> {
    return withDaemonRetry<SettingsSetResponse>(
      async (client) =>
        client.requestWithAck<SettingsSetResponse>(SettingsEvents.SET, {key, value} satisfies SettingsSetRequest),
      options,
    )
  }
}

type ParseResult =
  | {readonly display: string; readonly kind: 'ok'; readonly value: boolean | number}
  | {readonly kind: 'error'; readonly message: string}

const BOOLEAN_TOKENS = new Map<string, boolean>([
  ['0', false],
  ['1', true],
  ['false', false],
  ['no', false],
  ['off', false],
  ['on', true],
  ['true', true],
  ['yes', true],
])

const BOOLEAN_TOKENS_HINT = 'true, false, on, off, 1, 0, yes, no'

function parseValue(descriptor: SettingsItemDTO, raw: string): ParseResult {
  if (descriptor.type === 'boolean') return parseAsBoolean(descriptor, raw)
  if (descriptor.unit === 'ms') return parseAsDuration(descriptor, raw)
  return parseAsCount(descriptor, raw)
}

function parseAsBoolean(descriptor: SettingsItemDTO, raw: string): ParseResult {
  const lowered = raw.trim().toLowerCase()
  const value = BOOLEAN_TOKENS.get(lowered)
  if (value === undefined) {
    return {
      kind: 'error',
      message: `${descriptor.key} expected boolean (${BOOLEAN_TOKENS_HINT}), got '${raw}'.`,
    }
  }

  return {display: String(value), kind: 'ok', value}
}

function parseAsDuration(descriptor: SettingsItemDTO, raw: string): ParseResult {
  const parsed = parseDuration(raw)
  if (typeof parsed === 'number') {
    return {display: formatDuration(parsed), kind: 'ok', value: parsed}
  }

  return {kind: 'error', message: describeParseError(descriptor.key, parsed)}
}

function parseAsCount(descriptor: SettingsItemDTO, raw: string): ParseResult {
  if (DURATION_RE.test(raw)) {
    return {
      kind: 'error',
      message: `${descriptor.key} expects an integer count, got duration '${raw}'.`,
    }
  }

  const stripped = raw.replaceAll(',', '').trim()
  if (stripped === '' || !/^-?\d+$/.test(stripped)) {
    return {
      kind: 'error',
      message: `${descriptor.key} expects an integer count, got '${raw}'.`,
    }
  }

  const numeric = Number.parseInt(stripped, 10)
  if (!Number.isFinite(numeric)) {
    return {
      kind: 'error',
      message: `${descriptor.key} expects an integer count, got '${raw}'.`,
    }
  }

  return {display: formatCount(numeric), kind: 'ok', value: numeric}
}

function describeParseError(key: string, error: DurationParseError): string {
  return `${key}: ${error.hint}`
}
