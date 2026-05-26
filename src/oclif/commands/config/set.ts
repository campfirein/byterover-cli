import {Args, Command, Flags} from '@oclif/core'

import type {BrvConfig, BrvConfigLanguage} from '../../../server/core/domain/entities/brv-config.js'

import {LANGUAGE_NAMES} from '../../../server/core/domain/render/language-clause.js'
import {ProjectConfigStore} from '../../../server/infra/config/file-config-store.js'
import {resolveProjectRoot} from '../../lib/curate-session.js'
import {writeJsonResponse} from '../../lib/json-response.js'

/**
 * `brv config set <key> <value>` — mutate one field in `.brv/config.json`.
 *
 * Today only the language-selection keys are handled (`language.mode` and
 * `language.code`); the dispatcher is keyed by string so adding the next
 * project-config key is a one-line addition to `SETTERS`.
 *
 * Daemon-side runtime settings (`agentPool.maxSize`, `llm.iterationBudgetMs`,
 * etc.) live behind `brv settings set` instead — those are mutable at
 * runtime via transport events. Project config is a flat-file mutation;
 * there is no daemon involvement.
 */
export default class ConfigSet extends Command {
  public static args = {
    key: Args.string({description: 'Project config key (e.g. language.mode, language.code)', required: true}),
    value: Args.string({description: 'New value', required: true}),
  }
  public static description = 'Set a project configuration value in .brv/config.json'
  public static examples = [
    '# Force the calling agent\'s LLM to author in Russian on every curate',
    '<%= config.bin %> <%= command.id %> language.code ru',
    '<%= config.bin %> <%= command.id %> language.mode fixed',
    '',
    '# Restore auto-detect (the default — match the user\'s input language)',
    '<%= config.bin %> <%= command.id %> language.mode auto',
    '',
    '# Read in JSON for scripting',
    '<%= config.bin %> <%= command.id %> language.code ja --format json',
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

const SETTERS: Record<string, ConfigSetter> = {
  'language.code': setLanguageCode,
  'language.mode': setLanguageMode,
}

/**
 * Dispatch a `<key> <value>` set onto a loaded BrvConfig. Pure function so
 * the CLI command and the unit tests share one validation path — no
 * filesystem or oclif coupling here.
 */
export function applyConfigSet(config: BrvConfig, key: string, value: string): ConfigSetResult {
  const setter = SETTERS[key]
  if (setter === undefined) {
    const supported = Object.keys(SETTERS).sort().join(', ')
    return {
      code: 'unknown-key',
      kind: 'error',
      message: `Unknown config key '${key}'. Supported keys: ${supported}.`,
    }
  }

  return setter(config, value)
}

function setLanguageMode(config: BrvConfig, value: string): ConfigSetResult {
  if (value !== 'auto' && value !== 'fixed') {
    return {
      code: 'invalid-value',
      kind: 'error',
      message: `language.mode must be 'auto' or 'fixed', got '${value}'.`,
    }
  }

  // Reject `fixed` without a code so the on-disk config can never reach an
  // invalid intermediate state (`{mode: 'fixed'}` would be rejected by
  // `isBrvConfigJson` on next load). Point the user at the unblocking step.
  if (value === 'fixed' && config.language?.code === undefined) {
    return {
      code: 'missing-language-code',
      kind: 'error',
      message:
        'language.mode \'fixed\' requires language.code to be set first. Run: brv config set language.code <iso>',
    }
  }

  const next: BrvConfigLanguage =
    value === 'fixed'
      ? {code: config.language!.code!, mode: 'fixed'}
      : config.language?.code === undefined
        ? {mode: 'auto'}
        : {code: config.language.code, mode: 'auto'}

  return {config: config.withLanguage(next), kind: 'ok'}
}

function setLanguageCode(config: BrvConfig, code: string): ConfigSetResult {
  if (!(code in LANGUAGE_NAMES)) {
    const supported = Object.keys(LANGUAGE_NAMES).sort().join(', ')
    return {
      code: 'unknown-iso-code',
      kind: 'error',
      message: `Unknown ISO 639-1 code '${code}'. Supported codes: ${supported}.`,
    }
  }

  // Preserve mode if already set; default to auto when language is being
  // initialized for the first time. The combination `{mode: 'auto', code}`
  // is intentional — code is vestigial in auto mode but harmless, and
  // makes the eventual `set language.mode fixed` a no-roundtrip activation.
  const mode = config.language?.mode ?? 'auto'
  return {config: config.withLanguage({code, mode}), kind: 'ok'}
}
