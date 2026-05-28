/* eslint-disable no-await-in-loop */
/**
 * M14 / M15.6 end-to-end wire test — drives a real `brv` daemon with
 * AnalyticsHook wired into lifecycleHooks[], dispatches real `task:create`
 * + `task:cancel` events via the transport client, and asserts the
 * resulting analytics rows are POSTed to a stub HTTP backend with the
 * documented wire shape.
 *
 * Scope (different from `dev-beta.e2e.ts`):
 * - dev-beta.e2e.ts emits pre-formed `cli_invocation` events via
 *   `analytics:track` — proves the daemon's HTTP / retry / backoff path.
 * - This file fires real task-lifecycle events through TaskRouter — proves
 *   AnalyticsHook is in `lifecycleHooks[]` (M15.6) AND that the emit
 *   payload (`task_type`, `failure_kind`, alias-translated tool-mode
 *   names) makes it through the JSONL store + HTTP sender unchanged.
 *
 * Run via `npm run test:e2e:lifecycle`. Not picked up by `npm test`
 * (default glob skips `test/e2e/`). Sequential by design — each `it()`
 * mutates `process.env`; do NOT run mocha with `--parallel`.
 */

import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {createServer as createHttpServer, type Server as HttpServer} from 'node:http'
import {type AddressInfo} from 'node:net'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {resolveLocalServerMainPath} from '../../../src/server/utils/server-main-resolver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BRV_BIN = join(REPO_ROOT, 'bin', 'run.js')
const DIST_DAEMON = join(REPO_ROOT, 'dist', 'server', 'infra', 'daemon', 'brv-server.js')

/**
 * Real dev-beta IAM — daemon hits this once at boot for OIDC discovery
 *  (~400ms). Anonymous emits don't need a valid session, so analytics
 *  flows to our in-process stub regardless. Same default `dev-beta.e2e.ts`
 *  uses. M3.4's env validator rejects path components — root-only URL.
 */
const STUB_IAM = process.env.BRV_IAM_BASE_URL ?? 'https://dev-beta-iam.byterover.dev'

type ScenarioEnv = {
  dataDir: string
  env: NodeJS.ProcessEnv
  home: string
}

type CapturedRequest = {
  body: {events: Array<{identity: Record<string, unknown>; name: string; properties: Record<string, unknown>}>}
  headers: Record<string, string | string[] | undefined>
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms)
  })
}

function makeScenarioEnv(backendUrl: string): ScenarioEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'brv-e2e-lifecycle-'))
  const home = mkdtempSync(join(tmpdir(), 'brv-home-'))
  return {
    dataDir,
    env: {
      ...process.env,
      BRV_ANALYTICS_BASE_URL: backendUrl,
      BRV_DATA_DIR: dataDir,
      BRV_ENV: 'development',
      BRV_IAM_BASE_URL: STUB_IAM,
      HOME: home,
    },
    home,
  }
}

function runBrv(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 30_000): {ok: boolean; reason?: string} {
  const result = spawnSync(process.execPath, [BRV_BIN, ...args], {env, stdio: 'ignore', timeout: timeoutMs})
  if (result.error) return {ok: false, reason: `brv ${args.join(' ')} failed to spawn: ${result.error.message}`}
  if (result.status !== 0) return {ok: false, reason: `brv ${args.join(' ')} exit ${result.status}`}
  return {ok: true}
}

function restartBrv(env: NodeJS.ProcessEnv): void {
  spawnSync(process.execPath, [BRV_BIN, 'restart'], {env, stdio: 'ignore', timeout: 30_000})
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }

  return predicate()
}

/**
 * In-process HTTP backend that records every POST body to `captured`.
 *  Returns 200 with `{accepted: N}` matching the M4.x contract.
 */
async function startCaptureBackend(captured: CapturedRequest[]): Promise<{close: () => Promise<void>; url: string}> {
  return new Promise((res, rej) => {
    const server: HttpServer = createHttpServer((req, response) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body) as CapturedRequest['body']
          captured.push({body: parsed, headers: req.headers})
          response.writeHead(200, {'content-type': 'application/json'})
          response.end(JSON.stringify({accepted: parsed.events?.length ?? 0}))
        } catch {
          response.writeHead(400, {'content-type': 'application/json'})
          response.end('{"error":"bad-json"}')
        }
      })
    })
    server.on('error', rej)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null
      if (!addr || typeof addr === 'string') {
        rej(new Error('capture-backend: unexpected address shape'))
        return
      }

      res({
        close: () =>
          new Promise<void>((closeRes) => {
            server.close(() => closeRes())
          }),
        url: `http://127.0.0.1:${addr.port}`,
      })
    })
  })
}

