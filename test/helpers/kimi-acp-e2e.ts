import type * as Mocha from 'mocha'

import {spawnSync} from 'node:child_process'
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * Phase-4 E2E test gate for the real `kimi acp` binary.
 *
 * `KIMI_ACP_E2E=1` opts in; contributors without kimi-cli installed see
 * the suite skip cleanly (green CI). Each gated test owns an isolated
 * `KIMI_SHARE_DIR` so kimi-cli's config + credentials never bleed into
 * the user's real `~/.kimi/` and the auth-required test starts empty.
 *
 * kimi-cli persists OAuth tokens under `<KIMI_SHARE_DIR>/credentials/<key>.json`
 * (one file per OAuth ref — see `kimi-cli/src/kimi_cli/auth/oauth.py:264-272`).
 * When `requireLoggedIn: true`, the helper copies the user's `credentials/`
 * directory into the isolated share dir. If the user hasn't run `kimi login`,
 * the test skips (we don't fail in CI for setup reasons).
 *
 * The helper does NOT mutate the user's real `~/.kimi/` under any
 * circumstance — every write lands in a tmpdir-backed share dir.
 */

export type KimiAcpHandle = {
  readonly binaryPath: string
  readonly cleanup: () => void
  /** Per-test KIMI_SHARE_DIR. Pass via env when invoking the daemon. */
  readonly shareDir: string
}

export type RequireKimiAcpOptions = {
  /**
   * When true, the helper requires that the user has previously run
   * `kimi login` and copies the resulting credentials into the isolated
   * share dir. Skips the test if no credentials are present.
   *
   * When false, the share dir is created empty — used by the
   * auth-required test which depends on no credentials existing.
   */
  readonly requireLoggedIn: boolean
}

export const requireKimiAcp = (
  mochaContext: Mocha.Context,
  opts: RequireKimiAcpOptions,
): KimiAcpHandle | undefined => {
  if (process.env.KIMI_ACP_E2E !== '1') {
    mochaContext.skip()
    return undefined
  }

  const which = spawnSync('which', ['kimi'])
  if (which.status !== 0) {
    mochaContext.skip()
    return undefined
  }

  const binaryPath = which.stdout.toString().trim()
  const shareDir = mkdtempSync(join(tmpdir(), 'brv-phase4-kimi-share-'))
  const cleanup = (): void => {
    rmSync(shareDir, {force: true, recursive: true})
  }

  if (opts.requireLoggedIn) {
    const realShare = process.env.KIMI_SHARE_DIR ?? join(homedir(), '.kimi')
    const realCredentials = join(realShare, 'credentials')
    if (!existsSync(realCredentials)) {
      cleanup()
      mochaContext.skip()
      return undefined
    }

    const credentialFiles = readdirSync(realCredentials).filter((f) => f.endsWith('.json'))
    if (credentialFiles.length === 0) {
      cleanup()
      mochaContext.skip()
      return undefined
    }

    const targetCredentials = join(shareDir, 'credentials')
    mkdirSync(targetCredentials, {recursive: true})
    for (const file of credentialFiles) {
      copyFileSync(join(realCredentials, file), join(targetCredentials, file))
    }
  }

  return {binaryPath, cleanup, shareDir}
}
