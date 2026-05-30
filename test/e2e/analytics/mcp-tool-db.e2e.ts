/* eslint-disable camelcase, no-await-in-loop */
/**
 * M15.8 MCP-tool database-roundtrip e2e — drives the REAL `brv mcp`
 * server over JSON-RPC (MCP SDK stdio client), exercises the brv-query /
 * brv-curate tools end-to-end, and queries postgres `raw_events` to prove
 * the MCP-specific analytics events land:
 *   - mcp_session_start  (on the MCP initialize handshake)
 *   - mcp_tool_called    (on tool-mode task completion, gated clientType='mcp')
 *   - mcp_session_ended  (on MCP client disconnect)
 *
 * Why this exists alongside `lifecycle-db.e2e.ts`:
 * - lifecycle-db drives tasks with `connectToDaemon({clientType:'cli'})` and
 *   immediately cancels them. That path NEVER produces the mcp_* events
 *   (they are gated on `clientType === 'mcp'`, which only a real MCP client
 *   connection sets). So the MCP funnel was untested against the DB.
 * - This file spawns the actual `brv mcp` process (the same binary coding
 *   agents launch) and speaks MCP JSON-RPC to it, so the daemon registers a
 *   genuine `mcp` client and emits the full mcp_* trio.
 *
 * Both brv-query and brv-curate run deterministic, LLM-free task flavors
 * (`query-tool-mode` = BM25 retrieval; `curate-tool-mode` = validate+write),
 * so the tools complete WITHOUT any LLM provider, billing, or login — the
 * tool call returns a real result and `mcp_tool_called` fires with
 * success=true.
 *
 * Each mcp_* event carries `client_name` (the MCP client's self-reported
 * product name) but NO `task_id` — so rows are queried by `client_name`,
 * which the test sets to a unique value per `it()`.
 *
 * Scenarios:
 *   1. brv-query roundtrip (anonymous): the mcp_* trio lands, every row is
 *      anonymous (user_id null) and shares one device_id.
 *   2. brv-curate roundtrip: mcp_tool_called lands with tool_name='brv-curate'
 *      against a throwaway temp project.
 *   3. device_id rotation on auth transition: inject a UserA token, run a
 *      tool call (events stamped user_id=UserA, device D1), `auth:logout`
 *      (rotates the device_id), run another tool call (events stamped
 *      user_id=null, device D2), assert D1 !== D2.
 *
 *      NOTE — this exercises the LOGOUT rotation path, which is the SAME
 *      `safeRotateDeviceId()` code that fires on a true account switch
 *      (login userA -> userB). A real login-based account switch calls
 *      `userService.getCurrentUser(apiKey)` against the IAM backend and
 *      therefore needs two valid API keys, so it cannot be automated here
 *      without real credentials (cf. dev-beta.e2e.ts scenario 4, which is
 *      manual). Logout is local-only and rotates identically, so it proves
 *      the rotation invariant deterministically.
 *
 * Requires (skips suite if any missing), same as lifecycle-db.e2e.ts:
 * - telemetry reachable at E2E_TELEMETRY_URL (default http://localhost:3000)
 * - postgres container reachable via `docker exec` (default
 *   byterover-telemetry-postgres-1) with a `raw_events` table.
 *
 * Run via `npm run test:e2e:mcp`. Not picked up by `npm test`.
 * Sequential by design — each `it()` mutates process.env in the logout path.
 */

import {Client} from '@modelcontextprotocol/sdk/client/index.js'
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'
import {expect} from 'chai'
import {spawnSync} from 'node:child_process'
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {
  BRV_DIR,
  GLOBAL_CONFIG_DIR,
  GLOBAL_CONFIG_FILE,
  PROJECT_CONFIG_FILE,
} from '../../../src/server/constants.js'
import {AuthToken} from '../../../src/server/core/domain/entities/auth-token.js'
import {FileTokenStore} from '../../../src/server/infra/storage/file-token-store.js'
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
 * Per-row projection for the mcp_* events. Unlike the task_* events these
 * carry no task_id — `client_name` (set per test via the MCP client name)
 * is the selector. tool_name / success are only populated on
 * mcp_tool_called; they are projected as '' for the other event names.
 */
