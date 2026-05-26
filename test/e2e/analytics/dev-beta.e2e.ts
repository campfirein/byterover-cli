/* eslint-disable camelcase, no-await-in-loop */
/**
 * M4.7 (ENG-2649) end-to-end smoke for the analytics pipeline against a
 * real backend. Replaces the prior shell + .mjs harness with a single
 * mocha file that still drives the real `brv` binary, real daemon, and
 * real HTTP path - so PASS here still means "the backend accepted the
 * batch with 2xx".
 *
 * Not picked up by `npm test` (glob is "test/**\/*.test.ts"); run via
 * `npm run test:e2e:analytics`. The `pretest:e2e:analytics` npm hook
 * runs `npm run build` automatically so `dist/` is fresh; no `npm link`
 * is required because the test spawns `bin/run.js` directly from the
 * repo (so the harness always exercises THIS checkout, never a globally
 * linked one).
 *
 * Per-scenario isolation uses a temp `BRV_DATA_DIR` + temp `HOME`, and
 * `brv restart` (with the scenario's env) is used for teardown so it
 * properly cleans the SCENARIO's daemon (`bin/kill-daemon.js` alone
 * would read the user's real global daemon.json and leak scenario
 * daemons to the process table).
 *
 * Sequential by design. Do NOT run with `--parallel`: scenarios mutate
 * `process.env.BRV_DATA_DIR` / `HOME` inside `emitEvents` and restore
 * in `finally`. Parallel runs would corrupt each other.
 */

import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {existsSync, mkdtempSync, readFileSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {createServer as createHttpServer, type Server as HttpServer} from 'node:http'
import {createServer, type Server as NetServer} from 'node:net'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {resolveLocalServerMainPath} from '../../../src/server/utils/server-main-resolver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BRV_BIN = join(REPO_ROOT, 'bin', 'run.js')
const DEFAULT_BACKEND = process.env.BRV_ANALYTICS_BASE_URL ?? 'https://telemetry-dev.byterover.dev'
const DEFAULT_IAM = process.env.BRV_IAM_BASE_URL ?? 'https://dev-beta-iam.byterover.dev'
const DIST_DAEMON = join(REPO_ROOT, 'dist', 'server', 'infra', 'daemon', 'brv-server.js')

type ScenarioEnv = {
  dataDir: string
  env: NodeJS.ProcessEnv
  home: string
}

type JsonlRow = {
  attempts?: number
  id?: string
  identity?: {device_id?: string; user_id?: string}
  name?: string
  status?: 'failed' | 'pending' | 'sent'
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms)
  })
}

function makeScenarioEnv(overrideBackend?: string): ScenarioEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'brv-e2e-'))
  const home = mkdtempSync(join(tmpdir(), 'brv-home-'))
  return {
    dataDir,
    env: {
      ...process.env,
      BRV_ANALYTICS_BASE_URL: overrideBackend ?? DEFAULT_BACKEND,
      BRV_DATA_DIR: dataDir,
      BRV_ENV: 'development',
      BRV_IAM_BASE_URL: DEFAULT_IAM,
      HOME: home,
    },
    home,
  }
}

function runBrv(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): {ok: boolean; reason?: string} {
  // process.execPath (the current node) + bin/run.js avoids depending on
  // `npm link` and always exercises THIS checkout. The scenario env carries
  // BRV_DATA_DIR / HOME / BRV_ANALYTICS_BASE_URL — all the toggles brv reads.
  const result = spawnSync(process.execPath, [BRV_BIN, ...args], {env, stdio: 'ignore', timeout: timeoutMs})
  if (result.error) return {ok: false, reason: `brv ${args.join(' ')} failed to spawn: ${result.error.message}`}
  if (result.status !== 0) return {ok: false, reason: `brv ${args.join(' ')} exit ${result.status}`}
  return {ok: true}
}

/**
 * Tears down the daemon for `env.BRV_DATA_DIR` via `brv restart`, which:
 *   1. kills brv client procs (TUI/MCP/headless),
 *   2. SIGTERM/SIGKILL the daemon registered in `${BRV_DATA_DIR}/daemon.json`,
 *   3. pattern-kills orphan brv-server.js / agent-process.js procs,
 *   4. removes daemon.json / heartbeat / spawn-lock from the scoped data dir.
 * Returning `void` because failures are non-fatal: the temp dir is about to
 * be rm -rf'd anyway, and the next scenario boots into its own fresh dir.
 */
