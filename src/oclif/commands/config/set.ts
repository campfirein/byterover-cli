import {Args, Command, Flags} from '@oclif/core'

import type {BrvConfig} from '../../../server/core/domain/entities/brv-config.js'

import {ProjectConfigStore} from '../../../server/infra/config/file-config-store.js'
import {resolveProjectRoot} from '../../lib/curate-session.js'
import {writeJsonResponse} from '../../lib/json-response.js'

/**
 * `brv config set <key> <value>` — mutate one field in `.brv/config.json`.
 *
 * Currently a stub: the language keys (`language.mode`, `language.code`) are
 * intercepted upstream and redirected to `brv settings set` (they moved to
 * global daemon settings in ENG-2974). No other project-config keys are
 * user-settable today. The dispatcher infrastructure (`SETTERS`,
 * `applyConfigSet`) is kept so the next project-config key can be added by
 * a one-line entry rather than rebuilding the surface from scratch.
 *
 * For runtime daemon settings (concurrency, LLM budgets, language, etc.),
 * use `brv settings set` instead.
 */
export default class ConfigSet extends Command {
  public static args = {
    key: Args.string({description: 'Project config key', required: true}),
    value: Args.string({description: 'New value', required: true}),
  }
  public static description =
    'Set a project configuration value in .brv/config.json. For global daemon settings see `brv settings set`.'
  public static examples = [
    '# Language settings moved to global config — use `brv settings set` instead',
    '<%= config.bin %> settings set language.mode fixed',
    '<%= config.bin %> settings set language.code ja',
  ]
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ConfigSet)
    const format = flags.format as 'json' | 'text'

    if (args.key === 'language.mode' || args.key === 'language.code') {
      this.fail(
        format,
        'deprecated-key',
        `'${args.key}' has moved to global settings. Run: brv settings set ${args.key} ${args.value}`,
      )
      return
    }

    const projectRoot = resolveProjectRoot()
    const store = new ProjectConfigStore()
    const current = await store.read(projectRoot)

    if (current === undefined) {
      this.fail(
        format,
        'no-config',
        `No .brv/config.json found at ${projectRoot}. Run \`brv init\` (or any \`brv\` command in this project) to create one.`,
      )
      return
    }

    const result = applyConfigSet(current, args.key, args.value)
    if (result.kind === 'error') {
      this.fail(format, result.code, result.message)
      return
    }

    await store.write(result.config, projectRoot)
    this.success(format, args.key, args.value)
  }

  private fail(format: 'json' | 'text', code: string, message: string): void {
    process.exitCode = 1
    if (format === 'json') {
      writeJsonResponse({command: 'config set', data: {error: {code, message}}, success: false})
    } else {
      this.log(message)
    }
  }

  private success(format: 'json' | 'text', key: string, value: string): void {
    if (format === 'json') {
      writeJsonResponse({command: 'config set', data: {key, value}, success: true})
    } else {
      this.log(`Setting saved: ${key} = ${value}.`)
    }
  }
}

export type ConfigSetResult =
  | {readonly code: string; readonly kind: 'error'; readonly message: string}
  | {readonly config: BrvConfig; readonly kind: 'ok'}

type ConfigSetter = (config: BrvConfig, value: string) => ConfigSetResult

/**
 * Project-config dispatcher. Empty today — the language keys that used to
 * live here moved to global daemon settings (see `brv settings set`). New
 * project-config keys are wired by adding a one-line entry here pointing
 * at a `(config, value) => ConfigSetResult` setter function.
 */
const SETTERS: Record<string, ConfigSetter> = {}

/**
 * Dispatch a `<key> <value>` set onto a loaded BrvConfig. Pure function so
 * the CLI command and unit tests share one validation path — no filesystem
 * or oclif coupling. With no live setters today, every call returns
 * `unknown-key`; the command's deprecation interceptor catches the legacy
 * `language.*` keys before reaching this function.
 */
export function applyConfigSet(config: BrvConfig, key: string, value: string): ConfigSetResult {
  const setter = SETTERS[key]
  if (setter === undefined) {
    return {
      code: 'unknown-key',
      kind: 'error',
      message: `Unknown config key '${key}'. No project-config keys are settable today; runtime settings live behind \`brv settings set\`.`,
    }
  }

  return setter(config, value)
}
