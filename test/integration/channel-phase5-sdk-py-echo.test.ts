import {expect} from 'chai'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {requirePySdkE2E} from '../helpers/sdk-e2e.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 5.4 — Phase-5 E2E: onboard the `brv-agent` Python echo example.
// Mirrors `channel-phase5-sdk-ts-echo.test.ts` so the two SDKs prove
// behavioural lock-step against the same brv daemon.

describe('Channel Phase 5 — brv-agent Python echo example', function () {
  this.timeout(120_000)

  let harness: ChannelTestHarness | undefined
  let projectDir: string | undefined
  let echoPath: string | undefined
  let pythonPath: string | undefined

  beforeEach(async function () {
    const gate = requirePySdkE2E(this)
    if (gate === undefined) return
    echoPath = gate.echoPath
    pythonPath = gate.pythonPath
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    if (harness !== undefined) await harness.shutdown()
    if (projectDir !== undefined) await removeTempDir(projectDir)
    harness = undefined
    projectDir = undefined
    echoPath = undefined
    pythonPath = undefined
  })

  it('onboards, invites, mentions, streams the SDK echo template', async () => {
    if (harness === undefined || echoPath === undefined || pythonPath === undefined) return

    const onboard = await harness.run(`channel onboard echo-py -- ${pythonPath} ${echoPath}`)
    expect(onboard.exitCode, onboard.stderr).to.equal(0)

    expect((await harness.run('channel new pi-sdk-py')).exitCode).to.equal(0)
    expect((await harness.run('channel invite pi-sdk-py @echo-py --profile echo-py')).exitCode).to.equal(0)

    const mention = await harness.run(
      'channel mention pi-sdk-py "@echo-py greetings from python" --no-wait --json',
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)
    const terminal = await harness.pollForTerminal('pi-sdk-py', accepted.turn.turnId, {timeoutMs: 90_000})
    expect(terminal.state).to.equal('completed')

    const show = parseJson<{events: Array<{content?: string; kind: string}>}>(
      (await harness.run(`channel show pi-sdk-py ${accepted.turn.turnId} --json`)).stdout,
    )
    const chunks = show.events.filter((e) => e.kind === 'agent_message_chunk')
    expect(chunks.length, 'expected at least one streamed reply chunk').to.be.greaterThan(0)
    // The agent receives the verbatim mention text (`@echo-py greetings...`),
    // so the echoed reply includes the mention prefix.
    expect(
      chunks.some(
        (c) =>
          (c.content ?? '').includes('you said:') &&
          (c.content ?? '').includes('greetings from python'),
      ),
    ).to.equal(true)
  })
})
