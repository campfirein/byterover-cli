import {randomBytes} from 'node:crypto'
import {promises as fs} from 'node:fs'
import {dirname, join} from 'node:path'

import {getGlobalDataDir} from '../../utils/global-data-path.js'

/**
 * Daemon-token store for local channel auth (CHANNEL_PROTOCOL.md §2 + DESIGN
 * §5.6 step 1). Phase 1 ships read-or-generate persistence; origin hardening
 * and the `--rotate-auth-token` command are deferred to Phase 3.
 *
 * Storage layout (relative to {@link getGlobalDataDir}):
 *   <data-dir>/state/daemon-auth-token   (mode 0600)
 *
 * Behaviour:
 *   - If the file exists with mode 0600 and non-empty contents, return it.
 *   - If the file is missing, generate a fresh 256-bit token and write it
 *     atomically with mode 0600.
 *   - If the file exists with wrong permissions (POSIX), regenerate. This
 *     ensures a tampered/loosened file is not silently trusted.
 *   - Windows: POSIX permission checks are skipped because Node's `mode` on
 *     Windows does not faithfully reflect ACLs. The token file is still
 *     created and read from disk; tighter Windows-native ACLs are a follow-up.
 */

const TOKEN_DIR_NAME = 'state'
const TOKEN_FILE_NAME = 'daemon-auth-token'
const TOKEN_FILE_MODE = 0o600
const TOKEN_BYTES = 32 // 256-bit token

const IS_POSIX = process.platform !== 'win32'

const getTokenPath = (dataDir?: string): string =>
  join(dataDir ?? getGlobalDataDir(), TOKEN_DIR_NAME, TOKEN_FILE_NAME)

const generateToken = (): string => randomBytes(TOKEN_BYTES).toString('hex')

const writeTokenAtomically = async (tokenPath: string, token: string): Promise<void> => {
  await fs.mkdir(dirname(tokenPath), {recursive: true})
  const tmp = `${tokenPath}.tmp.${process.pid}`
  await fs.writeFile(tmp, token, {mode: TOKEN_FILE_MODE})
  // writeFile's `mode` is ignored on some platforms when the file already
  // exists; an explicit chmod ensures the final perms are correct on POSIX.
  if (IS_POSIX) {
    await fs.chmod(tmp, TOKEN_FILE_MODE)
  }

  await fs.rename(tmp, tokenPath)
}

/**
 * Returns the daemon auth token, generating and persisting a new one if the
 * file is missing, empty, or (on POSIX) has the wrong permissions.
 *
 * Concurrency note: two daemons starting simultaneously can both observe the
 * file as missing and both race to write. The atomic rename in
 * {@link writeTokenAtomically} makes this last-writer-wins; clients that hold
 * a token read by an earlier daemon will be rejected and must reconnect to
 * pick up the new one. This is acceptable for a local dev tool; production
 * single-host installs do not start two daemons at once.
 *
 * Windows note: POSIX ACL checks are skipped; Windows-native ACL tightening
 * is a follow-up (Phase 3 candidate).
 */
export const readOrCreateDaemonAuthToken = async (options?: {dataDir?: string}): Promise<string> => {
  const tokenPath = getTokenPath(options?.dataDir)

  let stat: Awaited<ReturnType<typeof fs.stat>> | undefined
  try {
    stat = await fs.stat(tokenPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  if (stat === undefined) {
    const fresh = generateToken()
    await writeTokenAtomically(tokenPath, fresh)
    return fresh
  }

  // Check permissions BEFORE reading content. A file with overly-broad perms
  // (e.g. world-readable) is regenerated outright rather than trusted —
  // never read a token from a file that's been opened up to other users.
  const modeNumber = typeof stat.mode === 'bigint' ? Number(stat.mode) : stat.mode
  // eslint-disable-next-line no-bitwise
  const mode = modeNumber & 0o777
  if (IS_POSIX && mode !== TOKEN_FILE_MODE) {
    const fresh = generateToken()
    await writeTokenAtomically(tokenPath, fresh)
    return fresh
  }

  const existing = (await fs.readFile(tokenPath, 'utf8')).trim()
  if (existing === '') {
    const fresh = generateToken()
    await writeTokenAtomically(tokenPath, fresh)
    return fresh
  }

  return existing
}

/**
 * Phase-3 rotation primitive: generate a fresh token, write atomically with
 * mode 0600, return it. Slice 3.5a's {@link DaemonTokenProvider} uses this
 * inside `rotate()` so callers never touch the disk directly.
 */
export const rotateDaemonAuthToken = async (options?: {dataDir?: string}): Promise<string> => {
  const tokenPath = getTokenPath(options?.dataDir)
  const fresh = generateToken()
  await writeTokenAtomically(tokenPath, fresh)
  return fresh
}
