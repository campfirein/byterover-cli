import {expect} from 'chai'

import type {ChannelMeta, Turn, TurnDelivery, TurnEvent} from '../../../../../src/shared/types/channel.js'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {channelPaths} from '../../../../../src/server/infra/channel/storage/paths.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Slice 2.0 — delivery + message snapshot writers exposed via IChannelStore,
// readDeliveries with replay-fallback, and in-flight listTurns / readTurn
// visibility for active (non-terminal) turns.
//
// Phase 1 wrote turn snapshots only at terminal state; Phase 2 keeps that
// rule for snapshots but the reader paths must now also surface in-flight
// turns reconstructed from `events.jsonl`. Per CHANNEL_PROTOCOL.md §4.2 and
// IMPLEMENTATION_PHASE_2.md §Slice 2.0 §4-§5.
describe('ChannelStore delivery + in-flight extensions (Slice 2.0)', () => {
  let projectRoot: string
  let store: ChannelStore
  let eventsWriter: ChannelEventsWriter
  const channelId = 'pi-test'
  const turnId = '01HX'
  const deliveryId = 'd1'

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    const serializer = new ChannelWriteSerializer()
    eventsWriter = new ChannelEventsWriter({serializer})
    store = new ChannelStore({
      eventsWriter,
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  const baseMeta = (): ChannelMeta => ({
    channelId,
    createdAt: '2026-05-11T00:00:00.000Z',
    members: [],
    updatedAt: '2026-05-11T00:00:00.000Z',
  })

  const baseDelivery: TurnDelivery = {
    artifactsTouched: [],
    channelId,
    deliveryId,
    memberHandle: '@mock',
    startedAt: '2026-05-11T00:00:01.000Z',
    state: 'completed',
    toolCallCount: 0,
    turnId,
  }

  const baseTurn: Turn = {
    author: {handle: 'you', kind: 'local-user'},
    channelId,
    mentions: ['@mock'],
    promptBlocks: [{text: '@mock hello', type: 'text'}],
    promptedBy: 'user',
    startedAt: '2026-05-11T00:00:00.000Z',
    state: 'dispatched',
    turnId,
  }

  const deliveryStateChange = (
    seq: number,
    from: TurnDelivery['state'],
    to: TurnDelivery['state'],
  ): TurnEvent =>
    ({
      channelId,
      deliveryId,
      emittedAt: `2026-05-11T00:00:0${seq}.000Z`,
      from,
      kind: 'delivery_state_change',
      memberHandle: '@mock',
      seq,
      to,
      turnId,
    } as TurnEvent)

  const turnStateChange = (
    seq: number,
    from: Turn['state'],
    to: Turn['state'],
  ): TurnEvent =>
    ({
      channelId,
      deliveryId: null,
      emittedAt: `2026-05-11T00:00:0${seq}.000Z`,
      from,
      kind: 'turn_state_change',
      memberHandle: null,
      seq,
      to,
      turnId,
    } as TurnEvent)

  describe('writeDeliverySnapshot', () => {
    it('persists a delivery snapshot file readable by readDeliveries', async () => {
      await store.createChannel({meta: baseMeta(), projectRoot})
      await store.writeDeliverySnapshot({
        channelId,
        delivery: baseDelivery,
        deliveryId,
        projectRoot,
        turnId,
      })

      const deliveries = await store.readDeliveries({channelId, projectRoot, turnId})
      expect(deliveries).to.have.lengthOf(1)
      expect(deliveries[0].deliveryId).to.equal(deliveryId)
      expect(deliveries[0].state).to.equal('completed')
    })
  })

  describe('writeMessage', () => {
    it('persists the per-delivery markdown body as a structural NDJSON line (Slice 9.1)', async () => {
      const {promises: fs} = await import('node:fs')

      await store.createChannel({meta: baseMeta(), projectRoot})
      await store.writeMessage({
        body: '# agent reply\n\nhello back',
        channelId,
        deliveryId,
        projectRoot,
        turnId,
      })

      // Slice 9.1: bodies now land as a `_recordType: 'message'` line in the
      // per-turn NDJSON (single mount, single file). The legacy
      // `messages/<id>.md` file is no longer written.
      const ndjsonPath = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
      const raw = await fs.readFile(ndjsonPath, 'utf8')
      const lines = raw
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as {_recordType?: string; body?: string; deliveryId?: string})
      const messageLine = lines.find((l) => l._recordType === 'message' && l.deliveryId === deliveryId)
      expect(messageLine, 'expected a message structural line').to.not.equal(undefined)
      expect(messageLine!.body).to.equal('# agent reply\n\nhello back')
    })
  })

  describe('readDeliveries with replay fallback', () => {
    it('reconstructs deliveries from events.jsonl when no snapshot files exist', async () => {
      await store.createChannel({meta: baseMeta(), projectRoot})
      await eventsWriter.append({channelId, event: deliveryStateChange(1, 'queued', 'dispatched'), projectRoot, turnId})
      await eventsWriter.append({channelId, event: deliveryStateChange(2, 'dispatched', 'streaming'), projectRoot, turnId})
      await eventsWriter.append({channelId, event: deliveryStateChange(3, 'streaming', 'completed'), projectRoot, turnId})

      const deliveries = await store.readDeliveries({channelId, projectRoot, turnId})
      expect(deliveries).to.have.lengthOf(1)
      expect(deliveries[0].deliveryId).to.equal(deliveryId)
      // Latest-observed state wins.
      expect(deliveries[0].state).to.equal('completed')
    })

    it('returns empty array when no events and no snapshots exist for the turn', async () => {
      await store.createChannel({meta: baseMeta(), projectRoot})
      const deliveries = await store.readDeliveries({channelId, projectRoot, turnId})
      expect(deliveries).to.deep.equal([])
    })
  })

  describe('listTurns in-flight visibility', () => {
    it('surfaces dispatched turns from events.jsonl even before turn.json exists', async () => {
      await store.createChannel({meta: baseMeta(), projectRoot})
      // Only events.jsonl exists; no terminal snapshot.
      await eventsWriter.append({channelId, event: turnStateChange(0, 'pending', 'dispatched'), projectRoot, turnId})

      const {turns} = await store.listTurns({channelId, projectRoot})
      expect(turns).to.have.lengthOf(1)
      expect(turns[0].turnId).to.equal(turnId)
      expect(turns[0].state).to.equal('dispatched')
      expect(turns[0].endedAt).to.equal(undefined)
    })
  })

  describe('readTurn includes deliveries for active turns', () => {
    it('returns deliveries[] alongside turn + events when delivery events exist', async () => {
      await store.createChannel({meta: baseMeta(), projectRoot})
      await eventsWriter.append({channelId, event: turnStateChange(0, 'pending', 'dispatched'), projectRoot, turnId})
      await eventsWriter.append({channelId, event: deliveryStateChange(1, 'queued', 'dispatched'), projectRoot, turnId})

      const result = await store.readTurn({channelId, projectRoot, turnId})
      expect(result).to.not.equal(undefined)
      expect(result?.deliveries).to.have.lengthOf(1)
      expect(result?.deliveries?.[0].deliveryId).to.equal(deliveryId)
      expect(result?.deliveries?.[0].state).to.equal('dispatched')
    })

    it('omits deliveries on a passive turn with no delivery events', async () => {
      await store.createChannel({meta: baseMeta(), projectRoot})
      await store.writeTurnSnapshot({channelId, projectRoot, turn: {...baseTurn, state: 'completed'}, turnId})

      const result = await store.readTurn({channelId, projectRoot, turnId})
      expect(result).to.not.equal(undefined)
      // Either absent or empty — both are acceptable per the IMPLEMENTATION_PHASE_2.md §Slice 2.0 §5 spec.
      expect(result?.deliveries === undefined || result?.deliveries.length === 0).to.equal(true)
    })
  })
})
