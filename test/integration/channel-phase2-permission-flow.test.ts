import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 2.1: agent emits session/request_permission; orchestrator broadcasts
// a permission_request TurnEvent; `brv channel approve` lands a
// permission_decision with `{ outcome: 'selected', optionId }`; agent resumes
// and finishes the turn.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const MOCK_PERMISSION_PATH = resolve(HARNESS_DIR, '..', 'fixtures', 'mock-acp-permission.js')

describe('Channel Phase 2 — permission flow', function () {
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

  it('permission_request → approve --option-id → resumes', async () => {
    expect((await harness.run('channel new pi-test')).exitCode).to.equal(0)
    expect(
      (await harness.run(`channel invite pi-test @mock -- node ${MOCK_PERMISSION_PATH}`)).exitCode,
    ).to.equal(0)

    const mention = await harness.run(
      'channel mention pi-test "@mock please write README.md" --no-wait --json',
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)

    const event = await harness.pollForEvent<{
      permissionRequestId: string
      request: {options: Array<{kind: string; optionId: string}>}
    }>('pi-test', accepted.turn.turnId, (e) => e.kind === 'permission_request')
    expect(event.permissionRequestId).to.be.a('string')

    const allowOption = event.request.options.find((o) => o.kind.startsWith('allow'))
    expect(allowOption, 'permission options must include an allow-flavoured kind').to.not.equal(undefined)

    const approve = await harness.run(
      `channel approve pi-test ${accepted.turn.turnId} ${event.permissionRequestId} --option-id ${allowOption?.optionId}`,
    )
    expect(approve.exitCode, approve.stderr).to.equal(0)

    const terminal = await harness.pollForTerminal('pi-test', accepted.turn.turnId)
    expect(terminal.state).to.equal('completed')
  })
})
