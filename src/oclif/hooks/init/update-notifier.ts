import type {Hook} from '@oclif/core'

import {confirm} from '@inquirer/prompts'
import {execSync, spawn} from 'node:child_process'
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {dirname, join} from 'node:path'
import updateNotifier from 'update-notifier'

import {checkForUpdatesSetting} from '../../lib/check-for-updates-setting.js'

/**
 * Check interval for update notifications (1 hour)
 */
export const UPDATE_CHECK_INTERVAL_MS = 1000 * 60 * 60

/**
 * How long to trust a cached `npm list -g` result before re-checking.
 * Install method very rarely changes within a single CLI install lifetime,
 * so 7 days is generous while still re-validating if the user e.g. moves
 * from a global npm install to a tarball install.
 */
export const INSTALL_METHOD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Path to the install-method cache file. Uses XDG-style config dir under
 * the user's home so it survives package upgrades and doesn't pollute the
 * project's `.brv/` directory.
 */
export const getInstallMethodCachePath = (home: string = homedir()): string =>
  join(home, '.config', 'byterover-cli', 'install-method.json')

type InstallMethodCacheEntry = {
  /** Absolute path to the CLI's own dirname at cache time. Cache invalidates
   *  if the install moves (e.g. nvm version switch, different prefix). */
  cliPath: string
  /** True iff `npm list -g byterover-cli` succeeded at cache time. */
  isNpmGlobal: boolean
  /** Unix ms timestamp of the cache write. TTL is compared against this. */
  timestamp: number
}

/**
 * Read the cached install-method result, returning undefined when the cache
 * is missing, malformed, expired, or for a different CLI install path.
 * Never throws — a broken cache simply means we fall through to the live check.
 */
export const readInstallMethodCache = (
  cliPath: string,
  cachePath: string = getInstallMethodCachePath(),
  now: number = Date.now(),
): boolean | undefined => {
  try {
    const raw = readFileSync(cachePath, 'utf8')
    const entry = JSON.parse(raw) as Partial<InstallMethodCacheEntry>
    if (typeof entry.isNpmGlobal !== 'boolean') return undefined
    if (entry.cliPath !== cliPath) return undefined
    if (typeof entry.timestamp !== 'number') return undefined
    if (now - entry.timestamp > INSTALL_METHOD_CACHE_TTL_MS) return undefined
    return entry.isNpmGlobal
  } catch {
    return undefined
  }
}

/**
 * Persist the install-method result to disk. Silently no-ops on any I/O
 * failure — a missing cache entry just means the next invocation re-runs
 * the live check, which is correct behaviour.
 */
export const writeInstallMethodCache = (
  cliPath: string,
  isNpmGlobal: boolean,
  cachePath: string = getInstallMethodCachePath(),
  now: number = Date.now(),
): void => {
  try {
    mkdirSync(dirname(cachePath), {recursive: true})
    const entry: InstallMethodCacheEntry = {cliPath, isNpmGlobal, timestamp: now}
    writeFileSync(cachePath, JSON.stringify(entry), 'utf8')
  } catch {
    // best-effort cache; never break the user's CLI invocation over this
  }
}

/**
 * Narrowed notifier type for dependency injection
 */
export type NarrowedUpdateNotifier = {
  notify: (options: {defer: boolean; message: string}) => void
  update?: {current: string; latest: string}
}

/**
 * Dependencies that can be injected for testing
 */
export type UpdateNotifierDeps = {
  confirmPrompt: (options: {default: boolean; message: string}) => Promise<boolean>
  execSyncFn: (command: string, options: {stdio: 'inherit'}) => void
  exitFn: (code: number) => never
  isNpmGlobalInstalled: boolean
  isTTY: boolean
  log: (message: string) => void
  notifier: NarrowedUpdateNotifier
  spawnRestartFn: () => {unref(): void}
}

/**
 * Check whether byterover-cli is installed as a npm global package.
 *
 * Calling `npm list -g <pkg>` spawns a subprocess that walks the entire
 * global node_modules tree. On a fast desktop with an SSD this is ~300ms;
 * on slower environments (older systems, Termux/Android, network-mounted
 * homedirs, CI runners with cold caches) it routinely takes 3-5 seconds.
 * Since the install method virtually never changes between invocations,
 * we cache the result on disk (see {@link readInstallMethodCache}) and
 * only re-check after {@link INSTALL_METHOD_CACHE_TTL_MS} elapses or the
 * CLI install location changes.
 *
 * @param execSyncFn - Injected for testability.
 * @returns false for other installation methods.
 */
