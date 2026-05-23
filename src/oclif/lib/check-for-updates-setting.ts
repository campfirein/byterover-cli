import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

import {getGlobalDataDir} from '../../server/utils/global-data-path.js'

const SETTINGS_KEY = 'update.checkForUpdates'
const SETTINGS_FILENAME = 'settings.json'

/**
 * Synchronous read of the user's `update.checkForUpdates` setting.
 *
 * Default is `true` (update check enabled). Returns `false` only when the
 * persisted settings file explicitly contains
 * `{values: {"update.checkForUpdates": false}}`.
 *
 * Lives in `oclif/lib/` because the only consumers today are oclif init
 * hooks that must run before the daemon connection is established and
 * therefore cannot read the setting via the `settings:list` transport
 * event. Path resolution reuses `getGlobalDataDir()` so the helper lands
 * on the exact same file the daemon writes to.
 */
export function checkForUpdatesSetting(): boolean {
  try {
    const path = join(getGlobalDataDir(), SETTINGS_FILENAME)
    if (!existsSync(path)) return true

    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(parsed)) return true
    if (!isRecord(parsed.values)) return true

    const value = parsed.values[SETTINGS_KEY]
    if (typeof value !== 'boolean') return true
    return value
  } catch {
    return true
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