function restartBrv(env: NodeJS.ProcessEnv): void {
  spawnSync(process.execPath, [BRV_BIN, 'restart'], {env, stdio: 'ignore', timeout: 30_000})
}

function bootDaemon(env: NodeJS.ProcessEnv): {ok: boolean; reason?: string} {
  return runBrv(['status'], env)
}

function enableAnalytics(env: NodeJS.ProcessEnv): {ok: boolean; reason?: string} {
  return runBrv(['analytics', 'enable', '--yes'], env)
}

function disableAnalytics(env: NodeJS.ProcessEnv): {ok: boolean; reason?: string} {
  return runBrv(['analytics', 'disable'], env)
}

function jsonlPath(dataDir: string): string {
  return join(dataDir, 'analytics-queue.jsonl')
}

function readRows(path: string): JsonlRow[] {
  if (!existsSync(path)) return []
  const content = readFileSync(path, 'utf8')
  const rows: JsonlRow[] = []
  for (const line of content.split('\n')) {
    if (line.length === 0) continue
    rows.push(JSON.parse(line) as JsonlRow)
  }

  return rows
}

function countStatus(path: string, status: 'failed' | 'pending' | 'sent'): number {
  return readRows(path).filter((r) => r.status === status).length
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }

  return predicate()
}

async function waitForStatus(
  path: string,
  target: 'failed' | 'pending' | 'sent',
  timeoutMs: number,
): Promise<boolean> {
  return waitFor(() => {
    const rows = readRows(path)
    const last = rows.at(-1)
    return last !== undefined && last.status === target
  }, timeoutMs)
}

/**
 * Emits `count` cli_invocation events via `analytics:track` against the
 * daemon under `env.BRV_DATA_DIR`. Temporarily mutates `process.env`
 * because `connectToDaemon` reads it for instance discovery, then
 * restores in `finally`. Safe because mocha runs `describe`/`it`
 * sequentially - do NOT add `--parallel`.
 */
async function emitEvents(count: number, env: NodeJS.ProcessEnv): Promise<{failed: number; succeeded: number}> {
  const prev = {
    BRV_ANALYTICS_BASE_URL: process.env.BRV_ANALYTICS_BASE_URL,
    BRV_DATA_DIR: process.env.BRV_DATA_DIR,
    BRV_ENV: process.env.BRV_ENV,
    BRV_IAM_BASE_URL: process.env.BRV_IAM_BASE_URL,
    HOME: process.env.HOME,
  }
  process.env.BRV_ANALYTICS_BASE_URL = env.BRV_ANALYTICS_BASE_URL
  process.env.BRV_DATA_DIR = env.BRV_DATA_DIR
  process.env.BRV_ENV = env.BRV_ENV
  process.env.BRV_IAM_BASE_URL = env.BRV_IAM_BASE_URL
  process.env.HOME = env.HOME
  try {
    const {connectToDaemon} = await import('@campfirein/brv-transport-client')
    const {client} = await connectToDaemon({
      clientType: 'cli',
      fromDir: REPO_ROOT,
      projectPath: REPO_ROOT,
      serverPath: resolveLocalServerMainPath(),
    })
    const now = Date.now()
    let succeeded = 0
    let failed = 0
    for (let i = 0; i < count; i++) {
      try {
        await client.requestWithAck('analytics:track', {
          event: 'cli_invocation',
          properties: {
            client_sent_at: now + i,
            command_id: `e2e-${randomUUID().slice(0, 8)}-${i}`,
            flag_names: [],
            is_ci: false,
            is_tty: false,
            package_manager: 'npm',
            runtime: 'node',
          },
        })
        succeeded += 1
      } catch {
        failed += 1
      }
    }

    await client.disconnect()
    return {failed, succeeded}
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

async function startDropProxy(): Promise<{close: () => Promise<void>; port: number}> {
  return new Promise((res, rej) => {
    const server: NetServer = createServer((socket) => socket.destroy())
    server.on('error', rej)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        rej(new Error('drop-proxy: unexpected address shape'))
        return
      }

      res({
        close: () =>
          new Promise<void>((closeRes) => {
            server.close(() => closeRes())
          }),
        port: addr.port,
      })
    })
  })
}

/**
 * Minimal HTTP backend that responds 200 to anything. Used as Phase B of
 * scenario 5 to simulate "backend came back up" on the same port the
 * drop-proxy was using - so the daemon (still pointed at that URL) sees
 * a successful flush and the M4.5 backoff policy resets
 * `consecutive_failures` to 0.
 */
