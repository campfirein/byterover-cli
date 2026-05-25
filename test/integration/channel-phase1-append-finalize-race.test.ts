import {expect} from 'chai'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

/**
 * Phase 1 append-vs-finalise race test (DoD §3; CHANNEL_PROTOCOL.md §4.2).
 *
 * Asserts that concurrent posts to the same channel's `events.jsonl` are
 * serialised through the per-turn write lock — no torn writes, monotonic
 * `seq` preserved across the race, and every emitted event survives.
 *
 * STATUS: red. The write serializer lands in Slice 1.3; the orchestrator
 * dispatch path that triggers the race lands in Slice 1.4. Until both are in
 * place the harness stub throws, surfacing red.
 */
describe('Channel Phase 1 — append-vs-finalise race', () => {
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

  it('serialises concurrent appends to the same channel through the per-turn write lock', async () => {
    await harness.run('channel new pi-race')

    // Fire N parallel posts at the same channel. Each post is its own turn,
    // but they share the channel's events.jsonl file underneath the write
    // serializer.
    const N = 10
    const posts = Array.from({length: N}, (_, i) =>
      harness.run(`channel post pi-race "note-${i}"`),
    )

    const results = await Promise.all(posts)
    for (const r of results) {
      expect(r.exitCode, `post failed with stderr: ${r.stderr}`).to.equal(0)
    }

    // All N turns must be persisted and readable.
    const turns = parseJson<{turns: Array<{state: string; turnId: string}>}>(
      (await harness.run(`channel list-turns pi-race --tail ${N} --json`)).stdout,
    )

    expect(turns.turns).to.have.lengthOf(N)
    for (const t of turns.turns) {
      expect(t.state).to.equal('completed')
    }

    // Every turn must be unique. No torn writes that collapse two posts into
    // one turn or duplicate a turnId.
    const ids = new Set(turns.turns.map((t) => t.turnId))
    expect(ids.size).to.equal(N)
  })
})
