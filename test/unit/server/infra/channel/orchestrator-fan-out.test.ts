import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {ChannelMeta, TurnEvent} from '../../../../../src/shared/types/channel.js'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {AcpDriverPool} from '../../../../../src/server/infra/channel/drivers/acp-driver-pool.js'
import {CancelCoordinator} from '../../../../../src/server/infra/channel/drivers/cancel-coordinator.js'
import {MockAcpDriver} from '../../../../../src/server/infra/channel/drivers/mock-driver.js'
import {PermissionBroker} from '../../../../../src/server/infra/channel/drivers/permission-broker.js'
import {ChannelOrchestrator} from '../../../../../src/server/infra/channel/orchestrator.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {TurnSequenceAllocator} from '../../../../../src/server/infra/channel/storage/turn-sequence-allocator.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {ChannelEvents} from '../../../../../src/shared/transport/events/channel-events.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Slice 3.4 — unit-level fan-out coverage:
//   1. FIFO queueing: maxParallelAgents=1 + two mentions → second queues
//      behind first; queued → dispatched fires AFTER first reaches completed.
//   2. Cancel race: with maxParallelAgents=1, cancelling the turn while the
//      first delivery is still in-flight MUST NOT dispatch the queued
//      delivery. The cancel coordinator's loop is responsible for emitting
//      `queued → cancelled` for it.

