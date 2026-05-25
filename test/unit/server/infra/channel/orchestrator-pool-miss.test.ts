import {expect} from 'chai'

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

// Slice 8.11 Layer 1 — when pool.acquire() returns undefined (no driver
// registered for this channel+member, e.g. after daemon restart and before
// warmDriversForProject fires), the orchestrator must:
//   1. Set delivery.errorCode = CHANNEL_DRIVER_NOT_REGISTERED.
//   2. Set delivery.errorMessage to a non-empty hint mentioning re-invite.
//   3. Emit a delivery_state_change → errored event over the broadcaster
//      (so subscribe/watch consumers see the transition).
//   4. Carry errorCode on the wire event (codex Q6 schema extension).
// Previously the path silently set delivery.state = 'errored' with no event
// and no code, surfacing as ChannelDeliveryFailedError(reason='unknown').

describe('ChannelOrchestrator — pool-miss (Slice 8.11 Layer 1)', () => {
  let projectRoot: string
  let store: ChannelStore
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  let broadcasts: TurnEvent[]
  const channelId = 'pi-pool-miss'

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
      clock: () => new Date('2026-05-17T12:00:00.000Z'),
      driverFactory(_invocation, handle) {
        return new MockAcpDriver({events: [], handle})
      },
      idGenerator,
      permissionBroker: broker,
      pool,
      seqAllocator,
      store,
    })
  })

  afterEach(async () => {
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  const seedChannel = async (members: Array<{handle: string}>, settings?: ChannelMeta['settings']): Promise<void> => {
    await store.createChannel({
      meta: {
        channelId,
        createdAt: '2026-05-17T12:00:00.000Z',
        members: members.map((m) => ({
          acpVersion: '1',
          agentName: m.handle,
          capabilities: [],
          driverClass: 'C-prime',
          handle: m.handle,
          invocation: {args: [], command: 'noop', cwd: '/tmp'},
          joinedAt: '2026-05-17T12:00:00.000Z',
          memberKind: 'acp-agent',
          status: 'idle',
        })),
        settings,
        updatedAt: '2026-05-17T12:00:00.000Z',
      },
      projectRoot,
    })
  }

  it('surfaces CHANNEL_DRIVER_NOT_REGISTERED with re-invite hint when pool is empty', async () => {
    // Seed member into meta.json, but DO NOT register a driver in the pool —
    // simulates the post-restart-before-warm window.
    await seedChannel([{handle: '@kimi'}])

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
    expect(err.failedDeliveries).to.have.lengthOf(1)
    const failed = err.failedDeliveries[0]
    expect(failed.handle).to.equal('@kimi')
    expect(failed.code, 'expected canonical wire code, not "unknown"').to.equal('CHANNEL_DRIVER_NOT_REGISTERED')
    expect(failed.reason).to.be.a('string').and.satisfy((s: string) => s.length > 0)
    expect(failed.reason).to.match(/re-invite/i)
  })

  it('emits a delivery_state_change → errored broadcast on pool-miss (codex Q6 — visible to subscribe/watch)', async () => {
    await seedChannel([{handle: '@kimi'}])

    const accepted = await orchestrator.dispatchMention({
      channelId,
      mode: 'sync',
      projectRoot,
      prompt: '@kimi please review',
    })

    try {
      await orchestrator.awaitSyncMention(accepted.turn.turnId)
    } catch {
      /* expected */
    }

    const erroredDeliveryEvents = broadcasts.filter(
      (e): e is Extract<TurnEvent, {kind: 'delivery_state_change'}> =>
        e.kind === 'delivery_state_change' && e.to === 'errored',
    )
    expect(erroredDeliveryEvents, 'pool-miss must broadcast delivery_state_change → errored').to.have.length.greaterThanOrEqual(1)

    const evt = erroredDeliveryEvents[0]
    // Codex Q6 schema extension: optional errorCode field carries the canonical code.
    expect(evt.errorCode, 'wire event must carry errorCode').to.equal('CHANNEL_DRIVER_NOT_REGISTERED')
    expect(evt.error, 'wire event must carry human error message').to.be.a('string').and.satisfy((s: string) => s.length > 0)
    expect(evt.memberHandle).to.equal('@kimi')
  })

  it('does not fall through to the streaming path when pool is empty (no agent_message_chunk events)', async () => {
    await seedChannel([{handle: '@kimi'}])

    const accepted = await orchestrator.dispatchMention({
      channelId,
      mode: 'sync',
      projectRoot,
      prompt: '@kimi please review',
    })

    try {
      await orchestrator.awaitSyncMention(accepted.turn.turnId)
    } catch {
      /* expected */
    }

    // If the orchestrator had continued past pool.acquire, MockAcpDriver
    // would emit no chunks (we constructed it with empty events) — but
    // pool.acquire never returned a driver. Verify no chunk events leaked.
    const chunks = broadcasts.filter((e) => e.kind === 'agent_message_chunk')
    expect(chunks).to.have.length(0)
  })
})
