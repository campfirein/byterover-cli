/* eslint-disable camelcase, no-await-in-loop */
/**
 * M14 / M15.6 database-roundtrip e2e — drives a real brv daemon, ships
 * task-lifecycle events over real HTTP to a local telemetry instance,
 * and queries postgres `raw_events` to verify rows landed.
 *
 * Different from `lifecycle-wire.e2e.ts`:
 * - lifecycle-wire stops at the daemon's HTTP request body (in-process
 *   capture stub). Proves the CLI side of the pipeline.
 * - this file goes one more step — through a real telemetry process and
 *   into postgres. Proves the FULL chain from `brv curate` to row-in-db.
 *
 * Requires (skips suite if any missing):
 * - `docker ps` shows `byterover-telemetry-telemetry-1` listening on 3000
 *   (the byterover-telemetry repo's `docker compose up`).
 * - `docker ps` shows `byterover-telemetry-postgres-1` listening on 54329.
 * - `raw_events` table exists in postgres. If telemetry was just brought
 *   up, run migrations once via:
 *     docker exec byterover-telemetry-telemetry-1 sh -c \
 *       'cd /app && node_modules/.bin/typeorm migration:run \
 *         -d dist/infrastructure/persistence/typeorm/data-source.js'
 *
 * Run via `npm run test:e2e:db`. Not picked up by `npm test`.
 * Sequential by design — each `it()` mutates `process.env`.
 */

import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdtempSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {resolveLocalServerMainPath} from '../../../src/server/utils/server-main-resolver.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..')
const BRV_BIN = join(REPO_ROOT, 'bin', 'run.js')
const DIST_DAEMON = join(REPO_ROOT, 'dist', 'server', 'infra', 'daemon', 'brv-server.js')

const TELEMETRY_URL = process.env.E2E_TELEMETRY_URL ?? 'http://localhost:3000'
const POSTGRES_CONTAINER = process.env.E2E_POSTGRES_CONTAINER ?? 'byterover-telemetry-postgres-1'
const POSTGRES_USER = 'telemetry'
const POSTGRES_DB = 'telemetry_test'
const STUB_IAM = process.env.BRV_IAM_BASE_URL ?? 'https://dev-beta-iam.byterover.dev'

type ScenarioEnv = {
  dataDir: string
  env: NodeJS.ProcessEnv
  home: string
}

type RawEventRow = {
  device_id: string
  event_name: string
  failure_kind: null | string
  task_id: string
  task_type: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms)
  })
}

function makeScenarioEnv(): ScenarioEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'brv-e2e-db-'))
  const home = mkdtempSync(join(tmpdir(), 'brv-home-'))
  return {
    dataDir,
    env: {
      ...process.env,
      BRV_ANALYTICS_BASE_URL: TELEMETRY_URL,
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
  if (result.error) return {ok: false, reason: `brv ${args.join(' ')} failed: ${result.error.message}`}
  if (result.status !== 0) return {ok: false, reason: `brv ${args.join(' ')} exit ${result.status}`}
  return {ok: true}
}

function restartBrv(env: NodeJS.ProcessEnv): void {
  spawnSync(process.execPath, [BRV_BIN, 'restart'], {env, stdio: 'ignore', timeout: 30_000})
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 1000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }

  return predicate()
}

/**
 * Execute SQL against the postgres container via `docker exec`. Avoids a
 * host-side `psql` dependency; the container already has it baked in.
 * `-t -A` strips header + alignment so each row is a single tab-delimited
 * line we can split safely.
 */
function execSql(sql: string): {ok: boolean; output: string; reason?: string} {
  const result = spawnSync(
    'docker',
    ['exec', '-i', POSTGRES_CONTAINER, 'psql', '-U', POSTGRES_USER, '-d', POSTGRES_DB, '-t', '-A', '-F', '\t', '-c', sql],
    {encoding: 'utf8', timeout: 10_000},
  )
  if (result.error) return {ok: false, output: '', reason: result.error.message}
  if (result.status !== 0) return {ok: false, output: result.stderr.trim(), reason: `psql exit ${result.status}`}
  return {ok: true, output: result.stdout.trim()}
}

