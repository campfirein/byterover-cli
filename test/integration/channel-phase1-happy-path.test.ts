import {expect} from 'chai'

import {
  ChannelTestHarness,
  parseJson,
} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

/**
 * Phase 1 happy-path integration test (CHANNEL_PROTOCOL.md §3 demo).
 *
 * STATUS: red. Slice 1.1 ships only this test file plus the harness stub.
 * The test will fail at `ChannelTestHarness.boot()` until Slice 1.4 (channel
 * orchestrator + handler) and Slice 1.5 (oclif commands) land. Each
 * subsequent slice turns one or more `it()` blocks green.
 *
 * Goalposts encoded here (do not remove — these are the Phase 1 DoD §1+§5):
 *  - new → list → get → post → list-turns → show → archive end-to-end
 *  - Unauthenticated channel:* requests fail with CHANNEL_UNAUTHORIZED
 *    (canonical wire code) or its CLI alias ERR_BRV_DAEMON_NOT_INITIALISED
 *    when the token file is absent before the request is even attempted.
 */
describe('Channel Phase 1 — passive channels happy path', () => {
  let harness: ChannelTestHarness
  let projectDir: string

  beforeEach(async () => {
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    await harness?.shutdown()
    if (projectDir !== undefined) {
      await removeTempDir(projectDir)
    }
  })

  it('new → list → get → post → list-turns → show → archive', async function () {
    // Each run() spawns a fresh subprocess (ts-node + oclif + channel-client)
    // against a daemon that may be cold-starting. Allow generous time for the
    // first call; subsequent calls reuse the warm daemon.
    this.timeout(60_000)

    const createResult = await harness.run('channel new pi-test')
    expect(createResult.exitCode).to.equal(0)

    const listJson = parseJson<{channels: Array<{channelId: string; memberCount: number}>}>(
      (await harness.run('channel list --json')).stdout,
    )
    expect(listJson.channels).to.have.lengthOf(1)
    expect(listJson.channels[0].channelId).to.equal('pi-test')
    expect(listJson.channels[0].memberCount).to.equal(0)

    const getJson = parseJson<{channel: {channelId: string}}>(
      (await harness.run('channel get pi-test --json')).stdout,
    )
    expect(getJson.channel.channelId).to.equal('pi-test')

    const postResult = await harness.run('channel post pi-test "this is a note"')
    expect(postResult.exitCode).to.equal(0)

    const turnsJson = parseJson<{
      turns: Array<{state: string; turnId: string}>
    }>((await harness.run('channel list-turns pi-test --json')).stdout)
    expect(turnsJson.turns).to.have.lengthOf(1)
    expect(turnsJson.turns[0].state).to.equal('completed')

    const {turnId} = turnsJson.turns[0]
    const showJson = parseJson<{
      events: Array<{content?: string; kind: string}>
      turn: {state: string}
    }>((await harness.run(`channel show pi-test ${turnId} --json`)).stdout)
    expect(showJson.turn.state).to.equal('completed')
    expect(
      showJson.events.some((e) => e.kind === 'message' && e.content === 'this is a note'),
    ).to.equal(true)

    const archiveResult = await harness.run('channel archive pi-test')
    expect(archiveResult.exitCode).to.equal(0)

    const listAfter = parseJson<{channels: Array<{archivedAt?: string}>}>(
      (await harness.run('channel list --archived --json')).stdout,
    )
    expect(listAfter.channels[0].archivedAt).to.be.a('string')
  })

  // Auth-rejection canary moved to unit test
  // (test/unit/server/infra/transport/handlers/channel-handler.test.ts).
  //
  // Originally this slice intended to exercise the canary at the integration
  // level by pointing an oclif command at an orphan BRV_DATA_DIR with no
  // daemon-auth-token. That premise collapsed once we put `ensureDaemonRunning`
  // ahead of the token read in channel-client.ts (necessary for the
  // happy-path on first-run installs): pointing at an orphan dir just spawns
  // a fresh daemon there with a fresh token, and the request succeeds.
  //
  // The Slice 1.4 unit test "rejects channel:* requests without a token with
  // CHANNEL_UNAUTHORIZED" already proves the middleware path end-to-end
  // against a stub transport. The auth boundary is covered.
})