describe('ChannelOrchestrator (Phase 3 fan-out)', () => {
  let projectRoot: string
  let store: ChannelStore
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  const channelId = 'pi-test'
  let mockDrivers: MockAcpDriver[]
  let driverIndex: number
  let sandbox: SinonSandbox
  let broadcasts: TurnEvent[]

  beforeEach(async () => {
    sandbox = createSandbox()
    projectRoot = await makeTempContextTree()
    const serializer = new ChannelWriteSerializer()
    store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
    pool = new AcpDriverPool()
    broker = new PermissionBroker()
    mockDrivers = []
    driverIndex = 0
    broadcasts = []

    let idCounter = 0
    const idGenerator = () => `id-${++idCounter}`

    const seqAllocator = new TurnSequenceAllocator()
    const broadcaster = {
      broadcastToChannel(_id: string, event: string, payload: unknown) {
        if (event === ChannelEvents.TURN_EVENT) {
          broadcasts.push((payload as {event: TurnEvent}).event)
        }
      },
    }
    const cancelCoordinator = new CancelCoordinator({
      broker,
      pool,
      seqAllocator,
      async writeEvent(event, ctx) {
        await store.appendTurnEvent({channelId: ctx.channelId, event, projectRoot: ctx.projectRoot, turnId: ctx.turnId})
        broadcaster.broadcastToChannel(ctx.channelId, ChannelEvents.TURN_EVENT, {channelId: ctx.channelId, event})
      },
    })

    orchestrator = new ChannelOrchestrator({
      broadcaster,
      cancelCoordinator,
      clock: () => new Date('2026-05-12T11:00:00.000Z'),
      driverFactory(_invocation, handle) {
        const driver = mockDrivers[driverIndex++] ?? new MockAcpDriver({events: [], handle})
        return driver
      },
      idGenerator,
      permissionBroker: broker,
      pool,
      seqAllocator,
      store,
    })
  })

  afterEach(async () => {
    sandbox.restore()
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  const seedChannel = async (members: Array<{handle: string}>, settings?: ChannelMeta['settings']): Promise<void> => {
    await store.createChannel({
      meta: {
        channelId,
        createdAt: '2026-05-12T11:00:00.000Z',
        members: members.map((m) => ({
          acpVersion: '1',
          agentName: m.handle,
          capabilities: [],
          driverClass: 'C-prime',
          handle: m.handle,
          invocation: {args: [], command: 'noop', cwd: '/tmp'},
          joinedAt: '2026-05-12T11:00:00.000Z',
          memberKind: 'acp-agent',
          status: 'idle',
        })),
        settings,
        updatedAt: '2026-05-12T11:00:00.000Z',
      },
      projectRoot,
    })
  }

  const inviteAll = async (handles: string[]): Promise<MockAcpDriver[]> => {
    const drivers: MockAcpDriver[] = []
    for (const handle of handles) {
      const driver = new MockAcpDriver({events: [], handle})
      mockDrivers.push(driver)
      // eslint-disable-next-line no-await-in-loop
      await driver.start()
      pool.register({channelId, driver})
      drivers.push(driver)
    }

    return drivers
  }

  it('maxParallelAgents=1: second delivery queues then dispatches AFTER the first completes', async () => {
    await seedChannel([{handle: '@a'}, {handle: '@b'}], {maxParallelAgents: 1})
    await inviteAll(['@a', '@b'])

    const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@a @b ping'})
    expect(accepted.deliveries).to.have.lengthOf(2)
    const [first, second] = accepted.deliveries
    expect(first.state).to.equal('dispatched')
    expect(second.state).to.equal('queued')

    // Drain background tasks.
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // events.jsonl ordering: first's dispatched → completed fires before
    // second's queued → dispatched.
    const treeReader = new ChannelTreeReader()
    const events = await treeReader.readEvents({channelId, projectRoot, turnId: accepted.turn.turnId})
    const firstCompleted = events.find(
      (e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.deliveryId === first.deliveryId && e.to === 'completed',
    )
    const secondDispatched = events.find(
      (e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.deliveryId === second.deliveryId && e.from === 'queued' && e.to === 'dispatched',
    )
    expect(firstCompleted, 'first delivery should complete').to.not.equal(undefined)
    expect(secondDispatched, 'second delivery should dispatch from queued').to.not.equal(undefined)
    expect(secondDispatched!.seq).to.be.greaterThan(firstCompleted!.seq)
  })

  it('cancel-vs-fan-out race: cancelTurn does not dispatch queued deliveries late', async () => {
    await seedChannel([{handle: '@a'}, {handle: '@b'}], {maxParallelAgents: 1})

    // First driver yields ONE event then blocks on a permission gate so the
    // background task does NOT complete before cancelTurn runs.
    const blockingDriver = new MockAcpDriver({
      events: [
        {content: 'before perm', kind: 'agent_message_chunk'},
        {
          kind: 'permission_request',
          permissionRequestId: 'p-race',
          request: {options: [{kind: 'allow_once', name: 'Allow', optionId: 'allow'}], sessionId: 's', toolCall: {toolCallId: 'tc-1'}},
        },
      ],
      handle: '@a',
    })
    const queuedDriver = new MockAcpDriver({events: [], handle: '@b'})
    mockDrivers.push(blockingDriver, queuedDriver)
    await blockingDriver.start()
    await queuedDriver.start()
    pool.register({channelId, driver: blockingDriver})
    pool.register({channelId, driver: queuedDriver})

    const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@a @b ping'})
    const [, second] = accepted.deliveries
    expect(second.state).to.equal('queued')

    // Wait for the first delivery to reach `awaiting_permission` so the
    // background task is parked.
    await new Promise((r) => {
      setTimeout(r, 50)
    })

    await orchestrator.cancelTurn({channelId, projectRoot, turnId: accepted.turn.turnId})

    // Drain in case any late callbacks fire.
    await new Promise((r) => {
      setTimeout(r, 50)
    })

    // The queued delivery MUST NOT have been dispatched. The cancel
    // coordinator emits queued → cancelled directly.
    const treeReader = new ChannelTreeReader()
    const events = await treeReader.readEvents({channelId, projectRoot, turnId: accepted.turn.turnId})
    const queuedDispatched = events.find(
      (e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.deliveryId === second.deliveryId && e.to === 'dispatched',
    )
    const queuedCancelled = events.find(
      (e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.deliveryId === second.deliveryId && e.to === 'cancelled',
    )
    expect(queuedDispatched, 'queued delivery must NOT have been dispatched after cancel').to.equal(undefined)
    expect(queuedCancelled, 'queued delivery must be cancelled directly from queued').to.not.equal(undefined)
    expect(queuedCancelled?.from).to.equal('queued')
  })
})