/**
 * Drive a real task lifecycle against the daemon: create → cancel.
 *
 * AnalyticsHook (registered as the 4th lifecycle peer in M15.6) fires
 * `onTaskCreate` and `onTaskCancelled`, which emit `task_created` and
 * `task_failed{failure_kind:'cancelled'}` rows respectively. The agent
 * fork that would normally do the LLM step is intentionally stub'd by
 * the cancel before it gets to run — we don't need a real provider for
 * the wire-shape assertion.
 */
async function fireCreateAndCancel(
  env: NodeJS.ProcessEnv,
  task: {content: string; projectPath?: string; taskId: string; type: string},
): Promise<void> {
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
      projectPath: task.projectPath ?? REPO_ROOT,
      serverPath: resolveLocalServerMainPath(),
    })

    await client.requestWithAck('task:create', {
      content: task.content,
      projectPath: task.projectPath ?? REPO_ROOT,
      taskId: task.taskId,
      type: task.type,
    })
    // Yield a tick so the create lifecycle hook completes before cancel.
    await sleep(50)
    await client.requestWithAck('task:cancel', {taskId: task.taskId})
    await client.disconnect()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

function eventsByTaskId(captured: CapturedRequest[], taskId: string): Array<{name: string; properties: Record<string, unknown>}> {
  const out: Array<{name: string; properties: Record<string, unknown>}> = []
  for (const req of captured) {
    for (const ev of req.body.events ?? []) {
      if ((ev.properties as {task_id?: string}).task_id === taskId) {
        out.push({name: ev.name, properties: ev.properties})
      }
    }
  }

  return out
}

