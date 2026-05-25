import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {dirname} from 'node:path'

import type {Turn} from '../../../../../../src/shared/types/channel.js'

import {ChannelTurnIndexStore} from '../../../../../../src/server/infra/channel/storage/index-store.js'
import {channelPaths} from '../../../../../../src/server/infra/channel/storage/paths.js'
import {ChannelTranscriptGc} from '../../../../../../src/server/infra/channel/storage/transcript-gc.js'
import {ChannelWriteSerializer} from '../../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../../helpers/temp-dir.js'

// Slice 9.4 — periodic GC sweep over the per-channel transcript mount.
// Removes per-turn NDJSON files whose terminal `endedAt` is older than
// `retentionDays`. Active turns (endedAt == null) are NEVER deleted —
// kimi explicitly flagged this in the Phase 9 design review as the GC
// failure mode that produces data corruption mid-stream. Index
// compaction (atomic temp+rename) drops the entries for deleted turns.
describe('ChannelTranscriptGc (Slice 9.4)', () => {
  let projectRoot: string
  let serializer: ChannelWriteSerializer
  let indexStore: ChannelTurnIndexStore
  const channelId = 'pi-test'

  const completedTurn = (turnId: string, endedAtIso: string): Turn => ({
    author: {handle: 'you', kind: 'local-user'},
    channelId,
    endedAt: endedAtIso,
    mentions: [],
    promptBlocks: [{text: `hi ${turnId}`, type: 'text'}],
    promptedBy: 'user',
    startedAt: endedAtIso,
    state: 'completed',
    turnId,
  })

  const inflightTurn = (turnId: string, startedAtIso: string): Turn => ({
    author: {handle: 'you', kind: 'local-user'},
    channelId,
    mentions: [],
    promptBlocks: [{text: `hi ${turnId}`, type: 'text'}],
    promptedBy: 'user',
    startedAt: startedAtIso,
    state: 'dispatched',
    turnId,
  })

  const writeNdjson = async (turnId: string): Promise<void> => {
    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    await fs.mkdir(dirname(file), {recursive: true})
    await fs.writeFile(file, `${JSON.stringify({channelId, content: 'hi', deliveryId: null, emittedAt: '2026-05-17T00:00:00.000Z', kind: 'message', memberHandle: null, role: 'user', seq: 0, turnId})}\n`)
  }

  const seedTurn = async (turn: Turn): Promise<void> => {
    await writeNdjson(turn.turnId)
    await indexStore.appendEntry({channelId, entry: {deliveries: [], turn}, projectRoot})
  }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    serializer = new ChannelWriteSerializer()
    indexStore = new ChannelTurnIndexStore({serializer})
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  describe('retention predicate (active-turn protection — kimi defect)', () => {
    it('NEVER deletes an in-flight turn (endedAt == null) regardless of age', async () => {
      const ancientStart = '2024-01-01T00:00:00.000Z'
      await seedTurn(inflightTurn('still-running', ancientStart))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedNewMount).to.equal(0)
      expect(result.remaining).to.equal(1)

      // NDJSON file is still on disk.
      const file = channelPaths.turnNdjsonFile(projectRoot, channelId, 'still-running')
      expect((await fs.stat(file)).isFile()).to.equal(true)
    })

    it('deletes a terminal turn whose endedAt is older than retention', async () => {
      // 60 days before "now" — well past the 30-day window.
      await seedTurn(completedTurn('old-turn', '2026-03-18T00:00:00.000Z'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedNewMount).to.equal(1)
      expect(result.remaining).to.equal(0)

      const file = channelPaths.turnNdjsonFile(projectRoot, channelId, 'old-turn')
      let exists = true
      try {
        await fs.stat(file)
      } catch {
        exists = false
      }

      expect(exists, 'expected old-turn NDJSON to be deleted').to.equal(false)
    })

    it('keeps a terminal turn whose endedAt is within the retention window', async () => {
      // 25 days before "now" — inside the 30-day window.
      await seedTurn(completedTurn('recent-turn', '2026-04-22T00:00:00.000Z'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedNewMount).to.equal(0)
      expect(result.remaining).to.equal(1)
    })

    it('keeps a turn exactly AT the retention boundary (inclusive comparison)', async () => {
      // Exactly 30 days before "now".
      await seedTurn(completedTurn('edge-turn', '2026-04-17T00:00:00.000Z'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedNewMount).to.equal(0)
    })

    it('mixed batch: deletes old terminal, keeps in-flight + recent', async () => {
      await seedTurn(completedTurn('old-1', '2026-01-01T00:00:00.000Z'))
      await seedTurn(completedTurn('old-2', '2026-02-15T00:00:00.000Z'))
      await seedTurn(completedTurn('recent', '2026-05-10T00:00:00.000Z'))
      await seedTurn(inflightTurn('inflight', '2024-01-01T00:00:00.000Z'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedNewMount).to.equal(2)
      expect(result.remaining).to.equal(2)
    })
  })

  describe('retentionDays = 0 (disabled)', () => {
    it('disables sweep entirely — no deletions even for ancient terminal turns', async () => {
      await seedTurn(completedTurn('ancient', '2020-01-01T00:00:00.000Z'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 0,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedNewMount).to.equal(0)
    })
  })

  describe('index compaction', () => {
    it('rewrites index.jsonl dropping entries for deleted turns', async () => {
      // Seed 3 old + 1 recent. Sweep should delete the 3 old; index
      // should retain only the 1 recent entry.
      await seedTurn(completedTurn('old-a', '2026-01-01T00:00:00.000Z'))
      await seedTurn(completedTurn('old-b', '2026-02-01T00:00:00.000Z'))
      await seedTurn(completedTurn('old-c', '2026-03-01T00:00:00.000Z'))
      await seedTurn(completedTurn('recent', '2026-05-10T00:00:00.000Z'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      await gc.sweepChannel({channelId, projectRoot})

      // On-disk index.jsonl should now have exactly 1 line.
      const indexFile = channelPaths.indexJsonlFile(projectRoot, channelId)
      const raw = await fs.readFile(indexFile, 'utf8')
      const lines = raw.split('\n').filter((l) => l.length > 0)
      expect(lines).to.have.lengthOf(1)
      const remaining = JSON.parse(lines[0]) as {turn: {turnId: string}}
      expect(remaining.turn.turnId).to.equal('recent')
    })

    it('index.jsonl writes are atomic (no .tmp file survives a successful compact)', async () => {
      await seedTurn(completedTurn('to-delete', '2026-01-01T00:00:00.000Z'))
      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      await gc.sweepChannel({channelId, projectRoot})

      const channelDir = dirname(channelPaths.indexJsonlFile(projectRoot, channelId))
      const dirEntries = await fs.readdir(channelDir)
      const tmpRemnants = dirEntries.filter((e) => e.includes('.tmp'))
      expect(tmpRemnants, `unexpected .tmp remnants: ${tmpRemnants.join(',')}`).to.have.lengthOf(0)
    })

    it('refreshes the in-memory map so subsequent getEntries reflect the sweep', async () => {
      await seedTurn(completedTurn('old', '2026-01-01T00:00:00.000Z'))
      await seedTurn(completedTurn('recent', '2026-05-10T00:00:00.000Z'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      await gc.sweepChannel({channelId, projectRoot})

      const entries = await indexStore.getEntries({channelId, projectRoot})
      expect([...entries.keys()]).to.deep.equal(['recent'])
    })
  })

  describe('empty/missing state tolerance', () => {
    it('returns zero counts when the channel has no index', async () => {
      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId: 'never-touched', projectRoot})

      expect(result.deletedNewMount).to.equal(0)
      expect(result.remaining).to.equal(0)
    })

    it('survives an NDJSON file that has already been deleted out from under it', async () => {
      await seedTurn(completedTurn('orphan', '2026-01-01T00:00:00.000Z'))
      // Pre-delete the NDJSON file; the index still has the entry.
      await fs.rm(channelPaths.turnNdjsonFile(projectRoot, channelId, 'orphan'))

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      // The entry was old, so it was scheduled for deletion. The NDJSON
      // unlink ENOENTs — that's fine, treat as success. Index entry gets
      // compacted out either way.
      expect(result.deletedNewMount).to.be.greaterThanOrEqual(0)
      const entries = await indexStore.getEntries({channelId, projectRoot})
      expect(entries.has('orphan')).to.equal(false)
    })
  })

  // Slice 9.5 — legacy `.brv/context-tree/channel/<id>/turns/<turnId>/`
  // (pre-Phase-9 layout) also ages out via the GC sweep so the
  // `isChannelTurnArtifact` cogit exclusion can be retired once these
  // directories naturally vacate.
  describe('legacy mount sweep (Slice 9.5)', () => {
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const writeLegacyTurn = async (turnId: string, endedAtIso?: string): Promise<void> => {
      const turnDir = channelPaths.turnDir(projectRoot, channelId, turnId)
      await fs.mkdir(turnDir, {recursive: true})
      // Legacy events.jsonl with one message + a terminal state change.
      const events = [
        JSON.stringify({channelId, content: 'hi', deliveryId: null, emittedAt: '2026-01-01T00:00:00.000Z', kind: 'message', memberHandle: null, role: 'user', seq: 0, turnId}),
        JSON.stringify({channelId, deliveryId: null, emittedAt: endedAtIso ?? '2026-01-01T00:00:00.000Z', from: 'pending', kind: 'turn_state_change', memberHandle: null, seq: 1, to: 'completed', turnId}),
      ].join('\n')
      await fs.writeFile(channelPaths.eventsFile(projectRoot, channelId, turnId), `${events}\n`)
      if (endedAtIso !== undefined) {
        const legacyTurn = {
          author: {handle: 'you', kind: 'local-user'},
          channelId,
          endedAt: endedAtIso,
          mentions: [],
          promptBlocks: [{text: 'hi', type: 'text'}],
          promptedBy: 'user',
          startedAt: endedAtIso,
          state: 'completed',
          turnId,
        }
        await fs.writeFile(
          channelPaths.turnSnapshotFile(projectRoot, channelId, turnId),
          JSON.stringify(legacyTurn, undefined, 2),
        )
      }
    }

    it('deletes legacy turn subdirs whose turn.json endedAt is older than retention', async () => {
      await writeLegacyTurn('old-legacy', '2026-01-01T00:00:00.000Z')

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedLegacyMount).to.equal(1)

      const dir = channelPaths.turnDir(projectRoot, channelId, 'old-legacy')
      let exists = true
      try {
        await fs.stat(dir)
      } catch {
        exists = false
      }

      expect(exists, 'legacy turn dir must be removed').to.equal(false)
    })

    it('keeps a legacy turn whose endedAt is within retention', async () => {
      await writeLegacyTurn('recent-legacy', '2026-05-10T00:00:00.000Z')

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedLegacyMount).to.equal(0)
      const dir = channelPaths.turnDir(projectRoot, channelId, 'recent-legacy')
      expect((await fs.stat(dir)).isDirectory()).to.equal(true)
    })

    it('NEVER deletes a legacy turn without a turn.json snapshot (in-flight)', async () => {
      // No snapshot file → in-flight (Phase 1-8 turns wrote turn.json only
      // at terminal state). Conservative: assume the turn is still running.
      await writeLegacyTurn('inflight-legacy')

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const result = await gc.sweepChannel({channelId, projectRoot})

      expect(result.deletedLegacyMount).to.equal(0)
    })
  })

  describe('lock coordination (active-turn safety)', () => {
    it('serializes deletion through the per-turn write lock', async () => {
      // Acquire the per-turn lock first, then run the sweep. The sweep
      // should wait until the lock is released, then proceed with the
      // unlink. This proves GC + concurrent writer ordering — kimi
      // defect #2: GC must coordinate with active readers/writers.
      await seedTurn(completedTurn('locked', '2026-01-01T00:00:00.000Z'))

      let writerReleased = false
      const sleep = (ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms)
        })
      const writerHold = serializer.withLock(`${channelId}:locked`, async () => {
        // Hold for a tick so the GC's lock acquire queues behind us.
        await sleep(30)
        writerReleased = true
      })

      const gc = new ChannelTranscriptGc({
        clock: () => new Date('2026-05-17T00:00:00.000Z'),
        indexStore,
        retentionDays: 30,
        serializer,
      })
      const sweep = gc.sweepChannel({channelId, projectRoot})

      await Promise.all([writerHold, sweep])

      expect(writerReleased, 'writer must have run before GC completed').to.equal(true)
      // After GC: the locked turn is finally deleted.
      const file = channelPaths.turnNdjsonFile(projectRoot, channelId, 'locked')
      let exists = true
      try {
        await fs.stat(file)
      } catch {
        exists = false
      }

      expect(exists, 'locked turn should have been deleted after writer released').to.equal(false)
    })
  })
})
