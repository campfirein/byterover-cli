
import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {ChannelStore} from '../../../../src/server/infra/channel/channel-store.js'
import {ChannelEventsWriter} from '../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../src/server/infra/channel/storage/write-serializer.js'
import {reconstructMissingMetas} from '../../../../src/server/utils/channel-meta-reconstruction.js'
import {makeTempContextTree} from '../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../helpers/temp-dir.js'

// Phase 9.5.10 — channel meta reconstruction (kimi-flagged fixes).
//
// Reconstruction reads `.brv/channel-history/<id>/turns/*.ndjson` and produces
// a minimal meta.json when the channel-history dir exists but the meta is gone.
//
// Fixes in this slice:
//   - Fix A: write through ChannelStore.reconstructIfMissing (same lock as createChannel)
//   - Fix B: scan ALL NDJSON lines, real `turn_snapshot` recordType, min startedAt,
//            filtered `inferredHandles`, `reconstructionStatus` flag
//   - Bug 3: recordType was the wrong literal ('snapshot' vs 'turn_snapshot')

const CHANNEL_ID = 'ch-reconstruct'
const metaRel = (id: string): string[] => ['.brv', 'context-tree', 'channel', id, 'meta.json']
const turnsRel = (id: string): string[] => ['.brv', 'channel-history', id, 'turns']

interface TurnSnapshotFixture {
  authorHandle: string
  authorKind?: 'acp-agent' | 'human-messaging' | 'local-user' | 'remote-peer'
  mentions?: string[]
  startedAt: string
  turnId: string
}

async function writeTurnFile(
  projectRoot: string,
  channelId: string,
  filename: string,
  lines: Array<Record<string, unknown>>,
): Promise<void> {
  const dir = join(projectRoot, ...turnsRel(channelId))
  await fs.mkdir(dir, {recursive: true})
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  await fs.writeFile(join(dir, filename), body, 'utf8')
}

// Realistic NDJSON: event lines BEFORE the terminal turn_snapshot, mirroring
// the live writer (src/server/infra/channel/storage/snapshot-writer.ts:98).
function realisticTurnNdjson(fix: TurnSnapshotFixture, channelId: string): Array<Record<string, unknown>> {
  return [
    // 1) an event line — must be skipped by the scanner
    {kind: 'turn_started', startedAt: fix.startedAt, turnId: fix.turnId},
    // 2) a delivery_snapshot line — should be picked up for inferredHandles
    {
      _recordType: 'delivery_snapshot',
      delivery: {
        channelId,
        deliveryId: `${fix.turnId}-d1`,
        memberHandle: fix.mentions?.[0] ?? '@unused',
        startedAt: fix.startedAt,
        state: 'completed',
        toolCallCount: 0,
        turnId: fix.turnId,
      },
      deliveryId: `${fix.turnId}-d1`,
    },
    // 3) the terminal turn_snapshot — primary source for createdAt + handles
    {
      _recordType: 'turn_snapshot',
      turn: {
        author: {handle: fix.authorHandle, kind: fix.authorKind ?? 'local-user'},
        channelId,
        mentions: fix.mentions ?? [],
        promptBlocks: [],
        promptedBy: 'user',
        startedAt: fix.startedAt,
        state: 'completed',
        turnId: fix.turnId,
      },
    },
  ]
}

function makeChannelStore(): ChannelStore {
  const serializer = new ChannelWriteSerializer()
  return new ChannelStore({
    eventsWriter: new ChannelEventsWriter({serializer}),
    snapshotWriter: new ChannelSnapshotWriter({
      eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()}),
    }),
    treeReader: new ChannelTreeReader(),
    writeSerializer: serializer,
  })
}

interface ReconstructedMeta {
  channelId: string
  createdAt: string
  inferredHandles?: string[]
  members: unknown[]
  reconstructedAt?: string
  reconstructionStatus?: string
  updatedAt: string
}

