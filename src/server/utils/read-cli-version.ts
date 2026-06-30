import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

const FALLBACK_VERSION = 'unknown'

/**
 * Reads the CLI version from `package.json`. Walks up three directory
 * levels from this file's location to find the project root, which works
 * for both source (`src/server/utils/`) and compiled (`dist/server/utils/`)
 * paths since both sit at the same depth.
 *
 * Returns `'unknown'` on any read or parse failure (best-effort).
 */
export function readCliVersion(): string {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url))
    // src/ and dist/ are 3 levels deep: server/utils/read-cli-version
    const pkgPath = join(currentDir, '..', '..', '..', 'package.json')
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') {
      return pkg.version
    }
  } catch {
    // Best-effort — return fallback
  }

  return FALLBACK_VERSION
}
