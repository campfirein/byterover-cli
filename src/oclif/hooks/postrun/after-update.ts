import type {Hook} from '@oclif/core'

import {spawn} from 'node:child_process'
import {readdir, readlink, rm, stat} from 'node:fs/promises'
import {basename, join} from 'node:path'

export type RestartAfterUpdateDeps = {
  argv: string[]
  commandId: string | undefined
  log: (msg: string) => void
  spawnRestartFn: () => {unref(): void}
}

/**
 * Restart daemon/agent processes after a manual `brv update`.
 *
 * Fires after every command via the oclif postrun hook; early-returns for
 * anything other than `brv update`.
 *
 * Skips background auto-updates: @oclif/plugin-update passes `--autoupdate`
 * when spawning `brv update` in the background. Manual `brv update` runs
 * in the user's shell without that flag.
 */
export async function handleRestartAfterUpdate(deps: RestartAfterUpdateDeps): Promise<void> {
  if (deps.commandId !== 'update') return
  if (deps.argv.includes('--autoupdate')) return

  try {
    const child = deps.spawnRestartFn()
    child.unref()
    deps.log('Restarting ByteRover in the background. Please wait a few seconds before running brv again.')
  } catch {
    deps.log('Failed to restart ByteRover. Please restart it manually by running `brv restart`.')
    // best-effort — update already succeeded
  }
}

export type TidyUpdatePluginClientCacheDeps = {
  logFn: (msg: string) => void
  rmFn?: (path: string) => Promise<void>
  root: string
}

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const resolveActiveVersion = async (updatePluginClientRoot: string): Promise<string | undefined> => {
  let target: string
  try {
    target = await readlink(join(updatePluginClientRoot, 'current'))
  } catch {
    return undefined
  }

  const candidate = basename(target)
  try {
    await stat(join(updatePluginClientRoot, candidate))
  } catch {
    return undefined
  }

  return candidate
}

export const tidyUpdatePluginClientCache = async (deps: TidyUpdatePluginClientCacheDeps): Promise<void> => {

  const {root} = deps
  const {logFn} = deps

  let entries: string[]
  try {
    entries = await readdir(root)
  } catch (error) {
    logFn(`tidyUpdatePluginClientCache: failed to list ${root}: ${describeError(error)}`)
    return
  }

  const activeName = await resolveActiveVersion(root)
  if (!activeName) return

  const specialCacheEntries: ReadonlySet<string> = new Set(['bin', 'current'])
  const rmFn = deps.rmFn ?? ((path: string) => rm(path, {force: true, recursive: true}))
  await Promise.all(
    entries
      .filter(name => !specialCacheEntries.has(name) && name !== activeName)
      .map(async (name) => {
        const target = join(root, name)
        try {
          await rmFn(target)
        } catch (error) {
          logFn(`tidyUpdatePluginClientCache: failed to remove ${target}: ${describeError(error)}`)
        }
      })
  )
}

const hook: Hook<'postrun'> = async function (opts) {
  if (opts.Command.id !== 'update') return

  const updatePluginClientRoot = this.config.scopedEnvVar('OCLIF_CLIENT_HOME') ?? join(this.config.dataDir, 'client')
  await tidyUpdatePluginClientCache({logFn: this.log.bind(this), root: updatePluginClientRoot})

  await handleRestartAfterUpdate({
    argv: opts.argv,
    commandId: opts.Command.id,
    log: this.log.bind(this),
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