type McpEventRow = {
  cli_version: string
  client_name: string
  device_id: string
  environment: string
  event_name: string
  node_version: string
  os: string
  properties_json: string
  schema_version: number
  success: string
  tool_name: string
  user_id: null | string
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(res, ms)
  })
}

function makeScenarioEnv(): ScenarioEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'brv-e2e-mcp-'))
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

function runBrv(
  args: string[],
  env: NodeJS.ProcessEnv,
  opts: {cwd?: string; timeoutMs?: number} = {},
): {ok: boolean; reason?: string} {
  const result = spawnSync(process.execPath, [BRV_BIN, ...args], {
    cwd: opts.cwd,
    env,
    stdio: 'ignore',
    timeout: opts.timeoutMs ?? 30_000,
  })
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
 * Execute SQL against the postgres container via `docker exec`. `-t -A`
 * strips header + alignment so each row is a single tab-delimited line.
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
 * Query raw_events for the mcp_* rows of one MCP client. Selector is
 * `client_name` (set per test) because mcp_* events are session-scoped,
 * not task-scoped — they carry no task_id.
 */
function fetchMcpEvents(clientName: string): McpEventRow[] {
  const sql = `
    SELECT event_name,
           properties->>'client_name'              AS client_name,
           COALESCE(properties->>'tool_name', '')  AS tool_name,
           COALESCE(properties->>'success', '')    AS success,
           identity_device_id                      AS device_id,
           COALESCE(identity_user_id, '')          AS user_id,
           cli_version,
           os,
           node_version,
           environment,
           schema_version::text,
           properties::text
    FROM raw_events
    WHERE properties->>'client_name' = '${clientName}'
    ORDER BY received_at
  `
  const result = execSql(sql)
  if (!result.ok || result.output.length === 0) return []
  const rows: McpEventRow[] = []
  for (const line of result.output.split('\n')) {
    const [
      event_name,
      client_name,
      tool_name,
      success,
      device_id,
      user_id,
      cli_version,
      os,
      node_version,
      environment,
      schema_version,
      properties_json,
    ] = line.split('\t')
    rows.push({
      cli_version,
      client_name,
      device_id,
      environment,
      event_name,
      node_version,
      os,
      properties_json,
      schema_version: Number.parseInt(schema_version, 10),
      success,
      tool_name,
      user_id: user_id === '' ? null : user_id,
    })
  }

  return rows
}

/**
 * Top-level so the `.some()` predicate does not nest under
 * describe > describe > it > waitFor (which trips max-nested-callbacks).
 */
function hasMcpEvent(clientName: string, eventName: string): boolean {
  return fetchMcpEvents(clientName).some((r) => r.event_name === eventName)
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
  return result.output.trim().length > 0
}

/**
 * Common per-row sanity for the promoted super-prop columns. user_id is
 * NOT asserted here — it varies by scenario (anon vs. injected token).
 */
function assertMcpRowShape(row: McpEventRow): void {
  expect(row.schema_version, `${row.event_name}.schema_version`).to.equal(2)
  expect(row.cli_version, `${row.event_name}.cli_version`).to.match(/^\d+\.\d+\.\d+/)
  expect(row.os, `${row.event_name}.os`).to.be.oneOf(['darwin', 'linux', 'win32'])
  expect(row.node_version, `${row.event_name}.node_version`).to.match(/^v\d+\./)
  expect(row.environment, `${row.event_name}.environment`).to.be.oneOf(['development', 'production'])
  expect(row.device_id, `${row.event_name}.device_id`).to.be.a('string').and.have.length.greaterThan(0)
}

/**
 * Spawns the REAL `brv mcp` process via the MCP SDK stdio client, runs the
 * MCP initialize handshake (which the daemon turns into mcp_session_start),
 * calls one tool, then closes (which the daemon turns into mcp_session_ended).
 *
 * `clientName` becomes the MCP client's product name (`clientInfo.name`),
 * which the daemon records as `client_name` on every mcp_* event — the test
 * uses it as the unique selector for DB assertions.
 *
 * `env` is passed verbatim to the spawned process; StdioClientTransport
 * REPLACES the inherited environment, so the full scenario env (with
 * BRV_DATA_DIR / BRV_ANALYTICS_BASE_URL / HOME / ...) must be forwarded.
 */
async function callMcpTool(opts: {
  args: Record<string, unknown>
  clientName: string
  cwd: string
  env: NodeJS.ProcessEnv
  tool: 'brv-curate' | 'brv-query'
}): Promise<{isError: boolean; text: string}> {
  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env)) {
    if (typeof v === 'string') childEnv[k] = v
  }

  const transport = new StdioClientTransport({
    args: [BRV_BIN, 'mcp'],
    command: process.execPath,
    cwd: opts.cwd,
    env: childEnv,
    stderr: 'ignore',
  })
  const client = new Client({name: opts.clientName, version: '1.0.0'}, {capabilities: {}})

  await client.connect(transport)
  try {
    // Give the daemon a beat to process the async agent-name handshake
    // (sendAgentName is fire-and-forget after `initialize`); this makes
    // client_name reliable on mcp_tool_called instead of racing to 'unknown'.
    await sleep(1000)

    const result = await client.callTool({arguments: opts.args, name: opts.tool})

    let text = ''
    const content = Array.isArray(result.content) ? result.content : []
    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') text += part.text
    }

    return {isError: result.isError === true, text}
  } finally {
    await client.close()
  }
}

