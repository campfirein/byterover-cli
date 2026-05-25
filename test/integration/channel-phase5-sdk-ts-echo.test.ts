import {expect} from 'chai'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {requireTsSdkE2E} from '../helpers/sdk-e2e.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 5.4 — Phase-5 E2E: onboard the `@brv/agent-sdk` echo example as
// the ACP agent, mention it through brv, assert the streamed reply
// contains the SDK's "you said: …" template. Closes the SDK loop: the
// package isn't "ready" until brv can talk to an agent built with it.

describe('Channel Phase 5 — @brv/agent-sdk TS echo example', function () {
  this.timeout(90_000)

  let harness: ChannelTestHarness | undefined
  let projectDir: string | undefined
  let echoPath: string | undefined

  beforeEach(async function () {
    const gate = requireTsSdkE2E(this)
    if (gate === undefined) return
    echoPath = gate.echoPath
    projectDir = await makeTempContextTree()
    harness = await ChannelTestHarness.boot({projectDir})
  })

  afterEach(async () => {
    if (harness !== undefined) await harness.shutdown()
    if (projectDir !== undefined) await removeTempDir(projectDir)
    harness = undefined
    projectDir = undefined
    echoPath = undefined
  })

  it('onboards, invites, mentions, streams the SDK echo template', async () => {
    if (harness === undefined || echoPath === undefined) return

    const onboard = await harness.run(`channel onboard echo -- node ${echoPath}`)
    expect(onboard.exitCode, onboard.stderr).to.equal(0)

    expect((await harness.run('channel new pi-sdk-ts')).exitCode).to.equal(0)
    expect((await harness.run('channel invite pi-sdk-ts @echo --profile echo')).exitCode).to.equal(0)

    const mention = await harness.run(
      'channel mention pi-sdk-ts "@echo hi there" --no-wait --json',
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)
    const terminal = await harness.pollForTerminal('pi-sdk-ts', accepted.turn.turnId, {timeoutMs: 60_000})
    expect(terminal.state).to.equal('completed')

    const show = parseJson<{events: Array<{content?: string; kind: string}>}>(
      (await harness.run(`channel show pi-sdk-ts ${accepted.turn.turnId} --json`)).stdout,
    )
    const chunks = show.events.filter((e) => e.kind === 'agent_message_chunk')
    expect(chunks.length, 'expected at least one streamed reply chunk').to.be.greaterThan(0)
    // The agent receives the verbatim mention text (`@echo hi there`),
    // so the echoed reply includes the mention prefix.
    expect(chunks.some((c) => (c.content ?? '').includes('you said:') && (c.content ?? '').includes('hi there'))).to.equal(true)
  })
})
