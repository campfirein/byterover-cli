import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 2.1 / Phase-2 happy path: invite a mock ACP agent, mention it, observe
// streamed reply, archive. Drives Slices 2.2–2.5 via outside-in TDD.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const MOCK_ACP_PATH = resolve(HARNESS_DIR, '..', 'fixtures', 'mock-acp.js')

describe('Channel Phase 2 — mention happy path', function () {
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

  it('invite → mention → streamed reply → completed', async () => {
    expect((await harness.run('channel new pi-test')).exitCode).to.equal(0)

    const invite = await harness.run(`channel invite pi-test @mock -- node ${MOCK_ACP_PATH}`)
    expect(invite.exitCode, invite.stderr).to.equal(0)

    const mention = await harness.run('channel mention pi-test "@mock hello" --no-wait --json')
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{deliveries: Array<{state: string}>; turn: {turnId: string}}>(mention.stdout)
    expect(accepted.deliveries).to.have.lengthOf(1)

    const terminal = await harness.pollForTerminal('pi-test', accepted.turn.turnId)
    expect(terminal.state).to.equal('completed')

    const show = parseJson<{events: Array<{content?: string; kind: string}>}>(
      (await harness.run(`channel show pi-test ${accepted.turn.turnId} --json`)).stdout,
    )
    const chunks = show.events.filter((e) => e.kind === 'agent_message_chunk')
    expect(chunks.length).to.be.greaterThan(0)
    expect(chunks.some((c) => (c.content ?? '').includes('mock chunk'))).to.equal(true)

    expect((await harness.run('channel archive pi-test')).exitCode).to.equal(0)
  })
})
