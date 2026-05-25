import {expect} from 'chai'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

/**
 * Phase 1 crash-recovery test (DoD §2; CHANNEL_PROTOCOL.md §4.2 storage rules).
 *
 * Asserts that when a turn's `turn.json` snapshot is missing, the reader
 * reconstructs the `Turn` by replaying `events.jsonl` (the source of truth).
 *
 * STATUS: red. Slice 1.1 stubs the harness; the runtime path that simulates
 * a mid-finalisation crash (delete turn.json after the events are flushed but
 * before the snapshot lands) is wired in Slice 1.3 (storage) and exercised
 * via Slice 1.4 (orchestrator) + Slice 1.5 (oclif `show`).
 */
describe('Channel Phase 1 — crash recovery from events.jsonl', () => {
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

  it('reconstructs a Turn from events.jsonl when turn.json is missing', async () => {
    // 1. Post a turn so events.jsonl + turn.json exist on disk.
    await harness.run('channel new pi-recovery')
    const post = await harness.run('channel post pi-recovery "survive a crash"')
    expect(post.exitCode).to.equal(0)

    const turnsBefore = parseJson<{turns: Array<{turnId: string}>}>(
      (await harness.run('channel list-turns pi-recovery --json')).stdout,
    )
    expect(turnsBefore.turns).to.have.lengthOf(1)
    const {turnId} = turnsBefore.turns[0]

    // 2. Simulate a crash that drops turn.json but leaves events.jsonl intact.
    // Implementation lands in Slice 1.3: storage layer must expose the path,
    // and the helper deletes `<projectDir>/.brv/context-tree/channel/
    // pi-recovery/turns/<turnId>/turn.json` directly. Until then the harness
    // stub throws, surfacing red.
    await harness.simulateSnapshotLoss('pi-recovery', turnId)

    // 3. The reader MUST fall back to events.jsonl and still return the turn.
    const showJson = parseJson<{
      events: Array<{content?: string; kind: string}>
      turn: {state: string}
    }>((await harness.run(`channel show pi-recovery ${turnId} --json`)).stdout)

    expect(showJson.turn.state).to.equal('completed')
    expect(
      showJson.events.some((e) => e.kind === 'message' && e.content === 'survive a crash'),
    ).to.equal(true)
  })
})
