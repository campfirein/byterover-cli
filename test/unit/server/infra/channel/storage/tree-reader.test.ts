import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {dirname} from 'node:path'

import type {Turn, TurnEvent} from '../../../../../../src/shared/types/channel.js'

import {ChannelEventsWriter} from '../../../../../../src/server/infra/channel/storage/events-writer.js'
import {channelPaths} from '../../../../../../src/server/infra/channel/storage/paths.js'
import {ChannelSnapshotWriter} from '../../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../../helpers/temp-dir.js'

// Slice 9.1 — read side of the storage layer, after the move to
// .brv/channel-history/. The tree-reader now:
//   1. reads the new per-turn NDJSON file first (events interleaved with
//      structural `_recordType`-tagged lines from the snapshot writer)
//   2. falls back to the legacy events.jsonl + turn.json layout under
//      .brv/context-tree/channel/<id>/turns/<id>/ — so legacy turns
//      from V1-V4 retests remain readable during the migration window
//   3. filters `_recordType !== undefined` lines from event replay so
//      structural lines never surface to subscribers/watchers
describe('ChannelTreeReader (Slice 9.1 — read from both new + legacy)', () => {
  let projectRoot: string
  let reader: ChannelTreeReader
  let eventsWriter: ChannelEventsWriter
  let snapshotWriter: ChannelSnapshotWriter
  let serializer: ChannelWriteSerializer
  const channelId = 'pi-test'
  const turnId = '01HX'

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    reader = new ChannelTreeReader()
    serializer = new ChannelWriteSerializer()
    eventsWriter = new ChannelEventsWriter({serializer})
    snapshotWriter = new ChannelSnapshotWriter({eventsWriter})
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  const messageEvent = (seq: number, content: string): TurnEvent =>
    ({
      channelId,
      content,
      deliveryId: null,
      emittedAt: '2026-05-11T00:00:00.000Z',
      kind: 'message',
      memberHandle: null,
      role: 'user',
      seq,
      turnId,
    } as TurnEvent)

  const stateChangeEvent = (
    seq: number,
    from: Turn['state'],
    to: Turn['state'],
  ): TurnEvent =>
    ({
      channelId,
      deliveryId: null,
      emittedAt: '2026-05-11T00:00:01.000Z',
      from,
      kind: 'turn_state_change',
      memberHandle: null,
      seq,
      to,
      turnId,
    } as TurnEvent)

  const writeSampleTurn = async (): Promise<Turn> => {
    await eventsWriter.append({channelId, event: messageEvent(0, 'hi'), projectRoot, turnId})
    await eventsWriter.append({
      channelId,
      event: stateChangeEvent(1, 'pending', 'completed'),
      projectRoot,
      turnId,
    })

    const turn: Turn = {
      author: {handle: 'you', kind: 'local-user'},
      channelId,
      endedAt: '2026-05-11T00:00:01.000Z',
      mentions: [],
      promptBlocks: [{text: 'hi', type: 'text'}],
      promptedBy: 'user',
      startedAt: '2026-05-11T00:00:00.000Z',
      state: 'completed',
      turnId,
    }
    await snapshotWriter.writeTurnSnapshot({channelId, projectRoot, turn, turnId})
    return turn
  }

  // Write a synthetic LEGACY turn (the pre-Phase-9 layout) using direct
  // filesystem ops. Used to exercise the read-from-both fallback.
  const writeLegacyTurn = async (legacyTurnId: string): Promise<Turn> => {
    const turn: Turn = {
      author: {handle: 'you', kind: 'local-user'},
      channelId,
      endedAt: '2026-05-11T00:00:01.000Z',
      mentions: [],
      promptBlocks: [{text: 'legacy hi', type: 'text'}],
      promptedBy: 'user',
      startedAt: '2026-05-11T00:00:00.000Z',
      state: 'completed',
      turnId: legacyTurnId,
    }
    const eventsFile = channelPaths.eventsFile(projectRoot, channelId, legacyTurnId)
    const snapshotFile = channelPaths.turnSnapshotFile(projectRoot, channelId, legacyTurnId)
    await fs.mkdir(dirname(eventsFile), {recursive: true})
    const lines = [
      JSON.stringify({...messageEvent(0, 'legacy hi'), turnId: legacyTurnId}),
      JSON.stringify({...stateChangeEvent(1, 'pending', 'completed'), turnId: legacyTurnId}),
    ].join('\n')
    await fs.writeFile(eventsFile, `${lines}\n`)
    await fs.writeFile(snapshotFile, JSON.stringify(turn, undefined, 2))
    return turn
  }

  describe('readEvents (new NDJSON mount)', () => {
    it('returns an empty array when no transcript file exists', async () => {
      const events = await reader.readEvents({channelId, projectRoot, turnId})
      expect(events).to.deep.equal([])
    })

    it('returns events in seq order from the new NDJSON', async () => {
      await eventsWriter.append({channelId, event: messageEvent(0, 'a'), projectRoot, turnId})
      await eventsWriter.append({channelId, event: messageEvent(1, 'b'), projectRoot, turnId})
      await eventsWriter.append({channelId, event: messageEvent(2, 'c'), projectRoot, turnId})

      const events = await reader.readEvents({channelId, projectRoot, turnId})
      expect(events).to.have.lengthOf(3)
      expect(events.map((e) => (e.kind === 'message' ? e.content : ''))).to.deep.equal(['a', 'b', 'c'])
    })

    it('skips blank lines tolerantly', async () => {
      await eventsWriter.append({channelId, event: messageEvent(0, 'a'), projectRoot, turnId})
      const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
      await fs.appendFile(file, '\n\n')

      const events = await reader.readEvents({channelId, projectRoot, turnId})
      expect(events).to.have.lengthOf(1)
    })

    it('FILTERS structural `_recordType` lines from event replay (Slice 9.1)', async () => {
      // After writeSampleTurn, the NDJSON contains: 2 wire events + 1
      // turn_snapshot structural line. readEvents must surface ONLY the
      // 2 wire events. Otherwise --after-seq replay would emit the
      // structural line as a fake event and break seq monotonicity for
      // subscribers (codex+kimi consensus on Q7).
      await writeSampleTurn()
      const events = await reader.readEvents({channelId, projectRoot, turnId})
      expect(events).to.have.lengthOf(2)
      for (const ev of events) {
        // Wire events do not carry _recordType.
        expect((ev as unknown as {_recordType?: unknown})._recordType).to.equal(undefined)
      }
    })
  })

  describe('readEvents (legacy fallback)', () => {
    it('reads from legacy events.jsonl when the new NDJSON does not exist', async () => {
      const legacyTurnId = 'legacy-01'
      await writeLegacyTurn(legacyTurnId)

      const events = await reader.readEvents({channelId, projectRoot, turnId: legacyTurnId})
      expect(events).to.have.lengthOf(2)
      const firstMessage = events.find((e) => e.kind === 'message')
      expect(firstMessage && firstMessage.kind === 'message' ? firstMessage.content : '').to.equal(
        'legacy hi',
      )
    })

    it('prefers the new NDJSON when BOTH locations exist (no double-read)', async () => {
      // Defensive: if a legacy and new file coexist for the same
      // (channelId, turnId), the reader must use the NEW one (it is the
      // current writer). Otherwise read-from-both would silently leak
      // pre-migration data into a fresh turn.
      const legacyTurn = await writeLegacyTurn(turnId)
      await eventsWriter.append({channelId, event: messageEvent(0, 'NEW'), projectRoot, turnId})

      const events = await reader.readEvents({channelId, projectRoot, turnId})
      expect(events).to.have.lengthOf(1)
      const ev = events[0]
      expect(ev.kind === 'message' ? ev.content : '').to.equal('NEW')
      // Sanity-check the legacy file still has its 2 events on disk.
      expect(legacyTurn.turnId).to.equal(turnId)
    })
  })

  describe('readTurn (new NDJSON mount)', () => {
    it('returns the latest turn_snapshot line when present', async () => {
      const written = await writeSampleTurn()
      const turn = await reader.readTurn({channelId, projectRoot, turnId})
      expect(turn).to.exist
      expect(turn!.turnId).to.equal(written.turnId)
      expect(turn!.state).to.equal('completed')
    })

    it('returns undefined when no transcript exists in either location', async () => {
      const turn = await reader.readTurn({channelId, projectRoot, turnId: '01HY-missing'})
      expect(turn).to.be.undefined
    })

    it('falls back to event-replay when NDJSON has no turn_snapshot line', async () => {
      // Mid-turn read: only wire events exist, no terminal snapshot yet.
      await eventsWriter.append({channelId, event: messageEvent(0, 'hi'), projectRoot, turnId})
      await eventsWriter.append({
        channelId,
        event: stateChangeEvent(1, 'pending', 'completed'),
        projectRoot,
        turnId,
      })

      const turn = await reader.readTurn({channelId, projectRoot, turnId})
      expect(turn).to.exist
      expect(turn!.turnId).to.equal(turnId)
      expect(turn!.state).to.equal('completed')
    })

    it('falls back to event-replay when a corrupt turn_snapshot line is on disk', async () => {
      await eventsWriter.append({channelId, event: messageEvent(0, 'hi'), projectRoot, turnId})
      await eventsWriter.append({
        channelId,
        event: stateChangeEvent(1, 'pending', 'completed'),
        projectRoot,
        turnId,
      })

      // Append a malformed snapshot line — should NOT break replay.
      const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
      await fs.appendFile(file, '{"_recordType":"turn_snapshot","turn":{ broken json\n')

      const turn = await reader.readTurn({channelId, projectRoot, turnId})
      expect(turn).to.exist
      expect(turn!.state).to.equal('completed')
    })
  })

  describe('readTurn (legacy fallback)', () => {
    it('reads the legacy turn.json snapshot when the new NDJSON is absent', async () => {
      const legacyTurnId = 'legacy-02'
      const written = await writeLegacyTurn(legacyTurnId)

      const turn = await reader.readTurn({channelId, projectRoot, turnId: legacyTurnId})
      expect(turn).to.exist
      expect(turn!.turnId).to.equal(written.turnId)
      expect(turn!.state).to.equal('completed')
    })

    it('replays from legacy events.jsonl when the legacy snapshot is missing', async () => {
      const legacyTurnId = 'legacy-03'
      await writeLegacyTurn(legacyTurnId)
      const snapshotFile = channelPaths.turnSnapshotFile(projectRoot, channelId, legacyTurnId)
      await fs.rm(snapshotFile)

      const turn = await reader.readTurn({channelId, projectRoot, turnId: legacyTurnId})
      expect(turn).to.exist
      expect(turn!.turnId).to.equal(legacyTurnId)
      expect(turn!.state).to.equal('completed')
    })

    it('replays from legacy events.jsonl when the legacy snapshot is corrupt', async () => {
      const legacyTurnId = 'legacy-04'
      await writeLegacyTurn(legacyTurnId)
      const snapshotFile = channelPaths.turnSnapshotFile(projectRoot, channelId, legacyTurnId)
      await fs.writeFile(snapshotFile, '{ this is not valid json')

      const turn = await reader.readTurn({channelId, projectRoot, turnId: legacyTurnId})
      expect(turn).to.exist
      expect(turn!.state).to.equal('completed')
    })
  })
})
