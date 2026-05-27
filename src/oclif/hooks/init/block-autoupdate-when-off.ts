import type {Hook} from '@oclif/core'

import {checkForUpdatesSetting} from '../../lib/check-for-updates-setting.js'

export type BlockAutoupdateWhenOffDeps = {
  argv: readonly string[]
  commandId: string | undefined
  exitFn: (code: number) => never
}

/**
 * Short-circuits `brv update --autoupdate` (the background invocation
 * `@oclif/plugin-update` spawns on a debounce) when the user has set
 * `update.checkForUpdates` to `false`. Exits silently with code 0 so
 * plugin-update sees a normal-looking termination rather than an error
 * it might retry or log.
 *
 * The user-initiated `brv update` (no `--autoupdate` flag) is **not**
 * blocked — that remains the user's manual escape hatch.
 */
export function handleBlockAutoupdateWhenOff(deps: BlockAutoupdateWhenOffDeps): void {
  if (deps.commandId !== 'update') return
  if (!deps.argv.includes('--autoupdate')) return
  if (checkForUpdatesSetting()) return
  deps.exitFn(0)
}

const hook: Hook<'init'> = function (opts): Promise<void> {
  handleBlockAutoupdateWhenOff({
    argv: opts.argv,
    commandId: opts.id,
    exitFn: process.exit,
  })
  return Promise.resolve()
}

export default hook
