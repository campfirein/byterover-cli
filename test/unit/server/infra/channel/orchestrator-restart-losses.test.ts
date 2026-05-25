import {expect} from 'chai'

import type {IChannelBroadcaster} from '../../../../../src/server/core/interfaces/channel/i-channel-broadcaster.js'

import {
  ChannelPermissionLostOnRestartError,
  ChannelTurnNotFoundError,
} from '../../../../../src/server/core/domain/channel/errors.js'
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
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Slice 8.10 — `permissionDecision()` returns `CHANNEL_PERMISSION_LOST_ON_RESTART`
// (with a Slice-8.9 cursor) instead of the misleading `CHANNEL_TURN_NOT_FOUND`
// when `runChannelRecovery()` has previously seeded an orphan registry entry
// for that permission. Keyed by `permissionRequestId` so multiple orphaned
// permissions on the same turn each resolve correctly (codex Q6).
// V3 super-mario reproducer (2026-05-16).

describe('ChannelOrchestrator.seedRestartLosses + permissionDecision (Slice 8.10)', () => {
  let projectRoot: string
  let orchestrator: ChannelOrchestrator

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()

    const serializer = new ChannelWriteSerializer()
    const store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })

    const broker = new PermissionBroker()
    const pool = new AcpDriverPool()
    const seqAllocator = new TurnSequenceAllocator()
    const cancelCoordinator = new CancelCoordinator({
      broker,
      pool,
      seqAllocator,
      async writeEvent() {},
    })
    const broadcaster: IChannelBroadcaster = {broadcastToChannel() {}}

    let idSeq = 0
    let nowMs = 1_700_000_000_000

    orchestrator = new ChannelOrchestrator({
      broadcaster,
      cancelCoordinator,
      clock() {
        nowMs += 1
        return new Date(nowMs)
      },
      driverFactory: (_invocation, handle) => new MockAcpDriver({events: [], handle}),
      idGenerator() {
        idSeq += 1
        return `id-${String(idSeq).padStart(4, '0')}`
      },
      permissionBroker: broker,
      pool,
      seqAllocator,
      store,
    })
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  it('throws ChannelPermissionLostOnRestartError when the orphan registry has a matching permissionRequestId', async () => {
    orchestrator.seedRestartLosses([
      {
        channelId: 'pubsub-review',
        erroredSeq: 7,
        permissionRequestId: 'perm-abc',
        turnId: 'turn-xyz',
      },
    ])

    let caught: unknown
    try {
      await orchestrator.permissionDecision({
        channelId: 'pubsub-review',
        outcome: {optionId: 'allow', outcome: 'selected'},
        permissionRequestId: 'perm-abc',
        projectRoot,
        turnId: 'turn-xyz',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(ChannelPermissionLostOnRestartError)
    const err = caught as ChannelPermissionLostOnRestartError
    expect(err.channelId).to.equal('pubsub-review')
    expect(err.turnId).to.equal('turn-xyz')
    expect(err.permissionRequestId).to.equal('perm-abc')
    expect(err.erroredSeq).to.equal(7)
  })

  it('falls back to ChannelTurnNotFoundError when activeTurns AND restart registry both miss', async () => {
    // No seeding — registry is empty.
    let caught: unknown
    try {
      await orchestrator.permissionDecision({
        channelId: 'pubsub-review',
        outcome: {optionId: 'allow', outcome: 'selected'},
        permissionRequestId: 'perm-abc',
        projectRoot,
        turnId: 'turn-xyz',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(ChannelTurnNotFoundError)
    expect(caught).to.not.be.instanceOf(ChannelPermissionLostOnRestartError)
  })

  it('falls back to ChannelTurnNotFoundError when a restart-loss exists for a DIFFERENT permissionRequestId on the same turn (codex Q6: per-permission keying)', async () => {
    orchestrator.seedRestartLosses([
      {
        channelId: 'pubsub-review',
        erroredSeq: 7,
        permissionRequestId: 'perm-OTHER',
        turnId: 'turn-xyz',
      },
    ])

    let caught: unknown
    try {
      await orchestrator.permissionDecision({
        channelId: 'pubsub-review',
        outcome: {optionId: 'allow', outcome: 'selected'},
        permissionRequestId: 'perm-abc', // different permission
        projectRoot,
        turnId: 'turn-xyz', // same turn
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(ChannelTurnNotFoundError)
    expect(caught).to.not.be.instanceOf(ChannelPermissionLostOnRestartError)
  })

  it('falls back to ChannelTurnNotFoundError when the restart-loss is for a DIFFERENT channel', async () => {
    orchestrator.seedRestartLosses([
      {
        channelId: 'other-channel',
        erroredSeq: 7,
        permissionRequestId: 'perm-abc',
        turnId: 'turn-xyz',
      },
    ])

    let caught: unknown
    try {
      await orchestrator.permissionDecision({
        channelId: 'pubsub-review', // different channel
        outcome: {optionId: 'allow', outcome: 'selected'},
        permissionRequestId: 'perm-abc',
        projectRoot,
        turnId: 'turn-xyz',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(ChannelTurnNotFoundError)
  })

  it('seedRestartLosses([]) is a no-op', async () => {
    orchestrator.seedRestartLosses([])
    let caught: unknown
    try {
      await orchestrator.permissionDecision({
        channelId: 'pubsub-review',
        outcome: {optionId: 'allow', outcome: 'selected'},
        permissionRequestId: 'perm-abc',
        projectRoot,
        turnId: 'turn-xyz',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).to.be.instanceOf(ChannelTurnNotFoundError)
  })

  it('supports multiple restart-loss records seeded at once', async () => {
    orchestrator.seedRestartLosses([
      {channelId: 'ch', erroredSeq: 3, permissionRequestId: 'perm-1', turnId: 'turn-1'},
      {channelId: 'ch', erroredSeq: 5, permissionRequestId: 'perm-2', turnId: 'turn-2'},
    ])

    let first: unknown
    try {
      await orchestrator.permissionDecision({
        channelId: 'ch',
        outcome: {optionId: 'allow', outcome: 'selected'},
        permissionRequestId: 'perm-1',
        projectRoot,
        turnId: 'turn-1',
      })
    } catch (error) {
      first = error
    }

    expect(first).to.be.instanceOf(ChannelPermissionLostOnRestartError)
    expect((first as ChannelPermissionLostOnRestartError).erroredSeq).to.equal(3)

    let second: unknown
    try {
      await orchestrator.permissionDecision({
        channelId: 'ch',
        outcome: {optionId: 'allow', outcome: 'selected'},
        permissionRequestId: 'perm-2',
        projectRoot,
        turnId: 'turn-2',
      })
    } catch (error) {
      second = error
    }

    expect(second).to.be.instanceOf(ChannelPermissionLostOnRestartError)
    expect((second as ChannelPermissionLostOnRestartError).erroredSeq).to.equal(5)
  })
})