/**
 * Query raw_events for rows matching a task_id prefix. Returns one row per
 * event_name (task_created, task_failed, curate_run_completed, etc).
 */
function fetchEvents(taskIdLike: string): RawEventRow[] {
  const sql = `
    SELECT event_name,
           properties->>'task_id'      AS task_id,
           properties->>'task_type'    AS task_type,
           COALESCE(properties->>'failure_kind', '') AS failure_kind,
           identity_device_id          AS device_id
    FROM raw_events
    WHERE properties->>'task_id' = '${taskIdLike}'
    ORDER BY received_at
  `
  const result = execSql(sql)
  if (!result.ok) return []
  if (result.output.length === 0) return []
  const rows: RawEventRow[] = []
  for (const line of result.output.split('\n')) {
    const [event_name, task_id, task_type, failure_kind, device_id] = line.split('\t')
    rows.push({
      device_id,
      event_name,
      failure_kind: failure_kind === '' ? null : failure_kind,
      task_id,
      task_type,
    })
  }

  return rows
}

async function checkTelemetryReachable(): Promise<boolean> {
  try {
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
    const res = await fetch(`${TELEMETRY_URL}/health`, {signal: AbortSignal.timeout(3000)})
    return res.status === 200
  } catch {
    return false
  }
}

function checkPostgresReachable(): boolean {
  return execSql('SELECT 1').ok
}

function checkRawEventsTableExists(): boolean {
  const result = execSql("SELECT to_regclass('public.raw_events')")
  if (!result.ok) return false
  // to_regclass returns the table name when found, empty string when not.
  return result.output.trim().length > 0 && result.output.trim() !== ''
}

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