describe('reconstructMissingMetas() (Phase 9.5.10)', () => {
  let projectRoot: string
  let channelStore: ChannelStore
  const infoLogs: string[] = []
  const log = (msg: string): void => { infoLogs.push(msg) }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    channelStore = makeChannelStore()
    infoLogs.length = 0
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  // ─── Bug 3: scan real `turn_snapshot` recordType across all lines ─────────

  it('uses real `turn_snapshot` recordType — picks up createdAt from a turn whose snapshot line is NOT the first NDJSON line', async () => {
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-abc.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', mentions: ['@bob'], startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-abc'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.createdAt).to.equal('2026-05-24T10:00:00.000Z')
  })

  it('picks the chronologically earlier startedAt across mixed subsecond precision (kimi second-eyes)', async () => {
    // kimi turnId BiAx_ssnAoWFa2qSVdtXy: lex-sorted, "2026-05-24T10:00:00.001Z"
    // would come BEFORE "2026-05-24T10:00:00Z" ('.' < 'Z'), even though the
    // latter is chronologically 1 ms earlier. Verify Date.parse ordering.
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-with-ms.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00.001Z', turnId: 'turn-ms'},
        CHANNEL_ID,
      ),
    )
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-without-ms.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00Z', turnId: 'turn-no-ms'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.createdAt).to.equal('2026-05-24T10:00:00Z')
  })

  it('picks the EARLIEST startedAt across turn files, regardless of filename lexical order', async () => {
    // Lexically first filename has a LATER startedAt.
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-aaa.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-06-01T00:00:00.000Z', turnId: 'turn-aaa'},
        CHANNEL_ID,
      ),
    )
    // Lexically later filename has an EARLIER startedAt.
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-zzz.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-01-01T00:00:00.000Z', turnId: 'turn-zzz'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.createdAt).to.equal('2026-01-01T00:00:00.000Z')
  })

  // ─── Fix B: inferredHandles extraction ────────────────────────────────────

  it('extracts inferredHandles from author + mentions + delivery_snapshot across all turns', async () => {
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-1.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', mentions: ['@bob'], startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-1'},
        CHANNEL_ID,
      ),
    )
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-2.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', mentions: ['@charlie'], startedAt: '2026-05-24T11:00:00.000Z', turnId: 'turn-2'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    // @alice (author x2), @bob (mention turn-1 + delivery_snapshot turn-1),
    // @charlie (mention turn-2 + delivery_snapshot turn-2). Sorted + deduped.
    expect(meta.inferredHandles).to.deep.equal(['@alice', '@bob', '@charlie'])
  })

  it('filters out non-@-prefixed handles (e.g. local-user "you")', async () => {
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-1.ndjson',
      realisticTurnNdjson(
        {
          authorHandle: 'you',
          authorKind: 'local-user',
          mentions: ['@alice'],
          startedAt: '2026-05-24T10:00:00.000Z',
          turnId: 'turn-1',
        },
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.inferredHandles).to.deep.equal(['@alice'])
    expect(meta.inferredHandles).to.not.include('you')
  })

  it('dedupes identical handles across author / mentions / delivery_snapshot', async () => {
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-1.ndjson',
      realisticTurnNdjson(
        {
          authorHandle: '@alice',
          mentions: ['@alice', '@alice'],
          startedAt: '2026-05-24T10:00:00.000Z',
          turnId: 'turn-1',
        },
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.inferredHandles).to.deep.equal(['@alice'])
  })

  it('rejects timezone-offset datetimes (matches ChannelMetaSchema Z-only convention)', async () => {
    // codex impl-review r2: zod's z.string().datetime() is Z-only by default
    // and rejects `+HH:MM` offsets. The reconstruction guard must match so
    // we don't persist a meta whose createdAt fails to re-parse.
    await writeTurnFile(projectRoot, CHANNEL_ID, 'turn-offset.ndjson', [
      {
        _recordType: 'turn_snapshot',
        turn: {
          author: {handle: '@alice', kind: 'local-user'},
          channelId: CHANNEL_ID,
          mentions: [],
          promptBlocks: [],
          promptedBy: 'user',
          startedAt: '2026-05-24T10:00:00+07:00',
          state: 'completed',
          turnId: 'turn-offset',
        },
      },
    ])
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-real.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-real'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    // The Z-only real value wins; the offset value is dropped.
    expect(meta.createdAt).to.equal('2026-05-24T10:00:00.000Z')
  })

  it('drops non-ISO-8601 startedAt values (e.g. malformed JSON-but-string poison) without persisting them as createdAt', async () => {
    // codex impl-review r1 #5: any string passed schema-less straight into
    // createdAt could persist an unreadable meta. Verify the datetime guard.
    await writeTurnFile(projectRoot, CHANNEL_ID, 'turn-poison.ndjson', [
      {
        _recordType: 'turn_snapshot',
        turn: {
          author: {handle: '@alice', kind: 'local-user'},
          channelId: CHANNEL_ID,
          mentions: [],
          promptBlocks: [],
          promptedBy: 'user',
          startedAt: 'not-a-real-date',
          state: 'completed',
          turnId: 'turn-poison',
        },
      },
    ])
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-real.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-real'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.createdAt).to.equal('2026-05-24T10:00:00.000Z')
    expect(meta.createdAt).to.not.equal('not-a-real-date')
  })

  it('tolerates corrupt NDJSON lines without aborting', async () => {
    const turnsDir = join(projectRoot, ...turnsRel(CHANNEL_ID))
    await fs.mkdir(turnsDir, {recursive: true})

    const validLines = realisticTurnNdjson(
      {authorHandle: '@alice', mentions: ['@bob'], startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-1'},
      CHANNEL_ID,
    )
    // Mix in a literal un-parseable line in the middle.
    const body =
      JSON.stringify(validLines[0]) + '\n' +
      'this-is-not-json {{{ broken\n' +
      JSON.stringify(validLines[1]) + '\n' +
      JSON.stringify(validLines[2]) + '\n'
    await fs.writeFile(join(turnsDir, 'turn-1.ndjson'), body, 'utf8')

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.createdAt).to.equal('2026-05-24T10:00:00.000Z')
    expect(meta.inferredHandles).to.deep.equal(['@alice', '@bob'])
  })

  // ─── Fix B: reconstruction marker ─────────────────────────────────────────

  it('sets reconstructionStatus = "reconstructed-from-history"', async () => {
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-1.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-1'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const meta = JSON.parse(
      await fs.readFile(join(projectRoot, ...metaRel(CHANNEL_ID)), 'utf8'),
    ) as ReconstructedMeta
    expect(meta.reconstructionStatus).to.equal('reconstructed-from-history')
  })

  // ─── Fix A: idempotence + race resolution ─────────────────────────────────

  it('does not overwrite an existing meta.json (real meta wins over reconstruction stub)', async () => {
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-1.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-1'},
        CHANNEL_ID,
      ),
    )
    const metaDir = join(projectRoot, '.brv', 'context-tree', 'channel', CHANNEL_ID)
    await fs.mkdir(metaDir, {recursive: true})
    const sentinel = {
      channelId: CHANNEL_ID,
      createdAt: '2026-01-01T00:00:00.000Z',
      members: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    await fs.writeFile(join(metaDir, 'meta.json'), JSON.stringify(sentinel), 'utf8')

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const after = JSON.parse(
      await fs.readFile(join(metaDir, 'meta.json'), 'utf8'),
    ) as ReconstructedMeta
    // Sentinel preserved — reconstructionStatus must NOT have been added.
    expect(after.createdAt).to.equal('2026-01-01T00:00:00.000Z')
    expect(after.reconstructionStatus).to.equal(undefined)
  })

  // ─── Common behavior (preserved from 9.5.9) ───────────────────────────────

  it('emits an INFO log for every reconstructed channel', async () => {
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-1.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-1'},
        CHANNEL_ID,
      ),
    )

    await reconstructMissingMetas({channelStore, log, projectRoot})

    const found = infoLogs.some((m) => m.includes(CHANNEL_ID) && m.includes('reconstruct'))
    expect(found).to.equal(true)
  })

  it('logs a per-channel error when reconstructIfMissing throws (kimi second-eyes)', async () => {
    // kimi turnId BiAx_ssnAoWFa2qSVdtXy: allSettled rejects were silently
    // swallowed. Now a per-channel failure logs the channelId so the
    // operator can see what failed.
    await writeTurnFile(
      projectRoot,
      CHANNEL_ID,
      'turn-1.ndjson',
      realisticTurnNdjson(
        {authorHandle: '@alice', startedAt: '2026-05-24T10:00:00.000Z', turnId: 'turn-1'},
        CHANNEL_ID,
      ),
    )
    const throwingStore = {
      async reconstructIfMissing(): Promise<never> {
        throw new Error('simulated disk failure')
      },
    } as unknown as Parameters<typeof reconstructMissingMetas>[0]['channelStore']

    let threw = false
    try {
      await reconstructMissingMetas({channelStore: throwingStore, log, projectRoot})
    } catch {
      threw = true
    }

    expect(threw).to.equal(false)
    expect(infoLogs.some((m) => m.includes(CHANNEL_ID) && m.includes('simulated disk failure'))).to.equal(true)
  })

  it('does nothing when there is no channel-history directory', async () => {
    let threw = false
    try {
      await reconstructMissingMetas({channelStore, log, projectRoot})
    } catch {
      threw = true
    }

    expect(threw).to.equal(false)
    expect(infoLogs).to.have.length(0)
  })
})
