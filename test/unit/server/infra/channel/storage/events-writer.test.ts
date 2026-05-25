import {expect} from 'chai'
import {promises as fs} from 'node:fs'

import type {TurnEvent} from '../../../../../../src/shared/types/channel.js'

import {ChannelEventsWriter} from '../../../../../../src/server/infra/channel/storage/events-writer.js'
import {channelPaths} from '../../../../../../src/server/infra/channel/storage/paths.js'
import {ChannelWriteSerializer} from '../../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../../helpers/temp-dir.js'

// Slice 1.3 — append-only events.jsonl writer with monotonic per-turn seq.
// Implements the "source of truth" half of CHANNEL_PROTOCOL.md §4.2.
describe('ChannelEventsWriter', () => {
  let projectRoot: string
  let writer: ChannelEventsWriter
  const channelId = 'pi-test'
  const turnId = '01HX'

  const makeEvent = (overrides: Partial<TurnEvent> = {}): TurnEvent =>
    ({
      channelId,
      deliveryId: null,
      emittedAt: '2026-05-11T00:00:00.000Z',
      from: 'pending',
      kind: 'turn_state_change',
      memberHandle: null,
      seq: 0,
      to: 'completed',
      turnId,
      ...overrides,
    } as TurnEvent)

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    writer = new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('creates the per-turn NDJSON on first append and ensures the parent directory', async () => {
    // Slice 9.1: writes go to .brv/channel-history/<ch>/turns/<turn>.ndjson
    // (NOT the legacy .brv/context-tree/channel/<ch>/turns/<turn>/events.jsonl).
    await writer.append({channelId, event: makeEvent(), projectRoot, turnId})
    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const contents = await fs.readFile(file, 'utf8')
    expect(contents.trim().split('\n')).to.have.lengthOf(1)
  })

  it('does NOT write to the legacy events.jsonl location (Slice 9.1)', async () => {
    await writer.append({channelId, event: makeEvent(), projectRoot, turnId})
    const legacyFile = channelPaths.eventsFile(projectRoot, channelId, turnId)
    let legacyExists = true
    try {
      await fs.stat(legacyFile)
    } catch {
      legacyExists = false
    }

    expect(legacyExists, 'legacy events.jsonl must not be created').to.equal(false)
  })

  it('appends multiple events as newline-delimited JSON', async () => {
    await writer.append({channelId, event: makeEvent({seq: 0}), projectRoot, turnId})
    await writer.append({channelId, event: makeEvent({seq: 1}), projectRoot, turnId})
    await writer.append({channelId, event: makeEvent({seq: 2}), projectRoot, turnId})

    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    expect(lines).to.have.lengthOf(3)
    for (const line of lines) {
      expect(() => JSON.parse(line)).to.not.throw()
    }
  })

  it('rejects non-monotonic seq (writer enforces ordering)', async () => {
    await writer.append({channelId, event: makeEvent({seq: 0}), projectRoot, turnId})
    await writer.append({channelId, event: makeEvent({seq: 1}), projectRoot, turnId})

    let threw: unknown
    try {
      await writer.append({channelId, event: makeEvent({seq: 0}), projectRoot, turnId})
    } catch (error) {
      threw = error
    }

    expect(threw).to.be.an.instanceOf(Error)
    expect((threw as Error).message).to.match(/seq/i)
  })

  it('serialises concurrent appends to the same turn via the write lock', async () => {
    const N = 10
    const promises = Array.from({length: N}, (_, i) =>
      writer.append({channelId, event: makeEvent({seq: i}), projectRoot, turnId}),
    )
    await Promise.all(promises)

    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const lines = (await fs.readFile(file, 'utf8')).trim().split('\n')
    expect(lines).to.have.lengthOf(N)

    const seqs = lines.map((l) => (JSON.parse(l) as TurnEvent).seq)
    expect(seqs).to.deep.equal(Array.from({length: N}, (_, i) => i))
  })

  it('writes JSON without embedded newlines (one event per line)', async () => {
    const eventWithContent = makeEvent({
      content: 'line one\nline two', // newline inside the payload
      // these fields are dropped by zod-style narrowing but the writer must
      // not split the event across two physical lines.
      from: undefined as unknown as 'pending',
      kind: 'message',
      role: 'user',
      to: undefined as unknown as 'completed',
    } as Partial<TurnEvent>)

    await writer.append({channelId, event: eventWithContent, projectRoot, turnId})

    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const raw = await fs.readFile(file, 'utf8')
    // Exactly one trailing newline, no internal raw newline breaking the JSON.
    expect(raw.endsWith('\n')).to.equal(true)
    expect(raw.match(/\n/g)?.length).to.equal(1)
  })

  it('does not require a directory to exist beforehand', async () => {
    const fresh = '01HY-new'
    await writer.append({channelId, event: makeEvent({turnId: fresh}), projectRoot, turnId: fresh})
    // Slice 9.1: the parent dir for the per-turn NDJSON is the channel
    // history turns/ dir, created lazily by the writer.
    const stat = await fs.stat(channelPaths.historyTurnsDir(projectRoot, channelId))
    expect(stat.isDirectory()).to.equal(true)
  })

  // Slice 9.2 — held-open per-turn write stream eliminates the
  // per-event open()+close() syscalls that made `events.jsonl` writes
  // the per-streaming-chunk hot path. Many appends to the same turn
  // should reuse a single underlying `fs.createWriteStream`; appends
  // to different turns each get their own. Both reviewers (codex + kimi
  // Q8) flagged that the mount move alone is cosmetic without this fix.
  describe('Slice 9.2 — held-open per-turn write stream', () => {
    it('opens the per-turn stream exactly ONCE across many appends to the same turn', async () => {
      const N = 50
      for (let i = 0; i < N; i++) {
        // eslint-disable-next-line no-await-in-loop
        await writer.append({channelId, event: makeEvent({seq: i}), projectRoot, turnId})
      }

      expect(writer.openStreamCount(), `expected 1 open stream for 1 turn, got ${writer.openStreamCount()}`).to.equal(1)

      const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
      const raw = await fs.readFile(file, 'utf8')
      const lines = raw.split('\n').filter((l) => l.length > 0)
      expect(lines).to.have.lengthOf(N)
    })

    it('opens one stream per distinct (channelId, turnId) pair', async () => {
      const turns = ['01HX-a', '01HX-b', '01HX-c']
      for (const t of turns) {
        // eslint-disable-next-line no-await-in-loop
        await writer.append({channelId, event: makeEvent({seq: 0, turnId: t}), projectRoot, turnId: t})
      }

      expect(writer.openStreamCount()).to.equal(3)
    })

    it('closeStreamForTurn drains and removes the stream', async () => {
      await writer.append({channelId, event: makeEvent({seq: 0}), projectRoot, turnId})
      expect(writer.openStreamCount()).to.equal(1)

      await writer.closeStreamForTurn({channelId, turnId})

      expect(writer.openStreamCount()).to.equal(0)

      // The closed stream's bytes must still be visible on disk.
      const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
      const raw = await fs.readFile(file, 'utf8')
      expect(raw.split('\n').filter((l) => l.length > 0)).to.have.lengthOf(1)
    })

    it('closeStreamForTurn is a no-op when no stream is open', async () => {
      let threw: unknown
      try {
        await writer.closeStreamForTurn({channelId, turnId: 'never-opened'})
      } catch (error) {
        threw = error
      }

      expect(threw).to.equal(undefined)
      expect(writer.openStreamCount()).to.equal(0)
    })

    it('closeAll() drains every open stream and clears the map (graceful shutdown)', async () => {
      const turns = ['01HX-a', '01HX-b', '01HX-c']
      for (const t of turns) {
        // eslint-disable-next-line no-await-in-loop
        await writer.append({channelId, event: makeEvent({seq: 0, turnId: t}), projectRoot, turnId: t})
      }

      expect(writer.openStreamCount()).to.equal(3)
      await writer.closeAll()
      expect(writer.openStreamCount()).to.equal(0)

      // All three files persisted intact.
      for (const t of turns) {
        // eslint-disable-next-line no-await-in-loop
        const raw = await fs.readFile(channelPaths.turnNdjsonFile(projectRoot, channelId, t), 'utf8')
        expect(raw.split('\n').filter((l) => l.length > 0)).to.have.lengthOf(1)
      }
    })

    it('appendRawLine bypasses the seq monotonicity check (used by snapshot-writer)', async () => {
      // Slice 9.2: snapshot-writer writes structural lines through the
      // events-writer's held stream via appendRawLine, so both writers
      // share the same per-turn lock and stream lifecycle. Structural
      // lines carry no `seq`, so appendRawLine MUST NOT consult or
      // update the lastSeq map.
      await writer.append({channelId, event: makeEvent({seq: 5}), projectRoot, turnId})
      await writer.appendRawLine({
        channelId,
        line: JSON.stringify({_recordType: 'turn_snapshot', turn: {turnId}}),
        projectRoot,
        turnId,
      })

      // Subsequent wire-event append must still see lastSeq=5 (snapshot
      // line had no seq, so the cursor didn't move).
      await writer.append({channelId, event: makeEvent({seq: 6}), projectRoot, turnId})

      const raw = await fs.readFile(channelPaths.turnNdjsonFile(projectRoot, channelId, turnId), 'utf8')
      const lines = raw.split('\n').filter((l) => l.length > 0)
      expect(lines).to.have.lengthOf(3)

      // Order: event seq=5, structural snapshot, event seq=6.
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>)
      expect(parsed[0].seq).to.equal(5)
      expect(parsed[1]._recordType).to.equal('turn_snapshot')
      expect(parsed[2].seq).to.equal(6)
    })

    it('appendRawLine reuses the same held stream (no extra open)', async () => {
      await writer.append({channelId, event: makeEvent({seq: 0}), projectRoot, turnId})
      const before = writer.openStreamCount()
      await writer.appendRawLine({
        channelId,
        line: JSON.stringify({_recordType: 'turn_snapshot', turn: {turnId}}),
        projectRoot,
        turnId,
      })

      expect(writer.openStreamCount()).to.equal(before)
      expect(before).to.equal(1)
    })
  })
})
