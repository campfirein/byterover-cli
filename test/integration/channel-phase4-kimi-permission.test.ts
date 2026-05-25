import {expect} from 'chai'
import {existsSync, unlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {requireKimiAcp} from '../helpers/kimi-acp-e2e.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 4.1 — Phase-4 E2E permission round-trip.
//
// Real kimi requests permission to write a file; the test approves via
// `brv channel approve` and asserts the file is created. Currently fails
// because the projector drops kimi's `content[]` blocks on the
// permission_request payload — Slice 4.3 fixes that.

describe('Channel Phase 4 — real kimi-acp permission round-trip', function () {
  this.timeout(240_000)

  let harness: ChannelTestHarness | undefined
  let projectDir: string | undefined
  let kimi: ReturnType<typeof requireKimiAcp>
  let markerPath: string | undefined

  beforeEach(async function () {
    kimi = requireKimiAcp(this, {requireLoggedIn: true})
    if (kimi === undefined) return
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
    markerPath = join(
      tmpdir(),
      `brv-phase4-marker-${Date.now()}-${Math.floor(Math.random() * 1e6)}.txt`,
    )
  })

  afterEach(async () => {
    if (harness !== undefined) await harness.shutdown()
    if (projectDir !== undefined) await removeTempDir(projectDir)
    if (markerPath !== undefined && existsSync(markerPath)) unlinkSync(markerPath)
    kimi?.cleanup()
    harness = undefined
    projectDir = undefined
    markerPath = undefined
  })

  it('awaits permission, approve via brv channel approve, completes + file written', async () => {
    if (kimi === undefined || harness === undefined || markerPath === undefined) return

    const env = {KIMI_SHARE_DIR: kimi.shareDir}
    expect((await harness.run(`channel onboard kimi -- ${kimi.binaryPath} acp`, {env})).exitCode).to.equal(0)
    expect((await harness.run('channel new pi-test', {env})).exitCode).to.equal(0)
    expect(
      (await harness.run('channel invite pi-test @kimi --profile kimi', {env})).exitCode,
    ).to.equal(0)

    const mention = await harness.run(
      `channel mention pi-test "@kimi please create a file at ${markerPath} containing exactly the word OK" --no-wait --json`,
      {env},
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)
    const {turnId} = accepted.turn

    const permissionEvent = await harness.pollForEvent<{permissionRequestId: string}>(
      'pi-test',
      turnId,
      (event) => event.kind === 'permission_request',
      {timeoutMs: 120_000},
    )
    expect(permissionEvent.permissionRequestId).to.be.a('string')

    const approve = await harness.run(
      `channel approve pi-test ${turnId} ${permissionEvent.permissionRequestId}`,
      {env},
    )
    expect(approve.exitCode, approve.stderr).to.equal(0)

    const terminal = await harness.pollForTerminal('pi-test', turnId, {timeoutMs: 120_000})
    expect(terminal.state).to.equal('completed')
    expect(existsSync(markerPath), `expected kimi to create ${markerPath}`).to.equal(true)
  })
})