describe('analytics lifecycle wire e2e (M14 / M15.6)', function () {
  this.timeout(120_000)

  let backend: undefined | {close: () => Promise<void>; url: string}
  let captured: CapturedRequest[]
  let scenario: ScenarioEnv | undefined
  const cleanupDirs: string[] = []

  before(function () {
    if (!existsSync(BRV_BIN)) {
      console.log(`[lifecycle e2e] ${BRV_BIN} missing — run \`npm install\`. Skipping suite.`)
      this.skip()
    }

    if (!existsSync(DIST_DAEMON)) {
      console.log(`[lifecycle e2e] ${DIST_DAEMON} missing — run \`npm run build\`. Skipping suite.`)
      this.skip()
    }
  })

  beforeEach(async () => {
    captured = []
    backend = await startCaptureBackend(captured)
    scenario = makeScenarioEnv(backend.url)
    cleanupDirs.push(scenario.dataDir, scenario.home)

    // Match dev-beta.e2e.ts: enable BEFORE boot. `analytics enable` itself
    // starts a daemon via transport autostart, AND the analytics flush
    // scheduler reads the enabled flag at boot time. If we boot first (with
    // analytics disabled) then flip the flag, the scheduler stays dormant.
    expect(runBrv(['analytics', 'enable', '--yes'], scenario.env), 'analytics enable').to.deep.include({ok: true})
    expect(runBrv(['status'], scenario.env), 'daemon boot via status').to.deep.include({ok: true})
  })

  afterEach(async () => {
    if (scenario) {
      // restart === force-flush + kill — M4.4 + M5 contract. After this
      // runs, every queued row has been attempted against the stub.
      restartBrv(scenario.env)
      scenario = undefined
    }

    if (backend) {
      await backend.close()
      backend = undefined
    }

    await sleep(300)
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()
      if (dir !== undefined && existsSync(dir)) {
        await rm(dir, {force: true, recursive: true})
      }
    }
  })

  /**
   * Common shape check: every event in `captured` carries the super-props
   * stamped by M15.1 + base wire fields (id, timestamp, identity, name,
   * properties, schema_version).
   */
  function assertWireShape(captured_: CapturedRequest[]): void {
    expect(captured_.length, 'at least one HTTP POST').to.be.greaterThan(0)
    for (const req of captured_) {
      expect(req.headers['x-byterover-device-id'], 'device-id header').to.be.a('string')
      expect(req.headers['user-agent']).to.match(/^brv-cli\//)
      expect(req.body.events.length, 'batch has at least one event').to.be.greaterThan(0)
      for (const ev of req.body.events) {
        expect(ev.name, 'event name').to.be.a('string').and.have.length.greaterThan(0)
        const props = ev.properties as Record<string, unknown>
        expect(props.cli_version).to.be.a('string')
        expect(props.os).to.be.a('string')
        expect(props.node_version).to.be.a('string')
        expect(props.environment).to.be.oneOf(['development', 'production'])
        expect(props.device_id).to.be.a('string')
      }
    }
  }

  describe('P0 — curate-tool-mode', () => {
    it('cancel: task_created → task_failed{failure_kind=cancelled, task_type=curate-tool-mode}', async function () {
      this.timeout(90_000)
      const taskId = `e2e-curate-tm-${Date.now()}`
      await fireCreateAndCancel(scenario!.env, {
        content: 'demo curate tool-mode',
        taskId,
        type: 'curate-tool-mode',
      })

      // Wait for the natural 30s flush tick to ship the JSONL rows over
      // HTTP to the stub. brv restart in afterEach handles teardown
      // (force-flushing what's left, killing the daemon).
      const ok = await waitFor(() => eventsByTaskId(captured, taskId).length >= 2, 45_000, 1000)
      expect(ok, `events for ${taskId} (saw ${eventsByTaskId(captured, taskId).length})`).to.equal(true)

      const events = eventsByTaskId(captured, taskId)
      const names = events.map((e) => e.name).filter((n) => n === 'task_created' || n === 'task_failed')
      expect(names).to.include.members(['task_created', 'task_failed'])

      const created = events.find((e) => e.name === 'task_created')!
      const failed = events.find((e) => e.name === 'task_failed')!
      // TaskTypeSchema only accepts the canonical 'curate-tool-mode' over the
      // wire after ENG-2925 — the legacy 'curate-html-direct' alias path is
      // exercised by the AnalyticsHook unit tests, not through the transport.
      expect(created.properties.task_type).to.equal('curate-tool-mode')
      expect(failed.properties.task_type).to.equal('curate-tool-mode')
      // failure_kind classifier (M15.6).
      expect(failed.properties.failure_kind).to.equal('cancelled')
      // duration_ms is a non-negative integer.
      expect(failed.properties.duration_ms).to.be.a('number').and.at.least(0)
      assertWireShape(captured)
    })
  })

  describe('P0 — query-tool-mode', () => {
    it('cancel: task_created → task_failed{failure_kind=cancelled, task_type=query-tool-mode}', async () => {
      const taskId = `e2e-query-tm-${Date.now()}`
      await fireCreateAndCancel(scenario!.env, {
        content: 'demo query tool-mode',
        taskId,
        type: 'query-tool-mode',
      })

      restartBrv(scenario!.env)
      scenario = undefined
      const ok = await waitFor(() => eventsByTaskId(captured, taskId).length >= 2, 30_000, 500)
      expect(ok, `events for ${taskId} (saw ${eventsByTaskId(captured, taskId).length})`).to.equal(true)

      const events = eventsByTaskId(captured, taskId)
      const created = events.find((e) => e.name === 'task_created')!
      const failed = events.find((e) => e.name === 'task_failed')!
      expect(created.properties.task_type).to.equal('query-tool-mode')
      expect(failed.properties.task_type).to.equal('query-tool-mode')
      expect(failed.properties.failure_kind).to.equal('cancelled')
      assertWireShape(captured)
    })
  })

  describe('P1 — other task types (dream-scan / dream-finalize / search)', () => {
    for (const type of ['dream-scan', 'dream-finalize', 'search'] as const) {
      it(`cancel: ${type} emits only generic task_* events (no per-flavor M12)`, async () => {
        const taskId = `e2e-${type}-${Date.now()}`
        await fireCreateAndCancel(scenario!.env, {
          content: `demo ${type}`,
          taskId,
          type,
        })

        restartBrv(scenario!.env)
        scenario = undefined
        const ok = await waitFor(() => eventsByTaskId(captured, taskId).length >= 2, 30_000, 500)
        expect(ok, `events for ${taskId} (saw ${eventsByTaskId(captured, taskId).length})`).to.equal(true)

        const events = eventsByTaskId(captured, taskId)
        const eventNames = new Set(events.map((e) => e.name))
        // M15.6 stance: dream / search task types have no M12 per-flavor
        // emit. Only the generic task_created + task_failed land.
        expect(eventNames).to.not.include('curate_run_completed')
        expect(eventNames).to.not.include('query_completed')
        expect(eventNames).to.include('task_created')
        expect(eventNames).to.include('task_failed')

        const created = events.find((e) => e.name === 'task_created')!
        expect(created.properties.task_type).to.equal(type)
      })
    }
  })

  // Phase B (JSONL/HTTP parity, super-props deep checks) deferred until
  // Phase A is green. Adding them now would conflate "harness shake-down"
  // failures with "wire-shape regression" failures — keep the surface
  // small while we de-flake.
})