describe('analytics lifecycle DB roundtrip e2e (M14 / M15.6)', function () {
  this.timeout(120_000)

  let scenario: ScenarioEnv | undefined
  const cleanupDirs: string[] = []

  before(async function () {
    if (!existsSync(BRV_BIN) || !existsSync(DIST_DAEMON)) {
      console.log('[db e2e] dist missing — run `npm run build`. Skipping.')
      this.skip()
    }

    if (!(await checkTelemetryReachable())) {
      console.log(
        `[db e2e] telemetry not reachable at ${TELEMETRY_URL}.` +
          ' Start it via `docker compose up -d` from byterover-telemetry. Skipping.',
      )
      this.skip()
    }

    if (!checkPostgresReachable()) {
      console.log(
        `[db e2e] postgres container '${POSTGRES_CONTAINER}' not reachable via docker exec.` +
          ' Start it via `docker compose -f docker-compose.test.yml up -d postgres` from byterover-telemetry. Skipping.',
      )
      this.skip()
    }

    if (!checkRawEventsTableExists()) {
      console.log(
        "[db e2e] raw_events table missing in telemetry_test DB. Run migrations:\n" +
          "  docker exec byterover-telemetry-telemetry-1 sh -c \\\n" +
          "    'cd /app && node_modules/.bin/typeorm migration:run " +
          "-d dist/infrastructure/persistence/typeorm/data-source.js'\n" +
          'Skipping.',
      )
      this.skip()
    }
  })

  beforeEach(() => {
    scenario = makeScenarioEnv()
    cleanupDirs.push(scenario.dataDir, scenario.home)

    expect(runBrv(['analytics', 'enable', '--yes'], scenario.env), 'analytics enable').to.deep.include({ok: true})
    expect(runBrv(['status'], scenario.env), 'daemon boot via status').to.deep.include({ok: true})
  })

  afterEach(async function () {
    if (scenario) {
      restartBrv(scenario.env)
      // Preserve dirs on failure so we can inspect daemon logs + JSONL.
      if (this.currentTest?.state === 'failed') {
        console.log(`[db e2e] preserving dataDir=${scenario.dataDir} home=${scenario.home}`)
        scenario = undefined
        cleanupDirs.length = 0
        return
      }

      scenario = undefined
    }

    await sleep(300)
    while (cleanupDirs.length > 0) {
      const dir = cleanupDirs.pop()
      if (dir !== undefined && existsSync(dir)) {
        await rm(dir, {force: true, recursive: true})
      }
    }
  })

  describe('curate-tool-mode roundtrip', () => {
    it('task_created + curate_run_completed + task_failed land in raw_events with task_type=curate-tool-mode', async function () {
      this.timeout(90_000)
      const taskId = `e2e-db-curate-tm-${Date.now()}`
      await fireCreateAndCancel(scenario!.env, {
        content: 'demo curate tool-mode db roundtrip',
        taskId,
        type: 'curate-html-direct',
      })

      const ok = await waitFor(async () => fetchEvents(taskId).length >= 3, 60_000, 2000)
      const rows = fetchEvents(taskId)
      expect(ok, `rows for ${taskId} (saw ${rows.length}: ${rows.map((r) => r.event_name).join(',')})`).to.equal(true)

      const byName = new Map(rows.map((r) => [r.event_name, r]))
      expect(byName.has('task_created'), 'task_created landed').to.equal(true)
      expect(byName.has('curate_run_completed'), 'curate_run_completed landed').to.equal(true)
      expect(byName.has('task_failed'), 'task_failed landed').to.equal(true)

      // Alias check: daemon dispatched 'curate-html-direct', wire + DB carry the canonical 'curate-tool-mode'.
      expect(byName.get('task_created')!.task_type).to.equal('curate-tool-mode')
      expect(byName.get('task_failed')!.task_type).to.equal('curate-tool-mode')
      // M15.6 failure_kind classifier — cancel always maps to 'cancelled'.
      expect(byName.get('task_failed')!.failure_kind).to.equal('cancelled')
      // Same device_id stamped on every row.
      const deviceIds = new Set(rows.map((r) => r.device_id))
      expect(deviceIds.size, 'all rows carry the same device_id').to.equal(1)
    })
  })

  describe('query-tool-mode roundtrip', () => {
    it('task_created + query_completed + task_failed land with task_type=query-tool-mode', async function () {
      this.timeout(90_000)
      const taskId = `e2e-db-query-tm-${Date.now()}`
      await fireCreateAndCancel(scenario!.env, {
        content: 'demo query tool-mode db roundtrip',
        taskId,
        type: 'query-tool-mode',
      })

      const ok = await waitFor(async () => fetchEvents(taskId).length >= 3, 60_000, 2000)
      const rows = fetchEvents(taskId)
      expect(ok, `rows for ${taskId} (saw ${rows.length})`).to.equal(true)

      const byName = new Map(rows.map((r) => [r.event_name, r]))
      expect(byName.has('task_created'), 'task_created landed').to.equal(true)
      expect(byName.has('query_completed'), 'query_completed landed').to.equal(true)
      expect(byName.has('task_failed'), 'task_failed landed').to.equal(true)
      expect(byName.get('task_failed')!.task_type).to.equal('query-tool-mode')
      expect(byName.get('task_failed')!.failure_kind).to.equal('cancelled')
    })
  })

  describe('search roundtrip (no per-flavor M12 event)', () => {
    it('only task_created + task_failed land — search has no M12 producer', async function () {
      this.timeout(90_000)
      const taskId = `e2e-db-search-${Date.now()}`
      await fireCreateAndCancel(scenario!.env, {
        content: 'demo search db roundtrip',
        taskId,
        type: 'search',
      })

      const ok = await waitFor(async () => fetchEvents(taskId).length >= 2, 60_000, 2000)
      const rows = fetchEvents(taskId)
      expect(ok, `rows for ${taskId} (saw ${rows.length})`).to.equal(true)

      const names = new Set(rows.map((r) => r.event_name))
      expect(names).to.include('task_created')
      expect(names).to.include('task_failed')
      expect(names).to.not.include('curate_run_completed')
      expect(names).to.not.include('query_completed')
    })
  })
})
