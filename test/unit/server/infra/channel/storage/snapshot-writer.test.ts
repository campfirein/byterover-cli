import {expect} from 'chai'
import {promises as fs} from 'node:fs'

import type {Turn} from '../../../../../../src/shared/types/channel.js'

import {ChannelEventsWriter} from '../../../../../../src/server/infra/channel/storage/events-writer.js'
import {channelPaths} from '../../../../../../src/server/infra/channel/storage/paths.js'
import {ChannelSnapshotWriter} from '../../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelWriteSerializer} from '../../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../../helpers/temp-dir.js'

// Slice 9.1 — at terminal state the snapshot writer appends NDJSON lines
// tagged with a `_recordType` envelope to the same per-turn file the
// events writer is appending to. The three previously-separate files
// (turn.json, deliveries/<id>.json, messages/<id>.md) collapse into
// one append-only NDJSON. The `_recordType` field is a separate
// top-level key (NOT overloaded on the wire-event `kind` field) so
// replay scanners can filter structural lines cleanly. Both codex and
// kimi independently flagged the envelope-key collision risk in the
// Phase 9 design review.
describe('ChannelSnapshotWriter (Slice 9.1 — NDJSON envelope)', () => {
  let projectRoot: string
  let writer: ChannelSnapshotWriter
  let eventsWriter: ChannelEventsWriter
  const channelId = 'pi-test'
  const turnId = '01HX'

  const sampleTurn = (): Turn => ({
    author: {handle: 'you', kind: 'local-user'},
    channelId,
    endedAt: '2026-05-11T00:00:01.000Z',
    mentions: [],
    promptBlocks: [{text: 'hi', type: 'text'}],
    promptedBy: 'user',
    startedAt: '2026-05-11T00:00:00.000Z',
    state: 'completed',
    turnId,
  })

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    // Slice 9.2: snapshot-writer routes structural lines through the
    // events-writer's held per-turn stream + per-turn lock.
    eventsWriter = new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})
    writer = new ChannelSnapshotWriter({eventsWriter})
  })

  afterEach(async () => {
    await eventsWriter.closeAll()
    await removeTempDir(projectRoot)
  })

  const readNdjsonLines = async (): Promise<unknown[]> => {
    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const raw = await fs.readFile(file, 'utf8')
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as unknown)
  }

  it('appends a turn_snapshot NDJSON line with the persisted Turn record', async () => {
    await writer.writeTurnSnapshot({channelId, projectRoot, turn: sampleTurn(), turnId})
    const lines = await readNdjsonLines()
    expect(lines).to.have.lengthOf(1)
    const [line] = lines as Array<{_recordType?: string; turn?: Turn}>
    expect(line._recordType).to.equal('turn_snapshot')
    expect(line.turn?.turnId).to.equal(turnId)
    expect(line.turn?.state).to.equal('completed')
  })

  it('tags structural lines via a separate _recordType key (NOT by overloading `kind`)', async () => {
    // Regression guard against the codex+kimi collision risk: replay
    // scanners filter by `_recordType !== undefined`. If structural lines
    // hijacked the wire-event `kind` field, subscribers would emit them
    // as fake events and break `--after-seq` seq monotonicity.
    await writer.writeTurnSnapshot({channelId, projectRoot, turn: sampleTurn(), turnId})
    const [line] = (await readNdjsonLines()) as Array<Record<string, unknown>>
    expect(line._recordType).to.equal('turn_snapshot')
    expect(line.kind).to.equal(undefined)
  })

  it('does NOT write a legacy turn.json file (Slice 9.1)', async () => {
    await writer.writeTurnSnapshot({channelId, projectRoot, turn: sampleTurn(), turnId})
    const legacy = channelPaths.turnSnapshotFile(projectRoot, channelId, turnId)
    let legacyExists = true
    try {
      await fs.stat(legacy)
    } catch {
      legacyExists = false
    }

    expect(legacyExists, 'legacy turn.json must not be created').to.equal(false)
  })

  it('appends a delivery_snapshot NDJSON line tagged via _recordType', async () => {
    const deliveryId = 'd-mock-1'
    const delivery = {
      artifactsTouched: [],
      channelId,
      deliveryId,
      endedAt: '2026-05-11T00:00:01.000Z',
      memberHandle: '@mock',
      startedAt: '2026-05-11T00:00:00.000Z',
      state: 'completed' as const,
      toolCallCount: 0,
      turnId,
    }
    await writer.writeDeliverySnapshot({channelId, delivery, deliveryId, projectRoot, turnId})

    const lines = (await readNdjsonLines()) as Array<{
      _recordType?: string
      delivery?: typeof delivery
      deliveryId?: string
    }>
    expect(lines).to.have.lengthOf(1)
    expect(lines[0]._recordType).to.equal('delivery_snapshot')
    expect(lines[0].deliveryId).to.equal(deliveryId)
    expect(lines[0].delivery?.state).to.equal('completed')
  })

  it('appends a message NDJSON line tagged via _recordType', async () => {
    const deliveryId = 'd-mock-1'
    await writer.writeMessage({
      body: '# Final reply\nHello from the mock agent.',
      channelId,
      deliveryId,
      projectRoot,
      turnId,
    })

    const lines = (await readNdjsonLines()) as Array<{
      _recordType?: string
      body?: string
      deliveryId?: string
    }>
    expect(lines).to.have.lengthOf(1)
    expect(lines[0]._recordType).to.equal('message')
    expect(lines[0].deliveryId).to.equal(deliveryId)
    expect(lines[0].body).to.include('Hello from the mock agent.')
  })

  it('preserves embedded newlines in messages without splitting the NDJSON line', async () => {
    const deliveryId = 'd-mock-1'
    await writer.writeMessage({
      body: 'line one\nline two\nline three',
      channelId,
      deliveryId,
      projectRoot,
      turnId,
    })

    // Exactly one physical line (the appended message), regardless of how
    // many '\n' the body contained.
    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const raw = await fs.readFile(file, 'utf8')
    const physicalLines = raw.split('\n').filter((l) => l.length > 0)
    expect(physicalLines).to.have.lengthOf(1)
  })

  it('creates the parent directory lazily on first append', async () => {
    const fresh = '01HY-new'
    await writer.writeTurnSnapshot({
      channelId,
      projectRoot,
      turn: {...sampleTurn(), turnId: fresh},
      turnId: fresh,
    })
    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, fresh)
    expect((await fs.stat(file)).isFile()).to.equal(true)
  })

  it('serialises concurrent appends to the same turn via the shared write lock', async () => {
    // Slice 9.1: snapshot-writer + events-writer share the same per-turn
    // lock, otherwise fan-out concurrent terminal writes could produce
    // torn NDJSON lines. Construct three concurrent snapshot writes to
    // the same turn and verify the file contains three intact JSON lines.
    const deliveries = ['d-1', 'd-2', 'd-3']
    await Promise.all(
      deliveries.map((deliveryId) =>
        writer.writeDeliverySnapshot({
          channelId,
          delivery: {
            artifactsTouched: [],
            channelId,
            deliveryId,
            endedAt: '2026-05-11T00:00:01.000Z',
            memberHandle: '@mock',
            startedAt: '2026-05-11T00:00:00.000Z',
            state: 'completed' as const,
            toolCallCount: 0,
            turnId,
          },
          deliveryId,
          projectRoot,
          turnId,
        }),
      ),
    )

    const lines = (await readNdjsonLines()) as Array<{deliveryId?: string}>
    expect(lines).to.have.lengthOf(3)
    const seen = new Set(lines.map((l) => l.deliveryId))
    expect(seen).to.deep.equal(new Set(deliveries))
  })
})