/**
 * Issues `auth:logout` over a real cli transport connection. Mirrors the
 * env-swap pattern in lifecycle-db.e2e.ts (connectToDaemon reads
 * process.env for instance discovery). Logout is local-only and rotates
 * the device_id when a valid token was present.
 */
async function daemonLogout(env: NodeJS.ProcessEnv): Promise<void> {
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
    await client.requestWithAck('auth:logout', {})
    await client.disconnect()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

/**
 * Writes an encrypted credentials pair (credentials + .token-key) into the
 * scenario data dir so the daemon, on its next bootstrap loadToken(),
 * resolves a live authenticated identity WITHOUT contacting the IAM backend
 * (per-event identity stamping reads token.userId directly). The token is
 * far-future-dated so isValid() returns true.
 */
async function injectAuthToken(dataDir: string, user: {email: string; id: string}): Promise<void> {
  const store = new FileTokenStore({
    getCredentialsPath: () => join(dataDir, 'credentials'),
    getDataDir: () => dataDir,
    getKeyPath: () => join(dataDir, '.token-key'),
  })
  await store.save(
    new AuthToken({
      accessToken: 'e2e-access-token',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      refreshToken: 'e2e-refresh-token',
      sessionKey: 'e2e-session-key',
      tokenType: 'Bearer',
      userEmail: user.email,
      userId: user.id,
    }),
  )
}

/**
 * Marks `dir` as a resolvable ByteRover project by writing a minimal
 * `.brv/config.json` (the only thing `resolveProject` checks is the file's
 * existence). `brv init` is deprecated (it now redirects to `brv vc init`,
 * which is git init, not a context-tree project), so the project is seeded
 * directly. curate-tool-mode only needs the resolved project root — it
 * writes locally to `<dir>/.brv/context-tree/` and never reads team/space.
 */
function seedProject(dir: string): void {
  mkdirSync(join(dir, BRV_DIR), {recursive: true})
  writeFileSync(
    join(dir, BRV_DIR, PROJECT_CONFIG_FILE),
    JSON.stringify({createdAt: new Date().toISOString(), cwd: dir, version: '0.0.1'}, null, 2),
    'utf8',
  )
}

/**
 * Resolves the global config path the daemon would write to, mirroring
 * `getGlobalConfigDir()` against the SCENARIO env (HOME / XDG_CONFIG_HOME /
 * APPDATA), so the test reads the exact `config.json` the scenario daemon
 * produced. The device_id lives here (NOT under BRV_DATA_DIR).
 */
function globalConfigPath(env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? ''
  if (process.platform === 'win32') {
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE)
  }

  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE)
  }

  return join(env.XDG_CONFIG_HOME ?? join(home, '.config'), GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILE)
}

