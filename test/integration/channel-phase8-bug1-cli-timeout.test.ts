import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 8.0.2 — Bug 1 regression cover for the CLI-internal
// `request()` path. Independent of the workspace-package
// (`@campfirein/brv-channel-client`) tests, which proved the wrapper
// only; the oclif command surface has its own `request()` invocation
// (see `src/oclif/lib/channel-client.ts`) and that path was the actual
// site of the original bug.
//
// Bug 1 (2026-05-14): `brv channel mention --mode sync --timeout T`
// silently capped at the transport's default 60s because the CLI's
// internal `request()` did not propagate the turn timeout into its
// own transport-level deadline. Long-running agents (T > 60s) failed
// with `CHANNEL_REQUEST_TIMEOUT` before the daemon could settle the
// sync resolver.
//
// Fix: when `--mode sync` passes `timeoutMs` on the wire, the CLI's
// `request()` uses `timeoutMs + grace` as its transport deadline
// instead of the env-default.
//
// Regression test strategy: drive a real `brv channel mention --mode
// sync` with a SHORT `BRV_CHANNEL_REQUEST_TIMEOUT_MS` env-default and
// a LONGER `--timeout`, against a mock that sleeps past the env-default
// but well within `--timeout`. If the fix regresses, the CLI's
// transport closes the socket at the env-default and the mention exits
// non-zero with `CHANNEL_REQUEST_TIMEOUT`. With the fix in place, the
// transport waits until `--timeout`, the mock acks, and the mention
// exits 0.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const MOCK_DELAYED_END = resolve(HARNESS_DIR, '..', 'fixtures', 'mock-acp-delayed-end.js')

describe('Channel Phase 8 — Bug 1: CLI sync --timeout overrides transport default', function () {
  this.timeout(120_000)

  let harness: ChannelTestHarness
  let projectDir: string

  beforeEach(async () => {
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    await harness.shutdown()
    await removeTempDir(projectDir)
  })

  it('completes a sync mention whose agent sleeps past BRV_CHANNEL_REQUEST_TIMEOUT_MS but within --timeout', async () => {
    // Mock sleeps 5s before returning end_turn. Env default 2s
    // (BRV_CHANNEL_REQUEST_TIMEOUT_MS=2000) would close the socket
    // before the mock acks if --timeout were ignored. --timeout 30000
    // is the real deadline the request() must honour.
    expect((await harness.run('channel new bug1-cli')).exitCode).to.equal(0)
    const invite = await harness.run(
      `channel invite bug1-cli @sleeper -- node ${MOCK_DELAYED_END}`,
    )
    expect(invite.exitCode, invite.stderr).to.equal(0)

    const startedAt = Date.now()
    // Note: mock-acp-delayed-end defaults to 5000ms sleep. MOCK_ACP_SLEEP_MS
    // env on this CLI subprocess does NOT reach the mock (the daemon
    // already booted and spawned the mock with its own inherited env);
    // the 5000ms default in the fixture is what we rely on.
    // BRV_CHANNEL_REQUEST_TIMEOUT_MS DOES affect this subprocess — it's
    // the CLI's own transport-default knob, the exact one Bug 1 used
    // to ignore when --timeout was passed.
    const mention = await harness.run(
      'channel mention bug1-cli "@sleeper hi" --mode sync --timeout 30000 --json',
      {env: {BRV_CHANNEL_REQUEST_TIMEOUT_MS: '2000'}},
    )
    const elapsedMs = Date.now() - startedAt

    expect(mention.exitCode, `expected sync mention to succeed; stderr: ${mention.stderr}`).to.equal(0)
    const sync = parseJson<{
      endedState: string
      finalAnswer: string
      turnId: string
    }>(mention.stdout)
    expect(sync.endedState).to.equal('completed')
    expect(sync.finalAnswer).to.include('pre-sleep chunk')
    expect(sync.finalAnswer).to.include('post-sleep chunk')

    // Sanity: the mention took at least the mock sleep duration —
    // proves we genuinely waited past the 2s env default, not that
    // the test trivially succeeded with a fast-finishing mock.
    expect(elapsedMs, `expected at least 5000ms elapsed; got ${elapsedMs}ms`).to.be.greaterThanOrEqual(4500)
  })
})
