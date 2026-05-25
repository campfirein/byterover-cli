import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 2.1: invite-time `initialize` is enforced. A failing handshake must
// return a non-zero CLI exit with `ACP_HANDSHAKE_FAILED` and leave meta.json
// unchanged.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const MOCK_BAD_HANDSHAKE_PATH = resolve(HARNESS_DIR, '..', 'fixtures', 'mock-acp-bad-handshake.js')

describe('Channel Phase 2 — invite-time initialize handshake', function () {
  this.timeout(60_000)

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

  it('invite fails when the agent handshake fails; member is not persisted', async () => {
    expect((await harness.run('channel new pi-test')).exitCode).to.equal(0)

    const invite = await harness.run(`channel invite pi-test @bad -- node ${MOCK_BAD_HANDSHAKE_PATH}`)
    expect(invite.exitCode).to.not.equal(0)
    expect(invite.stderr).to.match(/ACP_HANDSHAKE_FAILED|handshake|initialize/i)

    const get = parseJson<{channel: {members: unknown[]}}>(
      (await harness.run('channel get pi-test --json')).stdout,
    )
    expect(get.channel.members).to.have.lengthOf(0)
  })
})
