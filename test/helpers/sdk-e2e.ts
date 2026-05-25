import type * as Mocha from 'mocha'

import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

/**
 * Phase-5 SDK E2E gates.
 *
 * The Phase-5 integration tests onboard the per-language echo example as
 * the ACP agent. To keep contributors who haven't built the SDKs from
 * failing CI, the suite skips unless `SDK_E2E=1` AND the relevant build
 * artifacts exist.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

export const TS_ECHO_PATH = resolve(REPO_ROOT, 'packages', 'agent-sdk', 'examples', 'echo', 'index.mjs')
const TS_SDK_DIST = resolve(REPO_ROOT, 'packages', 'agent-sdk', 'dist', 'index.js')

export const PY_ECHO_PATH = resolve(REPO_ROOT, 'packages', 'brv-agent-py', 'examples', 'echo', 'main.py')
const PY_VENV_PYTHON = resolve(REPO_ROOT, 'packages', 'brv-agent-py', '.venv', 'bin', 'python')

export const requireTsSdkE2E = (mochaContext: Mocha.Context): undefined | {echoPath: string} => {
  if (process.env.SDK_E2E !== '1') {
    mochaContext.skip()
    return undefined
  }

  if (!existsSync(TS_SDK_DIST) || !existsSync(TS_ECHO_PATH)) {
    mochaContext.skip()
    return undefined
  }

  return {echoPath: TS_ECHO_PATH}
}

export const requirePySdkE2E = (mochaContext: Mocha.Context): undefined | {echoPath: string; pythonPath: string} => {
  if (process.env.SDK_E2E !== '1') {
    mochaContext.skip()
    return undefined
  }

  if (!existsSync(PY_ECHO_PATH)) {
    mochaContext.skip()
    return undefined
  }

  // Prefer the per-package venv (set up by Slice 5.3); fall back to system
  // python only if `brv-agent` is importable there.
  if (existsSync(PY_VENV_PYTHON)) {
    return {echoPath: PY_ECHO_PATH, pythonPath: PY_VENV_PYTHON}
  }

  const systemPython = spawnSync('which', ['python3'])
  if (systemPython.status !== 0) {
    mochaContext.skip()
    return undefined
  }

  const probe = spawnSync(systemPython.stdout.toString().trim(), ['-c', 'import brv_agent'])
  if (probe.status !== 0) {
    mochaContext.skip()
    return undefined
  }

  return {echoPath: PY_ECHO_PATH, pythonPath: systemPython.stdout.toString().trim()}
}
