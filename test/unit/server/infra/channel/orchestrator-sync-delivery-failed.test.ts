import {expect} from 'chai'

import type {AcpDriverPromptArgs, AcpDriverStatus, IAcpDriver, TurnEventPayload} from '../../../../../src/server/core/interfaces/channel/i-acp-driver.js'
import type {ChannelMeta, TurnEvent} from '../../../../../src/shared/types/channel.js'

import {ChannelDeliveryFailedError} from '../../../../../src/server/core/domain/channel/errors.js'
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

// Bug 2 follow-up (2026-05-14) — when a per-member delivery for a
// sync-mode turn ends in `errored` state, the sync resolver must reject
// the pending entry with CHANNEL_DELIVERY_FAILED rather than resolving
// with empty `finalAnswer` + `endedState: 'completed'`. Reproduces the
// smoke-test failure where Claude Code saw "success with no answer" for
// turns whose kimi delivery actually errored.

class FailingAcpDriver implements IAcpDriver {
  public acpInitialize: undefined
  public readonly capabilities: string[] = []
  public readonly handle: string
  public protocolVersion: number | undefined
  public status: AcpDriverStatus = 'idle'

  public constructor(handle: string, private readonly reason: string = 'subprocess exited unexpectedly') {
    this.handle = handle
  }

  async cancel(): Promise<void> {
    /* no-op */
  }

  async probeSession(): Promise<boolean> {
    return true
  }

  prompt(_args: AcpDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
    const {reason} = this
    // eslint-disable-next-line require-yield -- generator that always throws; no yield by design
    async function* fail(): AsyncIterableIterator<TurnEventPayload> {
      throw new Error(reason)
    }

    return fail()
  }

  async respondToPermission(_permissionRequestId: string, _response: unknown): Promise<void> {
    /* no-op */
  }

  async start(): Promise<void> {
    this.status = 'idle'
  }

  async stop(): Promise<void> {
    this.status = 'stopped'
  }
}

describe('ChannelOrchestrator — sync-mode CHANNEL_DELIVERY_FAILED (Bug 2)', () => {
  let projectRoot: string
  let store: ChannelStore
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  const channelId = 'pi-sync-fail'
  let drivers: IAcpDriver[]
  let driverIndex: number
  let broadcasts: TurnEvent[]

  beforeEach(async () => {
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
    drivers = []
    driverIndex = 0
    broadcasts = []

    let idCounter = 0
    const idGenerator = (): string => `id-${++idCounter}`

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
      clock: () => new Date('2026-05-14T12:00:00.000Z'),
      driverFactory(_invocation, handle) {
        const driver = drivers[driverIndex++] ?? new MockAcpDriver({events: [], handle})
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
    // Multi-member fan-out test starts a background streaming task for
    // the second (non-failing) member that may still be writing snapshots
    // when the test body returns. Give it a beat to flush before rm-rf.
    await new Promise((r) => {
      setTimeout(r, 100)
    })
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  const seedChannel = async (members: Array<{handle: string}>, settings?: ChannelMeta['settings']): Promise<void> => {
    await store.createChannel({
      meta: {
        channelId,
        createdAt: '2026-05-14T12:00:00.000Z',
        members: members.map((m) => ({
          acpVersion: '1',
          agentName: m.handle,
          capabilities: [],
          driverClass: 'C-prime',
          handle: m.handle,
          invocation: {args: [], command: 'noop', cwd: '/tmp'},
          joinedAt: '2026-05-14T12:00:00.000Z',
          memberKind: 'acp-agent',
          status: 'idle',
        })),
        settings,
        updatedAt: '2026-05-14T12:00:00.000Z',
      },
      projectRoot,
    })
  }

  const registerDriver = async (driver: IAcpDriver): Promise<void> => {
    drivers.push(driver)
    if (driver.start) await driver.start()
    pool.register({channelId, driver})
  }

  it('single-member sync turn where the driver errors → awaitSyncMention rejects with CHANNEL_DELIVERY_FAILED', async () => {
    await seedChannel([{handle: '@kimi'}])
    await registerDriver(new FailingAcpDriver('@kimi', 'subprocess exited unexpectedly'))

    const accepted = await orchestrator.dispatchMention({
      channelId,
      mode: 'sync',
      projectRoot,
      prompt: '@kimi please review',
    })

    let caught: unknown
    try {
      await orchestrator.awaitSyncMention(accepted.turn.turnId)
    } catch (error) {
      caught = error
    }

    expect(caught, 'awaitSyncMention should reject').to.be.instanceOf(ChannelDeliveryFailedError)
    const err = caught as ChannelDeliveryFailedError
    expect(err.code).to.equal('CHANNEL_DELIVERY_FAILED')
    expect(err.turnId).to.equal(accepted.turn.turnId)
    expect(err.failedDeliveries).to.have.lengthOf(1)
    expect(err.failedDeliveries[0].handle).to.equal('@kimi')
    expect(err.failedDeliveries[0].reason).to.include('subprocess exited unexpectedly')
  })

  it('multi-member fan-out where one delivery errors and one succeeds → rejects with CHANNEL_DELIVERY_FAILED listing only the errored member', async () => {
    await seedChannel([{handle: '@kimi'}, {handle: '@echo'}])
    await registerDriver(new FailingAcpDriver('@kimi', 'kimi acp crashed'))
    await registerDriver(
      new MockAcpDriver({
        events: [{content: 'echo says hi', kind: 'agent_message_chunk'}],
        handle: '@echo',
      }),
    )

    const accepted = await orchestrator.dispatchMention({
      channelId,
      mode: 'sync',
      projectRoot,
      prompt: '@kimi @echo ping',
    })

    let caught: unknown
    try {
      await orchestrator.awaitSyncMention(accepted.turn.turnId)
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(ChannelDeliveryFailedError)
    const err = caught as ChannelDeliveryFailedError
    expect(err.failedDeliveries.map((d) => d.handle)).to.deep.equal(['@kimi'])
    expect(err.failedDeliveries[0].reason).to.include('kimi acp crashed')
  })
})
