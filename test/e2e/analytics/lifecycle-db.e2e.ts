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
 *   into postgres. Proves the FULL chain from `brv curate` to row-in-db
 *   AND that telemetry promotes the documented super-props into top-level
 *   columns (cli_version / os / node_version / environment / schema_version).
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

/**
 * Per-row projection used for the cheap event-name / task-type / device-id
 * assertions. Columns map 1:1 to `raw_events` schema (see
 * byterover-telemetry/.../raw-event.typeorm.entity.ts).
 */
type RawEventRow = {
  cli_version: string
  client_timestamp: string
  device_id: string
  environment: string
  event_name: string
  failure_kind: null | string
  node_version: string
  os: string
  outcome: null | string
  properties_json: string
  received_at: string
  schema_version: number
  task_id: string
  task_type: string
  user_id: null | string
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
 * Query raw_events for rows matching a task_id. Returns one row per event
 * (task_created, task_failed, curate_run_completed, etc) with both the
 * promoted columns (cli_version / os / ...) and the raw properties JSONB
 * for deep inspection.
 */
function fetchEvents(taskIdLike: string): RawEventRow[] {
  const sql = `
    SELECT event_name,
           properties->>'task_id'      AS task_id,
           properties->>'task_type'    AS task_type,
           COALESCE(properties->>'failure_kind', '') AS failure_kind,
           COALESCE(properties->>'outcome', '')      AS outcome,
           identity_device_id          AS device_id,
           COALESCE(identity_user_id, '') AS user_id,
           cli_version,
           os,
           node_version,
           environment,
           schema_version::text,
           client_timestamp::text,
           received_at::text,
           properties::text
    FROM raw_events
    WHERE properties->>'task_id' = '${taskIdLike}'
    ORDER BY received_at
  `
  const result = execSql(sql)
  if (!result.ok) return []
  if (result.output.length === 0) return []
  const rows: RawEventRow[] = []
  for (const line of result.output.split('\n')) {
    const [
      event_name,
      task_id,
      task_type,
      failure_kind,
      outcome,
      device_id,
      user_id,
      cli_version,
      os,
      node_version,
      environment,
      schema_version,
      client_timestamp,
      received_at,
      properties_json,
    ] = line.split('\t')
    rows.push({
      cli_version,
      client_timestamp,
      device_id,
      environment,
      event_name,
      failure_kind: failure_kind === '' ? null : failure_kind,
      node_version,
      os,
      outcome: outcome === '' ? null : outcome,
      properties_json,
      received_at,
      schema_version: Number.parseInt(schema_version, 10),
      task_id,
      task_type,
      user_id: user_id === '' ? null : user_id,
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

/**
 * Common per-row sanity: every row carries the same shape regardless of
 * event_name. Promoted columns are populated from super-props at ingest
 * time — if the telemetry contract changes we want a single assertion
 * point, not a per-test re-check.
 */
function assertRowShape(row: RawEventRow): void {
  expect(row.schema_version, `${row.event_name}.schema_version`).to.equal(2)
  expect(row.cli_version, `${row.event_name}.cli_version`).to.match(/^\d+\.\d+\.\d+/)
  expect(row.os, `${row.event_name}.os`).to.be.oneOf(['darwin', 'linux', 'win32'])
  expect(row.node_version, `${row.event_name}.node_version`).to.match(/^v\d+\./)
  expect(row.environment, `${row.event_name}.environment`).to.be.oneOf(['development', 'production'])
  expect(row.device_id, `${row.event_name}.device_id`).to.be.a('string').and.have.length.greaterThan(0)
  // Anonymous emits are expected — the test never logs in, so user_id MUST be null.
  expect(row.user_id, `${row.event_name}.user_id (anon)`).to.equal(null)
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
        '[db e2e] raw_events table missing in telemetry_test DB. Run migrations:\n' +
          '  docker exec byterover-telemetry-telemetry-1 sh -c \\\n' +
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

    expect(runBrv(['settings', 'set', 'analytics.share', 'true', '--yes'], scenario.env), 'analytics enable').to.deep.include({ok: true})
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
    it('emits task_created + curate_run_completed + task_failed with promoted super-prop columns', async function () {
      this.timeout(90_000)
      const taskId = `e2e-db-curate-tm-${Date.now()}`
      await fireCreateAndCancel(scenario!.env, {
        content: 'demo curate tool-mode db roundtrip',
        taskId,
        type: 'curate-tool-mode',
      })

      const ok = await waitFor(async () => fetchEvents(taskId).length >= 3, 60_000, 2000)
      const rows = fetchEvents(taskId)
      expect(ok, `rows for ${taskId} (saw ${rows.length}: ${rows.map((r) => r.event_name).join(',')})`).to.equal(true)

      const byName = new Map(rows.map((r) => [r.event_name, r]))
      expect(byName.has('task_created'), 'task_created landed').to.equal(true)
      expect(byName.has('curate_run_completed'), 'curate_run_completed landed').to.equal(true)
      expect(byName.has('task_failed'), 'task_failed landed').to.equal(true)

      // After ENG-2925's rename landed, TaskTypeSchema only accepts the
      // canonical 'curate-tool-mode' over the wire — the legacy alias
      // ('curate-html-direct') is exercised by unit / integration tests
      // against AnalyticsHook directly, not through the transport.
      expect(byName.get('task_created')!.task_type).to.equal('curate-tool-mode')
      expect(byName.get('task_failed')!.task_type).to.equal('curate-tool-mode')
      expect(byName.get('curate_run_completed')!.task_type).to.equal('curate-tool-mode')

      // M15.6 failure_kind classifier — cancel always maps to 'cancelled'.
      expect(byName.get('task_failed')!.failure_kind).to.equal('cancelled')

      // M12 curate_run_completed records the terminal outcome — cancel ⇒ 'cancelled'.
      expect(byName.get('curate_run_completed')!.outcome).to.equal('cancelled')

      // Promoted super-prop columns + identity columns hold consistent values
      // across all rows for this task.
      for (const row of rows) assertRowShape(row)
      const deviceIds = new Set(rows.map((r) => r.device_id))
      expect(deviceIds.size, 'all rows carry the same device_id').to.equal(1)
      const cliVersions = new Set(rows.map((r) => r.cli_version))
      expect(cliVersions.size, 'all rows carry the same cli_version').to.equal(1)

      // duration_ms is a non-negative integer on both task_failed and curate_run_completed.
      const failedProps = JSON.parse(byName.get('task_failed')!.properties_json) as {duration_ms: number}
      expect(failedProps.duration_ms).to.be.a('number').and.at.least(0)
      const curateProps = JSON.parse(byName.get('curate_run_completed')!.properties_json) as {
        duration_ms: number
        operations_added: number
        operations_deleted: number
        operations_failed: number
        operations_merged: number
        operations_updated: number
        pending_review_count: number
      }
      expect(curateProps.duration_ms).to.be.a('number').and.at.least(0)
      // Counters all 0 because we cancel before any tool calls.
      expect(curateProps.operations_added, 'operations_added').to.equal(0)
      expect(curateProps.operations_deleted, 'operations_deleted').to.equal(0)
      expect(curateProps.operations_updated, 'operations_updated').to.equal(0)
      expect(curateProps.operations_merged, 'operations_merged').to.equal(0)
      expect(curateProps.operations_failed, 'operations_failed').to.equal(0)
      expect(curateProps.pending_review_count, 'pending_review_count').to.equal(0)
    })
  })

  describe('query-tool-mode roundtrip', () => {
    it('emits task_created + query_completed + task_failed with cancelled outcome', async function () {
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
      expect(byName.get('query_completed')!.outcome).to.equal('cancelled')

      // query_completed payload structure: read/search counters are 0
      // because we cancel before any tool call. Cap-array fields are absent
      // when empty (omit-when-empty, not zero-length array — keeps the
      // payload small and forces consumers to treat missing as 'no data').
      const queryProps = JSON.parse(byName.get('query_completed')!.properties_json) as {
        duration_ms: number
        read_tool_call_count: number
        search_call_count: number
      }
      expect(queryProps.duration_ms).to.be.a('number').and.at.least(0)
      expect(queryProps.read_tool_call_count).to.equal(0)
      expect(queryProps.search_call_count).to.equal(0)

      // task_created carries the has_files / has_folder funnel flags.
      const createdProps = JSON.parse(byName.get('task_created')!.properties_json) as {
        has_files: boolean
        has_folder: boolean
      }
      expect(createdProps.has_files).to.equal(false)
      expect(createdProps.has_folder).to.equal(false)

      for (const row of rows) assertRowShape(row)
    })
  })

  describe('dream-* roundtrip (no per-flavor M12 event)', () => {
    for (const type of ['dream-scan', 'dream-finalize'] as const) {
      it(`${type}: only task_created + task_failed land`, async function () {
        this.timeout(90_000)
        const taskId = `e2e-db-${type}-${Date.now()}`
        await fireCreateAndCancel(scenario!.env, {
          content: `demo ${type} db roundtrip`,
          taskId,
          type,
        })

        const ok = await waitFor(async () => fetchEvents(taskId).length >= 2, 60_000, 2000)
        const rows = fetchEvents(taskId)
        expect(ok, `rows for ${taskId} (saw ${rows.length})`).to.equal(true)

        const names = new Set(rows.map((r) => r.event_name))
        expect(names).to.include('task_created')
        expect(names).to.include('task_failed')
        // Dream task types have no per-flavor producer in AnalyticsHook.
        expect(names).to.not.include('curate_run_completed')
        expect(names).to.not.include('query_completed')

        const byName = new Map(rows.map((r) => [r.event_name, r]))
        expect(byName.get('task_created')!.task_type).to.equal(type)
        expect(byName.get('task_failed')!.task_type).to.equal(type)
        expect(byName.get('task_failed')!.failure_kind).to.equal('cancelled')
        for (const row of rows) assertRowShape(row)
      })
    }
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

      const byName = new Map(rows.map((r) => [r.event_name, r]))
      expect(byName.get('task_failed')!.task_type).to.equal('search')
      expect(byName.get('task_failed')!.failure_kind).to.equal('cancelled')
      for (const row of rows) assertRowShape(row)
    })
  })

  describe('wire-shape sanity (single scenario, deep checks)', () => {
    it('client_timestamp precedes received_at and every event matches the daemon-side identity', async function () {
      this.timeout(90_000)
      const taskId = `e2e-db-shape-${Date.now()}`
      const before = Date.now()
      await fireCreateAndCancel(scenario!.env, {
        content: 'demo wire-shape sanity',
        taskId,
        type: 'curate-tool-mode',
      })

      const ok = await waitFor(async () => fetchEvents(taskId).length >= 3, 60_000, 2000)
      const rows = fetchEvents(taskId)
      expect(ok, `rows for ${taskId} (saw ${rows.length})`).to.equal(true)
      const after = Date.now()

      // Ordering: client_timestamp ≤ received_at on every row, and both fall
      // within the [before, after] window of this test. The 10s slack
      // tolerates clock skew between the test host and the postgres container
      // (typically <1s on docker-for-mac, but flush latency can stretch the
      // received_at upper bound).
      const beforeMs = before - 10_000
      const afterMs = after + 10_000
      for (const row of rows) {
        const client = Date.parse(row.client_timestamp)
        const received = Date.parse(row.received_at)
        expect(Number.isFinite(client), `${row.event_name}.client_timestamp parseable`).to.equal(true)
        expect(Number.isFinite(received), `${row.event_name}.received_at parseable`).to.equal(true)
        expect(client, `${row.event_name}.client_timestamp >= test start`).to.be.at.least(beforeMs)
        expect(received, `${row.event_name}.received_at <= test end`).to.be.at.most(afterMs)
        // Allow a 5s budget for client → server transit + flush queueing.
        expect(client - received, `${row.event_name}.client_timestamp - received_at ≤ 5s`).to.be.at.most(5000)
      }

      // properties.device_id (per-event identity) MUST match the
      // identity_device_id column (promoted from the request body). If these
      // diverge it means M4.1's per-event identity stamp drifted from the
      // request-header device id.
      for (const row of rows) {
        const props = JSON.parse(row.properties_json) as Record<string, unknown>
        expect(props.device_id, `${row.event_name}.properties.device_id`).to.equal(row.device_id)
        expect(props.task_id).to.equal(taskId)
      }
    })
  })

  describe('isolation: two tasks back-to-back', () => {
    it('events for task A do not bleed into task B (task_id selector partitions correctly)', async function () {
      this.timeout(120_000)
      const taskA = `e2e-db-iso-A-${Date.now()}`
      const taskB = `e2e-db-iso-B-${Date.now()}`
      await fireCreateAndCancel(scenario!.env, {content: 'iso A', taskId: taskA, type: 'curate-tool-mode'})
      await fireCreateAndCancel(scenario!.env, {content: 'iso B', taskId: taskB, type: 'query-tool-mode'})

      const ok = await waitFor(
        async () => fetchEvents(taskA).length >= 3 && fetchEvents(taskB).length >= 3,
        90_000,
        2000,
      )
      const rowsA = fetchEvents(taskA)
      const rowsB = fetchEvents(taskB)
      expect(ok, `rows A=${rowsA.length} B=${rowsB.length}`).to.equal(true)

      // No bleed: every row for A carries task_id A, every row for B carries task_id B.
      for (const row of rowsA) expect(row.task_id).to.equal(taskA)
      for (const row of rowsB) expect(row.task_id).to.equal(taskB)
      // Task A is curate-tool-mode, B is query-tool-mode. The DB confirms
      // task_type partitions cleanly along task_id boundaries.
      expect(new Set(rowsA.map((r) => r.task_type))).to.deep.equal(new Set(['curate-tool-mode']))
      expect(new Set(rowsB.map((r) => r.task_type))).to.deep.equal(new Set(['query-tool-mode']))
      expect(rowsA.some((r) => r.event_name === 'curate_run_completed'), 'A has curate_run_completed').to.equal(true)
      expect(rowsB.some((r) => r.event_name === 'query_completed'), 'B has query_completed').to.equal(true)
      // Same device — both tasks ran under the same daemon / global config.
      const devices = new Set([...rowsA.map((r) => r.device_id), ...rowsB.map((r) => r.device_id)])
      expect(devices.size, 'A + B share device_id').to.equal(1)
    })
  })
})
