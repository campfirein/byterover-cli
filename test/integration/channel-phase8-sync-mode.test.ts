import {expect} from 'chai'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {ChannelTestHarness, parseJson} from '../helpers/channel-test-harness.js'
import {makeTempContextTree} from '../helpers/temp-context-tree.js'
import {removeTempDir} from '../helpers/temp-dir.js'

// Slice 8.0 — `channel:mention` sync mode + `suppressThoughts` end-to-end.
// Drives the wire path through real Socket.IO + the daemon + the
// orchestrator's pending-sync lifecycle. Uses mock-acp-thinking.js so we
// can assert thought chunks are emitted by the agent BUT dropped at the
// orchestrator boundary when `suppressThoughts: true`.

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
const MOCK_THINKING_PATH = resolve(HARNESS_DIR, '..', 'fixtures', 'mock-acp-thinking.js')

describe('Channel Phase 8 — sync mode + suppressThoughts', function () {
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

  it('mode: sync returns assembled finalAnswer + endedState=completed', async () => {
    expect((await harness.run('channel new pi-sync')).exitCode).to.equal(0)
    const invite = await harness.run(`channel invite pi-sync @thinker -- node ${MOCK_THINKING_PATH}`)
    expect(invite.exitCode, invite.stderr).to.equal(0)

    const mention = await harness.run(
      'channel mention pi-sync "@thinker hi" --mode sync --json',
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const sync = parseJson<{
      channelId: string
      durationMs: number
      endedState: string
      finalAnswer: string
      toolCalls: unknown[]
      turnId: string
    }>(mention.stdout)

    expect(sync.endedState).to.equal('completed')
    expect(sync.channelId).to.equal('pi-sync')
    expect(sync.turnId).to.be.a('string').and.have.length.greaterThan(0)
    expect(sync.durationMs).to.be.a('number').and.be.greaterThan(0)
    // mock-acp-thinking emits two visible chunks: 'visible chunk A' + 'visible chunk B'
    expect(sync.finalAnswer).to.equal('visible chunk Avisible chunk B')
  })

  it('suppressThoughts drops agent_thought_chunk events on the wire AND on disk', async () => {
    expect((await harness.run('channel new pi-suppress')).exitCode).to.equal(0)
    const invite = await harness.run(`channel invite pi-suppress @thinker -- node ${MOCK_THINKING_PATH}`)
    expect(invite.exitCode, invite.stderr).to.equal(0)

    const mention = await harness.run(
      'channel mention pi-suppress "@thinker hi" --mode sync --suppress-thoughts --json',
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const sync = parseJson<{finalAnswer: string; turnId: string;}>(mention.stdout)

    // Answer chunks must be present (the suppression is targeted at
    // `agent_thought_chunk`, not `agent_message_chunk`).
    expect(sync.finalAnswer).to.contain('visible chunk A')

    // On-disk transcript MUST NOT contain any thought events when
    // suppressThoughts is on. `channel show` reads events.jsonl.
    const show = parseJson<{events: Array<{content?: string; kind: string}>}>(
      (await harness.run(`channel show pi-suppress ${sync.turnId} --json`)).stdout,
    )

    const thoughtEvents = show.events.filter((e) => e.kind === 'agent_thought_chunk')
    expect(thoughtEvents).to.have.lengthOf(0)

    // Sanity — message chunks ARE on disk.
    const messageEvents = show.events.filter((e) => e.kind === 'agent_message_chunk')
    expect(messageEvents.length).to.be.greaterThan(0)
  })

  it('WITHOUT suppressThoughts, agent_thought_chunk events survive on disk', async () => {
    // Negative control — confirms the agent really IS emitting thoughts
    // and that the suppression result above is meaningful.
    expect((await harness.run('channel new pi-keep')).exitCode).to.equal(0)
    const invite = await harness.run(`channel invite pi-keep @thinker -- node ${MOCK_THINKING_PATH}`)
    expect(invite.exitCode, invite.stderr).to.equal(0)

    const mention = await harness.run('channel mention pi-keep "@thinker hi" --mode sync --json')
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const sync = parseJson<{turnId: string}>(mention.stdout)

    const show = parseJson<{events: Array<{kind: string}>}>(
      (await harness.run(`channel show pi-keep ${sync.turnId} --json`)).stdout,
    )
    const thoughtEvents = show.events.filter((e) => e.kind === 'agent_thought_chunk')
    expect(thoughtEvents.length, 'sanity: mock emits 2 thought events when not suppressed').to.equal(2)
  })

  it('stream mode + suppressThoughts together drops thoughts but keeps streaming surface', async () => {
    expect((await harness.run('channel new pi-stream')).exitCode).to.equal(0)
    const invite = await harness.run(`channel invite pi-stream @thinker -- node ${MOCK_THINKING_PATH}`)
    expect(invite.exitCode, invite.stderr).to.equal(0)

    // Stream mode (default) + suppress-thoughts. Use --no-wait so the
    // CLI returns the dispatch JSON without interleaving stream lines
    // (parseJson chokes on `[@you] ...` lines that share a leading `[`).
    // Then poll for terminal via the harness helper and inspect the
    // on-disk transcript.
    const mention = await harness.run(
      'channel mention pi-stream "@thinker hi" --suppress-thoughts --no-wait --json',
    )
    expect(mention.exitCode, mention.stderr).to.equal(0)
    const accepted = parseJson<{turn: {turnId: string}}>(mention.stdout)
    const terminal = await harness.pollForTerminal('pi-stream', accepted.turn.turnId)
    expect(terminal.state).to.equal('completed')

    const show = parseJson<{events: Array<{kind: string}>}>(
      (await harness.run(`channel show pi-stream ${accepted.turn.turnId} --json`)).stdout,
    )
    const thoughtEvents = show.events.filter((e) => e.kind === 'agent_thought_chunk')
    expect(thoughtEvents).to.have.lengthOf(0)
    const messageEvents = show.events.filter((e) => e.kind === 'agent_message_chunk')
    expect(messageEvents.length).to.be.greaterThan(0)
  })
})
