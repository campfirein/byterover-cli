import {Args, Command, Errors, Flags} from '@oclif/core'

import {SETTINGS_KEYS} from '../../../server/core/domain/entities/settings.js'
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
import {collectConsent} from '../../lib/analytics-disclosure.js'
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
    // Accepts the analytics disclosure non-interactively. Only meaningful when
    // setting `analytics.share true` (the one consent-gated key). Passing it
    // for any other key emits `this.warn(...)` so the user does not silently
    // rely on a flag that has no behavioural effect for their command.
    yes: Flags.boolean({
      char: 'y',
      default: false,
      description: 'Accept the analytics disclosure non-interactively (only meaningful for analytics.share)',
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

    // `--yes` is only meaningful for the one consent-gated key. Warn (don't
    // refuse) for any other key so automation scripts don't silently rely on
    // a flag that has no behavioural effect.
    if (flags.yes && args.key !== SETTINGS_KEYS.ANALYTICS_ENABLED) {
      this.warn(
        `--yes is only meaningful for ${SETTINGS_KEYS.ANALYTICS_ENABLED}; ignored for '${args.key}'.`,
      )
    }

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

      if (descriptor.type === 'readonly-info') {
        process.exitCode = 1
        const message = `Setting '${args.key}' is read-only and cannot be written.`
        if (format === 'json') {
          writeJsonResponse({
            command: 'settings set',
            data: {error: {code: 'read_only', key: args.key, message}},
            success: false,
          })
        } else {
          this.log(message)
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

      // Enable-to-true on `analytics.share` triggers the disclosure
      // prompt. Idempotent (no prompt if already enabled), false-unchanged,
      // and other keys unaffected. `collectConsent`'s `onError` calls
      // `this.error()` which throws CLIError; we let it propagate to
      // oclif's exit handler (clean message, non-zero exit).
      if (
        args.key === SETTINGS_KEYS.ANALYTICS_ENABLED &&
        parsed.value === true &&
        descriptor.current !== true
      ) {
        // JSON output mode cannot host an interactive consent prompt: the
        // disclosure markdown (and inquirer's own prompt frame) would land
        // on stdout BEFORE the final JSON envelope, breaking parseability
        // for any caller piping the output. Refuse with a structured error
        // envelope instructing the caller to pass `--yes` (which both
        // confirms consent and skips the markdown print).
        if (format === 'json' && !flags.yes) {
          process.exitCode = 1
          writeJsonResponse({
            command: 'settings set',
            data: {
              error: {
                code: 'requires_consent',
                key: args.key,
                message:
                  `Enabling ${SETTINGS_KEYS.ANALYTICS_ENABLED} requires accepting the disclosure. ` +
                  'Re-run with --yes to accept non-interactively, or omit --format json to see the disclosure.',
              },
            },
            success: false,
          })
          return
        }

        // In JSON+--yes mode the consent gate is already satisfied. Skip
        // `collectConsent` entirely so its `onLog(disclosureMarkdown)` does
        // not pollute the JSON envelope on stdout.
        const accepted =
          format === 'json' && flags.yes
            ? true
            : await collectConsent({
                onError: (msg) => this.error(msg),
                onLog: (msg) => this.log(msg),
                yesFlag: flags.yes,
              })

        if (!accepted) {
          if (format === 'json') {
            writeJsonResponse({
              command: 'settings set',
              data: {accepted: false, key: args.key},
              success: true,
            })
          } else {
            this.log('Analytics not enabled')
          }

          return
        }
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
      // CLIError thrown from `this.error()` (e.g. the non-TTY disclosure
      // guard) carries its own clean message + exit code via oclif's exit
      // handler — let it propagate untouched. Everything else gets the
      // daemon-connection-friendly formatter.
      if (error instanceof Errors.CLIError) {
        throw error
      }

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