/**
 * Reads the daemon's current `device_id` from the on-disk global config.
 * Used to observe device_id rotation deterministically (the authenticated
 * events that would carry the pre-rotation id are rejected by the real
 * backend for stamping a synthetic user_id — see the rotation scenario).
 */
function readDeviceId(env: NodeJS.ProcessEnv): string | undefined {
  const configPath = globalConfigPath(env)
  if (!existsSync(configPath)) return undefined
  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {deviceId?: string}
    return typeof cfg.deviceId === 'string' && cfg.deviceId.length > 0 ? cfg.deviceId : undefined
  } catch {
    return undefined
  }
}

describe('analytics MCP-tool DB roundtrip e2e (M15.8)', function () {
  this.timeout(180_000)

  let scenario: ScenarioEnv | undefined
  const cleanupDirs: string[] = []

  before(async function () {
    if (!existsSync(BRV_BIN) || !existsSync(DIST_DAEMON)) {
      console.log('[mcp db e2e] dist missing — run `npm run build`. Skipping.')
      this.skip()
    }

    if (!(await checkTelemetryReachable())) {
      console.log(
        `[mcp db e2e] telemetry not reachable at ${TELEMETRY_URL}.` +
          ' Start it via `docker compose up -d` from byterover-telemetry. Skipping.',
      )
      this.skip()
    }

    if (!checkPostgresReachable()) {
      console.log(
        `[mcp db e2e] postgres container '${POSTGRES_CONTAINER}' not reachable via docker exec. Skipping.`,
      )
      this.skip()
    }

    if (!checkRawEventsTableExists()) {
      console.log('[mcp db e2e] raw_events table missing in telemetry_test DB. Run migrations. Skipping.')
      this.skip()
    }
  })

  beforeEach(() => {
    scenario = makeScenarioEnv()
    cleanupDirs.push(scenario.dataDir, scenario.home)

    expect(
      runBrv(['settings', 'set', 'analytics.share', 'true', '--yes'], scenario.env),
      'analytics enable',
    ).to.deep.include({ok: true})
    expect(runBrv(['status'], scenario.env), 'daemon boot via status').to.deep.include({ok: true})
  })

  afterEach(async function () {
    if (scenario) {
      restartBrv(scenario.env)
      if (this.currentTest?.state === 'failed') {
        console.log(`[mcp db e2e] preserving dataDir=${scenario.dataDir} home=${scenario.home}`)
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

  describe('brv-query roundtrip (anonymous)', () => {
    it('emits mcp_session_start + mcp_tool_called(brv-query) + mcp_session_ended, all anonymous + one device_id', async function () {
      this.timeout(120_000)
      const clientName = `e2e-mcp-query-${Date.now()}`

      const call = await callMcpTool({
        args: {cwd: REPO_ROOT, limit: 5, query: 'how does the analytics pipeline work'},
        clientName,
        cwd: REPO_ROOT,
        env: scenario!.env,
        tool: 'brv-query',
      })
      expect(call.isError, `brv-query tool error: ${call.text}`).to.equal(false)

      const ok = await waitFor(
        async () =>
          hasMcpEvent(clientName, 'mcp_session_start') &&
          hasMcpEvent(clientName, 'mcp_tool_called') &&
          hasMcpEvent(clientName, 'mcp_session_ended'),
        60_000,
        2000,
      )
      const rows = fetchMcpEvents(clientName)
      expect(ok, `mcp_* trio for ${clientName} (saw ${rows.map((r) => r.event_name).join(',')})`).to.equal(true)

      const start = rows.find((r) => r.event_name === 'mcp_session_start')
      const tool = rows.find((r) => r.event_name === 'mcp_tool_called')
      const ended = rows.find((r) => r.event_name === 'mcp_session_ended')
      expect(start, 'mcp_session_start landed').to.not.equal(undefined)
      expect(tool, 'mcp_tool_called landed').to.not.equal(undefined)
      expect(ended, 'mcp_session_ended landed').to.not.equal(undefined)

      // Every mcp_* row reports the MCP client name we chose.
      for (const row of rows) expect(row.client_name, `${row.event_name}.client_name`).to.equal(clientName)

      // mcp_tool_called: tool_name + success.
      expect(tool!.tool_name, 'mcp_tool_called.tool_name').to.equal('brv-query')
      expect(tool!.success, 'mcp_tool_called.success').to.equal('true')
      const toolProps = JSON.parse(tool!.properties_json) as {duration_ms: number}
      expect(toolProps.duration_ms, 'mcp_tool_called.duration_ms').to.be.a('number').and.at.least(0)

      // mcp_session_ended: pairs with start via started_at_unix_ms.
      const endedProps = JSON.parse(ended!.properties_json) as {
        session_duration_ms: number
        started_at_unix_ms: number
      }
      expect(endedProps.session_duration_ms, 'session_duration_ms').to.be.a('number').and.at.least(0)
      expect(endedProps.started_at_unix_ms, 'started_at_unix_ms').to.be.a('number').and.greaterThan(0)

      // Anonymous: never logged in, so user_id MUST be null on every row.
      for (const row of rows) expect(row.user_id, `${row.event_name}.user_id (anon)`).to.equal(null)

      // One daemon / one global config → one device_id across the session.
      expect(new Set(rows.map((r) => r.device_id)).size, 'all mcp_* rows share one device_id').to.equal(1)
      for (const row of rows) assertMcpRowShape(row)
    })
  })

  describe('brv-curate roundtrip', () => {
    it('emits mcp_tool_called with tool_name=brv-curate against a temp project', async function () {
      this.timeout(120_000)
      const clientName = `e2e-mcp-curate-${Date.now()}`

      const projectDir = mkdtempSync(join(tmpdir(), 'brv-e2e-mcp-proj-'))
      cleanupDirs.push(projectDir)
      seedProject(projectDir)

      const html =
        '<bv-topic path="e2e_probe/mcp_curate" title="MCP curate e2e probe" summary="Written by the MCP-tool DB e2e.">' +
        '<bv-rule severity="must">This topic exists only to prove brv-curate emits mcp_tool_called over the real MCP transport.</bv-rule>' +
        '</bv-topic>'

      const call = await callMcpTool({
        args: {cwd: projectDir, html},
        clientName,
        cwd: projectDir,
        env: scenario!.env,
        tool: 'brv-curate',
      })
      expect(call.isError, `brv-curate tool error: ${call.text}`).to.equal(false)

      const ok = await waitFor(async () => hasMcpEvent(clientName, 'mcp_tool_called'), 60_000, 2000)
      const rows = fetchMcpEvents(clientName)
      expect(ok, `mcp_tool_called for ${clientName} (saw ${rows.map((r) => r.event_name).join(',')})`).to.equal(true)

      const tool = rows.find((r) => r.event_name === 'mcp_tool_called')
      expect(tool, 'mcp_tool_called landed').to.not.equal(undefined)
      expect(tool!.tool_name, 'mcp_tool_called.tool_name').to.equal('brv-curate')
      expect(tool!.success, 'mcp_tool_called.success').to.equal('true')
      expect(tool!.user_id, 'mcp_tool_called.user_id (anon)').to.equal(null)
      for (const row of rows) assertMcpRowShape(row)
    })
  })

  describe('device_id rotation on auth transition (logout path = account-switch rotation)', () => {
    /**
     * The pre-logout (authenticated) MCP events are intentionally NOT
     * asserted against postgres. They ARE emitted and correctly stamped
     * with the injected user_id (verified out-of-band: they appear in the
     * local analytics queue with client_name + user_id set), but the real
     * dev telemetry backend rejects events carrying a synthetic user_id
     * that does not reference a known user — so they never reach
     * raw_events. The anonymous post-logout events ship normally (same as
     * the brv-query roundtrip scenario), so the rotation is proven by:
     *   (a) the on-disk device_id flipping across the logout (D1 != D2), and
     *   (b) the post-rotation anonymous mcp_tool_called landing in postgres
     *       with exactly the rotated device_id D2.
     */
    it('rotates device_id on auth:logout; the new device_id is what the next MCP tool ships anonymously', async function () {
      this.timeout(150_000)
      const userA = {email: 'user-a@e2e.test', id: `e2e-user-a-${Date.now()}`}
      const clientAfter = `e2e-mcp-rot-B-${Date.now()}`

      // Inject a live UserA token, then reboot so the daemon's bootstrap
      // loadToken() resolves the authenticated identity deterministically
      // (no IAM call — per-event identity stamping reads token.userId).
      await injectAuthToken(scenario!.dataDir, userA)
      restartBrv(scenario!.env)
      expect(runBrv(['status'], scenario!.env), 'daemon boot after token inject').to.deep.include({ok: true})
      await sleep(1500)

      // The device_id claimed by the authenticated session (D1).
      const deviceA = readDeviceId(scenario!.env)
      expect(deviceA, 'authenticated device_id present on disk').to.be.a('string').and.have.length.greaterThan(0)

      // An authenticated MCP tool call still works end-to-end (its events
      // are emitted under UserA but not DB-asserted; see the block comment).
      const call1 = await callMcpTool({
        args: {cwd: REPO_ROOT, limit: 3, query: 'authenticated probe'},
        clientName: `e2e-mcp-rot-A-${Date.now()}`,
        cwd: REPO_ROOT,
        env: scenario!.env,
        tool: 'brv-query',
      })
      expect(call1.isError, `authenticated brv-query error: ${call1.text}`).to.equal(false)

      // Logout — local-only, rotates device_id because a valid token was present.
      await daemonLogout(scenario!.env)
      await sleep(1500)

      // The device_id after the auth transition (D2).
      const deviceB = readDeviceId(scenario!.env)
      expect(deviceB, 'post-logout device_id present on disk').to.be.a('string').and.have.length.greaterThan(0)

      // The invariant: an auth transition retired the old device_id.
      expect(deviceB, 'device_id rotated on auth transition (D1 != D2)').to.not.equal(deviceA)

      // The next MCP tool call is anonymous and must ship under the rotated id.
      const call2 = await callMcpTool({
        args: {cwd: REPO_ROOT, limit: 3, query: 'post-logout probe'},
        clientName: clientAfter,
        cwd: REPO_ROOT,
        env: scenario!.env,
        tool: 'brv-query',
      })
      expect(call2.isError, `post-logout brv-query error: ${call2.text}`).to.equal(false)

      const okAfter = await waitFor(async () => hasMcpEvent(clientAfter, 'mcp_tool_called'), 60_000, 2000)
      const rowsAfter = fetchMcpEvents(clientAfter)
      expect(okAfter, `post-logout mcp_tool_called (saw ${rowsAfter.map((r) => r.event_name).join(',')})`).to.equal(
        true,
      )
      const toolAfter = rowsAfter.find((r) => r.event_name === 'mcp_tool_called')!
      expect(toolAfter.user_id, 'post-logout user_id = anonymous').to.equal(null)
      expect(toolAfter.device_id, 'postgres row carries the rotated device_id D2').to.equal(deviceB)
      for (const row of rowsAfter) assertMcpRowShape(row)
    })
  })
})
