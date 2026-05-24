import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import type {SettingItem} from '../../core/domain/entities/settings.js'
import type {ISettingsStore, SettingsStartupSnapshot} from '../../core/interfaces/storage/i-settings-store.js'

import {SETTINGS_FILE, SETTINGS_SCHEMA_VERSION} from '../../constants.js'
import {SETTINGS_REGISTRY} from '../../core/domain/entities/settings.js'
import {getGlobalDataDir} from '../../utils/global-data-path.js'
import {InvalidSettingValueError, SettingsValidator} from './settings-validator.js'

type SettingsFile = {
  /**
   * Persisted values keyed by setting name. Typed as `unknown` because
   * the file may legitimately retain pre-existing invalid entries that
   * `reset` is forbidden from collateral-damaging (the daemon startup
   * loader handles those via warnings). `set` writes only validated
   * numeric values; partition() filters at read time.
   */
  readonly values: Record<string, unknown>
  readonly version: string
}

export type FileSettingsStoreOptions = {
  readonly baseDir?: string
  readonly validator?: SettingsValidator
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type RawReadResult =
  | {readonly kind: 'corrupt'; readonly parseError: string}
  | {readonly kind: 'missing'}
  | {readonly kind: 'ok'; readonly values: Record<string, unknown>}

/**
 * Persists user setting overrides to `<BRV_DATA_DIR>/settings.json` using an
 * atomic temp-file + rename write. Reads return defaults for any key that is
 * missing or invalid in the file; surfacing invalid entries (for warning
 * logs) is the daemon-startup loader's job, not this store's.
 */
export class FileSettingsStore implements ISettingsStore {
  private readonly baseDir: string
  private readonly validator: SettingsValidator

  public constructor(options: FileSettingsStoreOptions = {}) {
    this.baseDir = options.baseDir ?? getGlobalDataDir()
    this.validator = options.validator ?? new SettingsValidator()
  }

  public async get(key: string): Promise<SettingItem> {
    const descriptor = this.validator.validateKey(key)
    const overrides = await this.readOverrides()
    return {
      current: overrides[key] ?? descriptor.default,
      default: descriptor.default,
      key: descriptor.key,
      restartRequired: true,
    }
  }

  public async list(): Promise<readonly SettingItem[]> {
    const overrides = await this.readOverrides()
    return SETTINGS_REGISTRY.map((descriptor) => ({
      current: overrides[descriptor.key] ?? descriptor.default,
      default: descriptor.default,
      key: descriptor.key,
      restartRequired: true,
    }))
  }

  public async readStartupSnapshot(): Promise<SettingsStartupSnapshot> {
    const result = await this.readRawValuesOrError()
    if (result.kind === 'missing') return {invalid: [], values: {}}
    if (result.kind === 'corrupt') return {invalid: [], parseError: result.parseError, values: {}}

    const {invalid, valid} = this.validator.partition(result.values)
    return {invalid, values: valid}
  }

  public async reset(key: string): Promise<void> {
    this.validator.validateKey(key)
    const raw = await this.readRawValues()
    if (!(key in raw)) return

    delete raw[key]

    // Preserve every OTHER on-disk entry — including any pre-existing
    // invalid values that the user did not ask to touch. The daemon
    // startup loader logs invalid entries as warnings; `reset` is
    // scoped to the one key the caller named so a single reset never
    // collateral-damages the rest of the file.
    if (Object.keys(raw).length === 0) {
      const path = this.filePath()
      if (existsSync(path)) await unlink(path)
      return
    }

    await this.writeFile({values: raw, version: SETTINGS_SCHEMA_VERSION})
  }

  public async set(key: string, value: unknown): Promise<void> {
    const validatedValue = this.validator.validate(key, value)
    const overrides = await this.readOverrides()
    const proposed = {...overrides, [key]: validatedValue}

    const violations = this.validator.validateCoupling(proposed)
    if (violations.length > 0) {
      throw new InvalidSettingValueError(key, value, violations[0].reason)
    }

    await this.writeFile({values: proposed, version: SETTINGS_SCHEMA_VERSION})
  }

  private filePath(): string {
    return join(this.baseDir, SETTINGS_FILE)
  }

  private async readOverrides(): Promise<Record<string, number>> {
    const raw = await this.readRawValues()
    const {valid} = this.validator.partition(raw)
    return {...valid}
  }

  private async readRawValues(): Promise<Record<string, unknown>> {
    const result = await this.readRawValuesOrError()
    return result.kind === 'ok' ? result.values : {}
  }

  private async readRawValuesOrError(): Promise<RawReadResult> {
    const path = this.filePath()
    if (!existsSync(path)) return {kind: 'missing'}

    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch (error) {
      return {kind: 'corrupt', parseError: errorMessage(error)}
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      return {kind: 'corrupt', parseError: `invalid JSON: ${errorMessage(error)}`}
    }

    if (!isRecord(parsed)) {
      return {kind: 'corrupt', parseError: 'expected top-level JSON object'}
    }

    if (parsed.values === undefined) return {kind: 'ok', values: {}}
    if (!isRecord(parsed.values)) {
      return {kind: 'corrupt', parseError: "expected object at '.values'"}
    }

    return {kind: 'ok', values: {...parsed.values}}
  }

  private async writeFile(file: SettingsFile): Promise<void> {
    await mkdir(this.baseDir, {recursive: true})
    const path = this.filePath()
    const tmpPath = `${path}.${randomUUID()}.tmp`
    await writeFile(tmpPath, JSON.stringify(file, null, 2), 'utf8')
    await rename(tmpPath, path)
  }
}