async function startAcceptProxy(port: number): Promise<{close: () => Promise<void>}> {
  return new Promise((res, rej) => {
    const server: HttpServer = createHttpServer((_req, response) => {
      response.writeHead(200, {'content-type': 'application/json'})
      response.end('{"ok":true}')
    })
    server.on('error', rej)
    server.listen(port, '127.0.0.1', () => {
      res({
        close: () =>
          new Promise<void>((closeRes) => {
            server.close(() => closeRes())
          }),
      })
    })
  })
}

function analyticsStatusJson(env: NodeJS.ProcessEnv): Record<string, unknown> | undefined {
  const result = spawnSync(process.execPath, [BRV_BIN, 'analytics', 'status', '--format', 'json'], {
    env,
    timeout: 15_000,
  })
  if (result.status !== 0) return undefined
  try {
    return JSON.parse(result.stdout.toString()) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readBackoffFailures(env: NodeJS.ProcessEnv): {failures: number; state: string} {
  const status = analyticsStatusJson(env)
  const backoff = (status?.data as undefined | {backoff?: Record<string, unknown>})?.backoff
  return {
    failures: (backoff?.consecutive_failures as number | undefined) ?? -1,
    state: (backoff?.state as string | undefined) ?? 'unknown',
  }
}

async function preflightBackend(url: string): Promise<{ok: boolean; reason?: string}> {
  // Mirrors scripts/e2e-analytics.sh:170-195 — send one known-good M4.x
  // wire-format batch and check that the backend accepts it. If the
  // deployment is still on the old ISO timestamp schema, all scenarios
  // would FAIL with retry-cap exhaustion; better to skip the suite
  // up-front with a clear reason.
  const body = JSON.stringify({
    events: [
      {
        identity: {device_id: 'e2e-preflight'},
        name: 'daemon_start',
        properties: {
          cli_version: '3.12.0',
          environment: 'development',
          node_version: process.version,
          os: process.platform,
        },
        timestamp: Date.now(),
      },
    ],
    schema_version: 1,
  })
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const res = await fetch(`${url}/v1/events`, {
      body,
      headers: {'content-type': 'application/json', 'x-byterover-device-id': 'e2e-preflight'},
      method: 'POST',
      signal: ctrl.signal,
    })
    clearTimeout(timer)
    if (res.status >= 200 && res.status < 300) return {ok: true}
    if (res.status === 400) {
      return {
        ok: false,
        reason: `backend at ${url} returned 400 to the M4.x wire format - likely still on the older ISO-8601 timestamp schema`,
      }
    }

    return {ok: false, reason: `unexpected preflight status ${res.status} from ${url}`}
  } catch (error) {
    return {ok: false, reason: `preflight unreachable: ${(error as Error).message}`}
  }
}

describe('M4.7 analytics e2e (real CLI, real daemon, real backend)', function () {
  this.timeout(600_000)

  const cleanupDirs: string[] = []
  let currentScenario: ScenarioEnv | undefined

  before(async function () {
    if (!existsSync(BRV_BIN)) {
      console.log(`[M4.7 e2e] ${BRV_BIN} missing - run \`npm install\` first. Skipping suite.`)
      this.skip()
    }

    if (!existsSync(DIST_DAEMON)) {
      console.log(
        `[M4.7 e2e] ${DIST_DAEMON} missing - run \`npm run build\` first ` +
          `(the npm script does this automatically via pretest:e2e:analytics). Skipping suite.`,
      )
      this.skip()
    }

    const pre = await preflightBackend(DEFAULT_BACKEND)
    if (!pre.ok) {
      console.log(`[M4.7 e2e] preflight failed: ${pre.reason}. Skipping suite.`)
      this.skip()
    }
  })

  afterEach(async () => {
    // Tear down the SCENARIO's daemon (scoped via env). Skipping this would
    // leak a node process per scenario - bin/kill-daemon.js without scoped env
    // would read the user's real ~/Library/.../daemon.json instead.
    if (currentScenario !== undefined) {
      restartBrv(currentScenario.env)
      currentScenario = undefined
    }

    await sleep(500)
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()
      if (dir !== undefined && existsSync(dir)) {
        await rm(dir, {force: true, recursive: true})
      }
    }
  })

  describe('1 happy', () => {
    it('opt-in + 1 event ships within 35s', async () => {
      const scenario = makeScenarioEnv()
      currentScenario = scenario
      cleanupDirs.push(scenario.dataDir, scenario.home)
      expect(enableAnalytics(scenario.env)).to.deep.include({ok: true})
      expect(bootDaemon(scenario.env)).to.deep.include({ok: true})
      const emit = await emitEvents(1, scenario.env)
      expect(emit.failed, 'emit failures').to.equal(0)
      const ok = await waitForStatus(jsonlPath(scenario.dataDir), 'sent', 35_000)
      expect(ok, `timeout waiting for status=sent in ${jsonlPath(scenario.dataDir)}`).to.equal(true)
    })
  })

  describe('2 burst', () => {
    it('25 events trigger the 20-event threshold flush', async function () {
      this.timeout(120_000)
      const scenario = makeScenarioEnv()
      currentScenario = scenario
      cleanupDirs.push(scenario.dataDir, scenario.home)
      expect(enableAnalytics(scenario.env)).to.deep.include({ok: true})
      expect(bootDaemon(scenario.env)).to.deep.include({ok: true})
      const emit = await emitEvents(25, scenario.env)
      expect(emit.failed, 'emit failures').to.equal(0)
      // 20-event threshold ships first batch immediately; periodic 30s
      // tick catches stragglers. Wait up to 60s for >= 25 sent.
      const ok = await waitFor(() => countStatus(jsonlPath(scenario.dataDir), 'sent') >= 25, 60_000, 2000)
      const sent = countStatus(jsonlPath(scenario.dataDir), 'sent')
      const pending = countStatus(jsonlPath(scenario.dataDir), 'pending')
      expect(ok, `only ${sent} sent after 60s (pending=${pending})`).to.equal(true)
    })
  })

  describe('3 idle', () => {
    it('1 event ships via the 30s interval timer', async function () {
      this.timeout(90_000)
      const scenario = makeScenarioEnv()
      currentScenario = scenario
      cleanupDirs.push(scenario.dataDir, scenario.home)
      expect(enableAnalytics(scenario.env)).to.deep.include({ok: true})
      expect(bootDaemon(scenario.env)).to.deep.include({ok: true})
      const emit = await emitEvents(1, scenario.env)
      expect(emit.failed, 'emit failures').to.equal(0)
      const ok = await waitForStatus(jsonlPath(scenario.dataDir), 'sent', 45_000)
      expect(ok, 'timeout waiting for interval-driven flush').to.equal(true)
    })
  })

  describe('4 transition (manual brv login)', () => {
    const enabled = process.env.BRV_E2E_TRANSITION === '1'
    const itMaybe = enabled ? it : it.skip
    itMaybe('anon -> brv login -> authed, both ship with correct identity', async function () {
      this.timeout(360_000)
      const scenario = makeScenarioEnv()
      currentScenario = scenario
      cleanupDirs.push(scenario.dataDir, scenario.home)
      expect(enableAnalytics(scenario.env)).to.deep.include({ok: true})
      expect(bootDaemon(scenario.env)).to.deep.include({ok: true})
      expect((await emitEvents(1, scenario.env)).failed).to.equal(0)
      expect(await waitForStatus(jsonlPath(scenario.dataDir), 'sent', 35_000), 'anon event did not ship').to.equal(true)

      console.log('\n[M4.7 e2e] transition: anon event shipped. NOW run this exact command in another terminal:\n')
      console.log(
        `  HOME='${scenario.home}' BRV_DATA_DIR='${scenario.dataDir}' ` +
          `BRV_IAM_BASE_URL='${DEFAULT_IAM}' BRV_ENV=development ` +
          `node '${BRV_BIN}' login\n`,
      )
      console.log('[M4.7 e2e] waiting up to 5 minutes for credentials to appear...\n')

      const credentialsPath = join(scenario.dataDir, 'credentials')
      const loggedIn = await waitFor(() => existsSync(credentialsPath), 300_000, 2000)
      expect(loggedIn, 'no login detected within 5 minutes').to.equal(true)

      // Pre-hook flushes anon batch; post-hook clears the on-disk queue.
      // Wait for that to settle before emitting the authed event.
      await sleep(10_000)
      expect((await emitEvents(1, scenario.env)).failed).to.equal(0)
      expect(await waitForStatus(jsonlPath(scenario.dataDir), 'sent', 45_000), 'post-login event did not ship').to.equal(
        true,
      )
      const rows = readRows(jsonlPath(scenario.dataDir))
      const last = rows.at(-1)
      const userId = last?.identity?.user_id ?? ''
      expect(userId, 'post-login event must carry a user_id').to.be.a('string').and.have.length.greaterThan(0)
    })
  })

  describe('5 down (drop-proxy)', () => {
    let dropProxy: undefined | {close: () => Promise<void>; port: number}
    let acceptProxy: undefined | {close: () => Promise<void>}

    afterEach(async () => {
      if (acceptProxy) {
        await acceptProxy.close()
        acceptProxy = undefined
      }

      if (dropProxy) {
        await dropProxy.close()
        dropProxy = undefined
      }
    })

    it('failed flush advances backoff counters AND backend-up resets them', async function () {
      // Phase A (~35s drop wait) + Phase B (~35s accept wait) + boot/emit + slack.
      this.timeout(180_000)

      // -------- Phase A: backend down --------
      dropProxy = await startDropProxy()
      const {port} = dropProxy
      const backend = `http://127.0.0.1:${port}`
      const scenario = makeScenarioEnv(backend)
      currentScenario = scenario
      cleanupDirs.push(scenario.dataDir, scenario.home)
      expect(enableAnalytics(scenario.env)).to.deep.include({ok: true})
      expect(bootDaemon(scenario.env)).to.deep.include({ok: true})
      expect((await emitEvents(1, scenario.env)).failed).to.equal(0)

      // One 30s tick + slack for retry classification.
      await sleep(35_000)

      const rows = readRows(jsonlPath(scenario.dataDir))
      const tracked = rows.filter((r) => r.name === 'cli_invocation')
      let maxAttempts = 0
      for (const row of tracked) {
        if ((row.attempts ?? 0) > maxAttempts) maxAttempts = row.attempts ?? 0
      }

      expect(maxAttempts, 'daemon never attempted to flush against drop-proxy').to.be.greaterThan(0)
      const downState = readBackoffFailures(scenario.env)
      expect(
        downState.failures,
        `expected backoff.consecutive_failures > 0 (state=${downState.state})`,
      ).to.be.greaterThan(0)

      // -------- Phase B: backend back up, observe recovery --------
      // Free the port so the accept-proxy can bind it. Daemon URL doesn't
      // change - the next flush tick will hit the new server on same port.
      await dropProxy.close()
      dropProxy = undefined
      acceptProxy = await startAcceptProxy(port)

      // Emit one fresh event so the queue is non-empty after Phase A wipes.
      // M4.5 backoff is exponential, so a single 30s tick may not trigger
      // the next retry attempt - poll up to 90s for `consecutive_failures`
      // to drop back to 0 (covers up to ~3 backoff windows).
      expect((await emitEvents(1, scenario.env)).failed).to.equal(0)
      const recovered = await waitFor(() => readBackoffFailures(scenario.env).failures === 0, 90_000, 2000)

      const upState = readBackoffFailures(scenario.env)
      expect(
        recovered,
        `expected backoff.consecutive_failures to reset to 0 within 90s (was ${downState.failures}, now ${upState.failures}, state=${upState.state})`,
      ).to.equal(true)
      const sentAfter = countStatus(jsonlPath(scenario.dataDir), 'sent')
      expect(sentAfter, 'expected >=1 sent row after backend recovery').to.be.at.least(1)
    })
  })

  describe('6 disable mid-flight', () => {
    it('post-disable events stay pending, no further ships', async function () {
      this.timeout(120_000)
      const scenario = makeScenarioEnv()
      currentScenario = scenario
      cleanupDirs.push(scenario.dataDir, scenario.home)
      expect(enableAnalytics(scenario.env)).to.deep.include({ok: true})
      expect(bootDaemon(scenario.env)).to.deep.include({ok: true})

      expect((await emitEvents(1, scenario.env)).failed).to.equal(0)
      expect(await waitForStatus(jsonlPath(scenario.dataDir), 'sent', 35_000), 'baseline event did not ship').to.equal(
        true,
      )
      const sentBefore = countStatus(jsonlPath(scenario.dataDir), 'sent')

      expect(disableAnalytics(scenario.env)).to.deep.include({ok: true})

      // After disable, `analytics:track` still writes to JSONL but the
      // flush scheduler is gated, so status should stay pending.
      expect((await emitEvents(5, scenario.env)).failed).to.equal(0)
      await sleep(35_000)

      const sentAfter = countStatus(jsonlPath(scenario.dataDir), 'sent')
      const pendingAfter = countStatus(jsonlPath(scenario.dataDir), 'pending')
      expect(sentAfter, `expected no new sends after disable (was ${sentBefore})`).to.equal(sentBefore)
      expect(pendingAfter, 'expected >= 5 pending rows after disable').to.be.at.least(5)
    })
  })
})
