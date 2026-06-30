import {readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Canonical disclosure markdown lives in `src/shared/assets/` so both
 * oclif (CLI consent prompt) and TUI (settings-page inline confirm)
 * can read it without crossing the import boundary. The build script
 * copies `src/shared/assets/` to `dist/shared/assets/`.
 */
const here = dirname(fileURLToPath(import.meta.url))
const DISCLOSURE_PATH = resolve(here, '../assets/analytics-disclosure.md')

export async function loadAnalyticsDisclosureText(): Promise<string> {
  return readFile(DISCLOSURE_PATH, 'utf8')
}
