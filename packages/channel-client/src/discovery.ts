import {promises as fs} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

import {CHANNEL_CLIENT_ERROR_CODE, ChannelClientError} from './errors.js'

/**
 * Daemon discovery — locates `daemon.json` (URL + port) and the
 * `state/daemon-auth-token` for the running brv daemon.
 *
 * Priority order for the data dir:
 *   1. Explicit `dataDir` option to `discoverDaemon()` (test override).
 *   2. `BRV_DATA_DIR` env var.
 *   3. `~/.brv` (matches the daemon's `getGlobalDataDir()`).
 *
 * The client does NOT spawn the daemon. If `daemon.json` is missing,
 * we fast-fail with `BRV_DAEMON_NOT_INITIALISED` so the host CLI can
 * tell the user to run `brv` once first.
 */

export type DiscoveredDaemon = {
  /** Socket.IO endpoint, e.g. `http://127.0.0.1:61420`. */
  readonly daemonUrl: string
  /** Resolved data dir used to read the files. */
  readonly dataDir: string
  /** Path to `daemon.json` (for error messages). */
  readonly daemonJsonPath: string
  /** Daemon-auth-token contents, trimmed. */
  readonly authToken: string
}

export type DiscoverDaemonOptions = {
  readonly dataDir?: string
}

const resolveDataDir = (override?: string): string => {
  if (override !== undefined && override !== '') return override
  const env = process.env.BRV_DATA_DIR
  if (env !== undefined && env !== '') return env
  return join(homedir(), '.brv')
}

export const discoverDaemon = async (
  options: DiscoverDaemonOptions = {},
): Promise<DiscoveredDaemon> => {
  const dataDir = resolveDataDir(options.dataDir)
  const daemonJsonPath = join(dataDir, 'daemon.json')
  const tokenPath = join(dataDir, 'state', 'daemon-auth-token')

  let raw: string
  try {
    raw = await fs.readFile(daemonJsonPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ChannelClientError(
        CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
        `brv daemon not running: ${daemonJsonPath} not found. Start the daemon first (e.g. run \`brv channel list\` once).`,
      )
    }

    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ChannelClientError(
      CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
      `${daemonJsonPath} is not valid JSON: ${(error as Error).message}`,
    )
  }

  const port = (parsed as {port?: unknown}).port
  if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0) {
    throw new ChannelClientError(
      CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
      `${daemonJsonPath} does not contain a valid \`port\` field.`,
    )
  }

  let tokenRaw: string
  try {
    tokenRaw = await fs.readFile(tokenPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ChannelClientError(
        CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
        `Daemon auth token not found at ${tokenPath}. The brv daemon must be started at least once.`,
      )
    }

    throw error
  }

  const authToken = tokenRaw.trim()
  if (authToken === '') {
    throw new ChannelClientError(
      CHANNEL_CLIENT_ERROR_CODE.DAEMON_NOT_INITIALISED,
      `Daemon auth token at ${tokenPath} is empty. Run \`brv restart\` to regenerate.`,
    )
  }

  return {
    authToken,
    daemonJsonPath,
    daemonUrl: `http://127.0.0.1:${port}`,
    dataDir,
  }
}
