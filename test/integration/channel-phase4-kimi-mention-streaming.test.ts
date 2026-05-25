import {expect} from 'chai'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {requireKimiAcp} from '../helpers/kimi-acp-e2e.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 4.1 — Phase-4 E2E mention happy path.
//
// Currently expected to fail: real kimi emits session/update kinds the
// projector doesn't know (`available_commands_update`, `current_mode_update`,
// `current_model_update`), and `TurnEventSchema.parse(...)` rejects any
// `agent_meta` projection until Slices 4.−1 (schema) + 4.3 (projector) land.

describe('Channel Phase 4 — real kimi-acp mention streaming', function () {
  this.timeout(180_000)

  let harness: ChannelTestHarness | undefined
  let projectDir: string | undefined
  let kimi: ReturnType<typeof requireKimiAcp>

  beforeEach(async function () {
    kimi = requireKimiAcp(this, {requireLoggedIn: true})
    if (kimi === undefined) return
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    if (harness !== undefined) await harness.shutdown()
    if (projectDir !== undefined) await removeTempDir(projectDir)
    kimi?.cleanup()
    harness = undefined
    projectDir = undefined
  })

  it('streams an agent_message_chunk reply and completes the turn', async () => {
    if (kimi === undefined || harness === undefined) return

    const env = {KIMI_SHARE_DIR: kimi.shareDir}
    expect((await harness.run(`channel onboard kimi -- ${kimi.binaryPath} acp`, {env})).exitCode).to.equal(0)
    expect((await harness.run('channel new pi-test', {env})).exitCode).to.equal(0)
    expect(
      (await harness.run('channel invite pi-test @kimi --profile kimi', {env})).exitCode,
    ).to.equal(0)

    const mention = await harness.run(
      'channel mention pi-test "@kimi reply with exactly the word OK and nothing else" --no-wait --json',
      {env},
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)

    const terminal = await harness.pollForTerminal('pi-test', accepted.turn.turnId, {timeoutMs: 150_000})
    expect(terminal.state).to.equal('completed')

    const show = parseJson<{events: Array<{content?: string; kind: string}>}>(
      (await harness.run(`channel show pi-test ${accepted.turn.turnId} --json`, {env})).stdout,
    )
    const chunks = show.events.filter((e) => e.kind === 'agent_message_chunk')
    expect(chunks.length, 'expected at least one streamed reply chunk').to.be.greaterThan(0)
  })
})