export const isNpmGlobalInstall = (execSyncFn: typeof execSync): boolean => {
  try {
    execSyncFn('npm list -g byterover-cli --depth=0', {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

/**
 * Cached wrapper around {@link isNpmGlobalInstall}. Used by the init hook to
 * avoid paying the cost of an `npm list -g` subprocess on every CLI start.
 */
export const isNpmGlobalInstallCached = (
  cliPath: string,
  execSyncFn: typeof execSync = execSync,
  cachePath: string = getInstallMethodCachePath(),
  now: number = Date.now(),
): boolean => {
  const cached = readInstallMethodCache(cliPath, cachePath, now)
  if (cached !== undefined) return cached
  const live = isNpmGlobalInstall(execSyncFn)
  writeInstallMethodCache(cliPath, live, cachePath, now)
  return live
}

/**
 * Resolves whether the init hook should run the update check at all.
 *
 * Returns `false` when any of the following holds:
 * - The `update.checkForUpdates` setting is explicitly `false`.
 * - The command being invoked is itself `update` (anti-recursion).
 * - `BRV_ENV` is `development` (dev installs handle updates manually).
 * - `BRV_SKIP_UPDATE_CHECK` is set to any truthy value (escape hatch for
 *   CI / scripted invocations that want zero startup overhead).
 * - `stdout` is not a TTY. The interactive confirm prompt cannot run in
 *   non-interactive contexts (piped output, CI, scripts, daemons), so the
 *   hook would silently no-op anyway after paying the full `npm list -g`
 *   cost. Bailing here saves that cost on every non-TTY invocation.
 *
 * Returns `true` otherwise (default behaviour).
 */
export function shouldRunUpdateCheck(args: {
  commandId: string | undefined
  isTTY?: boolean
}): boolean {
  if (args.commandId === 'update') return false
  if (process.env.BRV_ENV === 'development') return false
  if (process.env.BRV_SKIP_UPDATE_CHECK) return false
  if (args.isTTY === false) return false
  return checkForUpdatesSetting()
}

/**
 * Core update notification logic, extracted for testability.
 *
 * Interactive flow only: shows a confirm prompt, then runs `npm update -g`
 * + `brv restart` if the user types `y`. There is **no** unattended /
 * automatic execution path — that was deliberately rejected by the team
 * (May 2026). When the user types `n` (or the prompt is unavailable),
 * the hook just notifies and returns.
 */
export async function handleUpdateNotification(deps: UpdateNotifierDeps): Promise<void> {
  const {confirmPrompt, execSyncFn, exitFn, isNpmGlobalInstalled, isTTY, log, notifier} = deps

  if (!isNpmGlobalInstalled || !notifier.update || !isTTY) {
    return
  }

  const {current, latest} = notifier.update

  // Skip if already on latest version (handles stale cache after update)
  if (current === latest) {
    return
  }

  const shouldUpdate = await confirmPrompt({
    default: true,
    message: `Update available: ${current} → ${latest}. Update now? (active sessions will be restarted)`,
  })

  if (shouldUpdate) {
    log('Updating byterover-cli...')
    try {
      execSyncFn('npm update -g byterover-cli', {stdio: 'inherit'})
      log('')
      log(`✓ Updated to ${latest}.`)
      log('')
      try {
        const child = deps.spawnRestartFn()
        child.unref()
        log('Restarting ByteRover in the background. Please wait a few seconds before running brv again.')
      } catch {
        log('Failed to restart ByteRover. Please restart it manually by running `brv restart`.')
      }

      exitFn(0)
    } catch {
      log('⚠️  Automatic update failed. Please run manually: npm update -g byterover-cli')
    }
  }
}

const hook: Hook<'init'> = async function (opts): Promise<void> {
  const isTTY = process.stdout.isTTY ?? false

  // Cheap short-circuits FIRST, before any subprocess or filesystem I/O.
  // Previously every invocation paid the cost of `npm list -g byterover-cli`
  // (3-5 seconds on slower systems) even when the hook would no-op anyway
  // because stdout wasn't a TTY or the user had opted out.
  if (!shouldRunUpdateCheck({commandId: opts.id, isTTY})) return

  // Use the cached install-method check so we don't spawn `npm list -g` on
  // every CLI invocation. The cache is keyed on the CLI's own install path
  // and invalidates after 7 days, so a user moving installs (e.g. nvm
  // version switch) re-validates on the next run.
  const cliPath = this.config.root
  const isNpmGlobalInstalled = isNpmGlobalInstallCached(cliPath, execSync)

  const pkgInfo = {name: this.config.name, version: this.config.version}
  const notifier = updateNotifier({pkg: pkgInfo, updateCheckInterval: UPDATE_CHECK_INTERVAL_MS})

  await handleUpdateNotification({
    confirmPrompt: confirm,
    execSyncFn: execSync,
    exitFn: process.exit,
    isNpmGlobalInstalled,
    isTTY,
    log: this.log.bind(this),
    notifier,
    spawnRestartFn: () =>
      spawn('brv restart', {
        detached: true,
        shell: true,
        stdio: 'ignore',
        windowsHide: true,
      }),
  })
}

export default hook
