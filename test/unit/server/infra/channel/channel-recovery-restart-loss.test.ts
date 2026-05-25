import {expect} from 'chai'

import type {IChannelBroadcaster} from '../../../../../src/server/core/interfaces/channel/i-channel-broadcaster.js'
import type {ChannelStoreReadTurnResult, IChannelStore} from '../../../../../src/server/core/interfaces/channel/i-channel-store.js'
import type {ITurnSequenceAllocator} from '../../../../../src/server/core/interfaces/channel/i-turn-sequence-allocator.js'
import type {BrokerPersistedRecord, IBrokerPersistence, TrackRecord} from '../../../../../src/server/infra/channel/drivers/broker-persistence.js'
import type {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import type {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import type {Turn, TurnDelivery, TurnEvent} from '../../../../../src/shared/types/channel.js'

import {runChannelRecovery} from '../../../../../src/server/infra/channel/channel-recovery.js'

// Slice 8.10 — `runChannelRecovery()` must now return `restartLosses[]` so the
// orchestrator's orphan registry can seed itself and `permissionDecision()`
// can surface `CHANNEL_PERMISSION_LOST_ON_RESTART` instead of the misleading
// `CHANNEL_TURN_NOT_FOUND`. V3 super-mario reproducer (2026-05-16).
// Codex Q1 idempotency guard: re-running recovery on a delivery that already
// has a restart-loss errored event on disk must NOT write a second event,
// but MUST still emit the record so the in-memory registry is seeded.

const CHANNEL_ID = 'pubsub-review'
const TURN_ID = 'turn-restart'
const PROJECT_ROOT = '/tmp/project'

const trackRecord = (overrides: Partial<TrackRecord> = {}): TrackRecord => ({
  channelId: CHANNEL_ID,
  deliveryId: 'del-1',
  memberHandle: '@codex',
  permissionRequestId: 'perm-1',
  projectRoot: PROJECT_ROOT,
  turnId: TURN_ID,
  type: 'track',
  ...overrides,
})

const turnEvent = (overrides: Partial<TurnEvent> & {kind: TurnEvent['kind']; seq: number}): TurnEvent => {
  const base = {
    channelId: CHANNEL_ID,
    deliveryId: 'del-1' as null | string,
    emittedAt: '2026-05-16T10:00:00.000Z',
    memberHandle: '@codex' as null | string,
    turnId: TURN_ID,
  }
  switch (overrides.kind) {
    case 'delivery_state_change': {
      return {...base, ...overrides, from: 'streaming', to: 'awaiting_permission'} as TurnEvent
    }

    case 'turn_state_change': {
      return {...base, ...overrides, deliveryId: null, from: 'pending', memberHandle: null, to: 'dispatched'} as TurnEvent
    }

    default: {
      return {...base, ...overrides} as TurnEvent
    }
  }
}

const fakeBroadcaster = (): IChannelBroadcaster => ({
  broadcastToChannel() {},
}) as unknown as IChannelBroadcaster

const fakeSeqAllocator = (start: number): ITurnSequenceAllocator => {
  let n = start
  return {
    next() {
      n += 1
      return n
    },
    reset() {},
    seed() {},
  } as unknown as ITurnSequenceAllocator
}

const fakeEventsWriter = (): ChannelEventsWriter => ({
  seedLastSeq() {},
}) as unknown as ChannelEventsWriter

const fakeTreeReader = (events: TurnEvent[]): ChannelTreeReader => ({
  readEvents: async () => events,
}) as unknown as ChannelTreeReader

type AppendedEvent = {channelId: string; event: TurnEvent; projectRoot: string; turnId: string}

const fakeStore = (turn: Turn, deliveries: TurnDelivery[]): {appended: AppendedEvent[]; store: IChannelStore} => {
  const appended: AppendedEvent[] = []
  // Mutate deliveries[*].state to mirror the orchestrator's replay semantics.
  // For Slice 8.10 we only need the deliveries' final states to be
  // observable so the post-recovery turn-finalisation path runs.
  const liveDeliveries = deliveries.map((d) => ({...d}))
  const store = {
    async appendTurnEvent(args: AppendedEvent) {
      appended.push(args)
      // Mirror the in-memory state update so readDeliveries reflects the
      // just-emitted event.
      if (args.event.kind === 'delivery_state_change') {
        const e = args.event as TurnEvent & {kind: 'delivery_state_change'; to: TurnDelivery['state']}
        const d = liveDeliveries.find((x) => x.deliveryId === e.deliveryId)
        if (d !== undefined) d.state = e.to
      }
    },
    readDeliveries: async () => liveDeliveries,
    readTurn: async (): Promise<ChannelStoreReadTurnResult | undefined> => ({deliveries: liveDeliveries, events: [], turn} as unknown as ChannelStoreReadTurnResult),
    async writeDeliverySnapshot() {},
    async writeTurnSnapshot() {},
  } as unknown as IChannelStore
  return {appended, store}
}

const fakeBrokerPersistence = (records: BrokerPersistedRecord[]): {persistence: IBrokerPersistence; truncated: {value: boolean}} => {
  const truncated = {value: false}
  const persistence = {
    async appendResolve() {},
    async appendTrack() {},
    readAll: async () => records,
    async truncate() {
      truncated.value = true
    },
  } as unknown as IBrokerPersistence
  return {persistence, truncated}
}

const baseTurn: Turn = {
  author: {kind: 'local-user', userHandle: '@you'} as unknown as Turn['author'],
  channelId: CHANNEL_ID,
  idempotencyKey: undefined,
  mentions: ['@codex'],
  promptBlocks: [{kind: 'text', text: 'hi'}] as unknown as Turn['promptBlocks'],
  promptedBy: 'user',
  startedAt: '2026-05-16T09:59:00.000Z',
  state: 'dispatched',
  turnId: TURN_ID,
}

const baseDelivery: TurnDelivery = {
  artifactsTouched: [],
  channelId: CHANNEL_ID,
  deliveryId: 'del-1',
  memberHandle: '@codex',
  startedAt: '2026-05-16T09:59:00.000Z',
  state: 'awaiting_permission',
  toolCallCount: 0,
  turnId: TURN_ID,
}

describe('runChannelRecovery — Slice 8.10 restart-loss records', () => {
  it('returns restartLosses[] populated with one record per orphaned permission', async () => {
    const eventsOnDisk: TurnEvent[] = [
      turnEvent({kind: 'turn_state_change', seq: 1}),
      turnEvent({deliveryId: 'del-1', kind: 'delivery_state_change', seq: 2}),
    ]
    const {persistence} = fakeBrokerPersistence([trackRecord()])
    const {appended, store} = fakeStore(baseTurn, [baseDelivery])

    const result = await runChannelRecovery({
      broadcaster: fakeBroadcaster(),
      brokerPersistence: persistence,
      clock: () => new Date('2026-05-16T10:00:00.000Z'),
      eventsWriter: fakeEventsWriter(),
      seqAllocator: fakeSeqAllocator(2),
      store,
      treeReader: fakeTreeReader(eventsOnDisk),
    })

    expect(result.recoveredDeliveries).to.equal(1)
    expect(result.restartLosses).to.have.length(1)
    expect(result.restartLosses[0]).to.deep.equal({
      channelId: CHANNEL_ID,
      erroredSeq: 3, // next seq after the disk's last seq=2
      permissionRequestId: 'perm-1',
      turnId: TURN_ID,
    })
    // The errored event was actually written.
    const erroredAppends = appended.filter((a) => a.event.kind === 'delivery_state_change' && a.event.to === 'errored')
    expect(erroredAppends).to.have.length(1)
  })

  it('emits one restart-loss record per (deliveryId, permissionRequestId) pair on the same turn (codex Q6: per-permission keying)', async () => {
    const eventsOnDisk: TurnEvent[] = [
      turnEvent({kind: 'turn_state_change', seq: 1}),
      turnEvent({deliveryId: 'del-1', kind: 'delivery_state_change', seq: 2}),
      turnEvent({deliveryId: 'del-2', kind: 'delivery_state_change', seq: 3}),
    ]
    const records: BrokerPersistedRecord[] = [
      trackRecord({deliveryId: 'del-1', memberHandle: '@codex', permissionRequestId: 'perm-1'}),
      trackRecord({deliveryId: 'del-2', memberHandle: '@kimi', permissionRequestId: 'perm-2'}),
    ]
    const deliveries: TurnDelivery[] = [
      {...baseDelivery, deliveryId: 'del-1', memberHandle: '@codex'},
      {...baseDelivery, deliveryId: 'del-2', memberHandle: '@kimi'},
    ]
    const {persistence} = fakeBrokerPersistence(records)
    const {store} = fakeStore(baseTurn, deliveries)

    const result = await runChannelRecovery({
      broadcaster: fakeBroadcaster(),
      brokerPersistence: persistence,
      clock: () => new Date('2026-05-16T10:00:00.000Z'),
      eventsWriter: fakeEventsWriter(),
      seqAllocator: fakeSeqAllocator(3),
      store,
      treeReader: fakeTreeReader(eventsOnDisk),
    })

    expect(result.restartLosses).to.have.length(2)
    const byPerm = new Map(result.restartLosses.map((r) => [r.permissionRequestId, r]))
    expect(byPerm.get('perm-1')?.erroredSeq).to.equal(4)
    expect(byPerm.get('perm-2')?.erroredSeq).to.equal(5)
  })

  it('idempotency guard: when an `errored` event with the restart-loss reason already exists, do NOT write a duplicate but DO emit the record from the existing seq (codex Q1)', async () => {
    // Disk already has the restart-loss errored event from a prior recovery
    // that crashed before truncating pending-permissions.jsonl.
    const eventsOnDisk: TurnEvent[] = [
      turnEvent({kind: 'turn_state_change', seq: 1}),
      turnEvent({deliveryId: 'del-1', kind: 'delivery_state_change', seq: 2}),
      // Pre-existing restart-loss errored event:
      {
        channelId: CHANNEL_ID,
        deliveryId: 'del-1',
        emittedAt: '2026-05-16T09:59:30.000Z',
        error: 'permission state lost on daemon restart',
        from: 'awaiting_permission',
        kind: 'delivery_state_change',
        memberHandle: '@codex',
        seq: 3,
        to: 'errored',
        turnId: TURN_ID,
      } as TurnEvent,
    ]
    const {persistence} = fakeBrokerPersistence([trackRecord()])
    const {appended, store} = fakeStore(baseTurn, [{...baseDelivery, state: 'errored'}])

    const result = await runChannelRecovery({
      broadcaster: fakeBroadcaster(),
      brokerPersistence: persistence,
      clock: () => new Date('2026-05-16T10:00:00.000Z'),
      eventsWriter: fakeEventsWriter(),
      seqAllocator: fakeSeqAllocator(3),
      store,
      treeReader: fakeTreeReader(eventsOnDisk),
    })

    // The errored event already exists — no duplicate write for this delivery.
    const erroredAppends = appended.filter(
      (a) =>
        a.event.kind === 'delivery_state_change' &&
        (a.event as TurnEvent & {to: string}).to === 'errored' &&
        a.event.deliveryId === 'del-1',
    )
    expect(erroredAppends, 'no duplicate errored event should be written').to.have.length(0)
    // BUT the restart-loss record is still emitted, carrying the EXISTING event's seq.
    expect(result.restartLosses).to.have.length(1)
    expect(result.restartLosses[0]).to.deep.include({
      channelId: CHANNEL_ID,
      erroredSeq: 3, // pre-existing event's seq, not a fresh allocation
      permissionRequestId: 'perm-1',
      turnId: TURN_ID,
    })
  })

  it('returns empty restartLosses[] when there are no live pending permissions', async () => {
    const {persistence} = fakeBrokerPersistence([])
    const {store} = fakeStore(baseTurn, [baseDelivery])

    const result = await runChannelRecovery({
      broadcaster: fakeBroadcaster(),
      brokerPersistence: persistence,
      clock: () => new Date('2026-05-16T10:00:00.000Z'),
      eventsWriter: fakeEventsWriter(),
      seqAllocator: fakeSeqAllocator(0),
      store,
      treeReader: fakeTreeReader([]),
    })

    expect(result.restartLosses).to.deep.equal([])
  })
})
