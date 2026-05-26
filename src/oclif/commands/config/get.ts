import {Args, Command, Flags} from '@oclif/core'

import type {BrvConfig} from '../../../server/core/domain/entities/brv-config.js'

import {ProjectConfigStore} from '../../../server/infra/config/file-config-store.js'
import {resolveProjectRoot} from '../../lib/curate-session.js'
import {writeJsonResponse} from '../../lib/json-response.js'

/**
 * `brv config get <key>` — read one field from `.brv/config.json`.
 *
 * Returns the stored value, or "(not set)" when the field is absent. Keyed
 * by the same string map as `config set` so symmetry is preserved.
 */
export default class ConfigGet extends Command {
  public static args = {
    key: Args.string({description: 'Project config key (e.g. language.mode, language.code)', required: true}),
  }
  public static description = 'Read a project configuration value from .brv/config.json'
  public static examples = [
    '<%= config.bin %> <%= command.id %> language.mode',
    '<%= config.bin %> <%= command.id %> language.code',
    '<%= config.bin %> <%= command.id %> language.mode --format json',
  ]
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ConfigGet)
    const format = flags.format as 'json' | 'text'

    const projectRoot = resolveProjectRoot()
    const config = await new ProjectConfigStore().read(projectRoot)

    if (config === undefined) {
      this.fail(format, 'no-config', `No .brv/config.json found at ${projectRoot}.`)
      return
    }

    const result = applyConfigGet(config, args.key)
    if (result.kind === 'error') {
      this.fail(format, result.code, result.message)
      return
    }

    if (format === 'json') {
      writeJsonResponse({command: 'config get', data: {key: args.key, value: result.value}, success: true})
    } else {
      this.log(result.value ?? '(not set)')
    }
  }

  private fail(format: 'json' | 'text', code: string, message: string): void {
    process.exitCode = 1
    if (format === 'json') {
      writeJsonResponse({command: 'config get', data: {error: {code, message}}, success: false})
    } else {
      this.log(message)
    }
  }
}

export type ConfigGetResult =
  | {readonly code: string; readonly kind: 'error'; readonly message: string}
  | {readonly kind: 'ok'; readonly value: string | undefined}

type ConfigGetter = (config: BrvConfig) => string | undefined

const GETTERS: Record<string, ConfigGetter> = {
  'language.code': (config) => config.language?.code,
  'language.mode': (config) => config.language?.mode,
}

/**
 * Pure dispatcher mirroring `applyConfigSet` so the CLI and unit tests
 * share one read-side path.
 */
export function applyConfigGet(config: BrvConfig, key: string): ConfigGetResult {
  const getter = GETTERS[key]
  if (getter === undefined) {
    const supported = Object.keys(GETTERS).sort().join(', ')
    return {
      code: 'unknown-key',
      kind: 'error',
      message: `Unknown config key '${key}'. Supported keys: ${supported}.`,
    }
  }

  return {kind: 'ok', value: getter(config)}
}
