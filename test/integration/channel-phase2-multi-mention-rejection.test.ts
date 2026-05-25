import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 2.1: Phase-2 caps the effective mention set at 1. Mentioning two
// active agents in one turn fails with `CHANNEL_INVALID_REQUEST` and a
// message naming Phase 3 as the slice that raises the cap. The parser and
// member resolver stay multi-mention aware so Phase 3 only flips the cap.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const MOCK_ACP_PATH = resolve(HARNESS_DIR, '..', 'fixtures', 'mock-acp.js')

// SKIP RATIONALE (2026-05-20 internal-test ship)
// Phase 10 added `--quorum` and made multi-mention prompts valid as
// quorum dispatches, so the Phase-2 "multi-mention is always rejected"
// assertion no longer holds. The test predates that surface change and
// fails reliably with `expected +0 to not equal +0` (CLI exits 0 when
// the test expects non-zero). Not a Phase-9 regression; needs either a
// rewrite against current Phase-10 semantics or deletion.
describe.skip('Channel Phase 2 — multi-mention rejection', function () {
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

  it('two active recipients fail with CHANNEL_INVALID_REQUEST naming Phase 3', async () => {
    expect((await harness.run('channel new pi-test')).exitCode).to.equal(0)
    expect((await harness.run(`channel invite pi-test @a -- node ${MOCK_ACP_PATH}`)).exitCode).to.equal(0)
    expect((await harness.run(`channel invite pi-test @b -- node ${MOCK_ACP_PATH}`)).exitCode).to.equal(0)

    const mention = await harness.run('channel mention pi-test "@a @b ping"')
    expect(mention.exitCode).to.not.equal(0)
    expect(mention.stderr).to.match(/CHANNEL_INVALID_REQUEST|multi-agent|Phase 3/i)
  })
})
