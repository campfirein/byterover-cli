import type {Hook} from '@oclif/core'

import {execSync} from 'node:child_process'

import {isNpmGlobalInstallCached} from './update-notifier.js'

export type BlockCommandUpdateNpmDeps = {
  commandId: string | undefined
  errorFn: (message: string, options: {exit: number}) => void
  isNpmGlobalInstalled: boolean
}

export function handleBlockCommandUpdateNpm(deps: BlockCommandUpdateNpmDeps): void {
  if (deps.commandId === 'update' && deps.isNpmGlobalInstalled) {
    deps.errorFn('brv was installed via npm. Use `npm update -g byterover-cli` to update.', {exit: 1})
  }
}

const hook: Hook<'init'> = async function (opts): Promise<void> {
  // This hook only acts when the user runs `brv update`, but previously it
  // called `npm list -g byterover-cli` (a 3-5s subprocess on slow systems)
  // on EVERY brv invocation, just so it could decide whether to error out
  // when the command happened to be `update`. Gate the npm check on the
  // commandId so every other command path skips it entirely.
  if (opts.id !== 'update') return

  handleBlockCommandUpdateNpm({
    commandId: opts.id,
    errorFn: this.error.bind(this),
    isNpmGlobalInstalled: isNpmGlobalInstallCached(this.config.root, execSync),
  })
}

export default hook
