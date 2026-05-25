import {expect} from 'chai'

import type {AutoCreateQuota} from '../../../../../src/server/infra/channel/bridge/auto-create-quota.js'
import type {ChannelMeta} from '../../../../../src/shared/types/channel.js'

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

// Phase 9.5.4 deferral (§6) — uninvite of a remote-peer must call
// `autoCreateQuota.reset(peerId)` so the peer can auto-create again after
// being removed.

describe('ChannelOrchestrator — uninvite resets autoCreateQuota for remote-peer (§9.5 deferral)', () => {
  let projectRoot: string
  let store: ChannelStore
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  const channelId = 'quota-reset-test'

  // Fake quota that tracks which peerIds were reset.
  let resetCalls: string[]
  let fakeQuota: AutoCreateQuota

  const makeOrchestrator = (quota?: AutoCreateQuota): ChannelOrchestrator => {
    const serializer = new ChannelWriteSerializer()
    store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
    pool = new AcpDriverPool()
    broker = new PermissionBroker()
    let idCounter = 0
    const seqAllocator = new TurnSequenceAllocator()
    const cancelCoordinator = new CancelCoordinator({
      broker,
      pool,
      seqAllocator,
      async writeEvent(event, ctx) {
        await store.appendTurnEvent({channelId: ctx.channelId, event, projectRoot: ctx.projectRoot, turnId: ctx.turnId})
      },
    })

    return new ChannelOrchestrator({
      ...(quota === undefined ? {} : {autoCreateQuota: quota}),
      broadcaster: {
        broadcastToChannel(_id: string, _event: string, _payload: unknown) { /* no-op */ },
      },
      cancelCoordinator,
      clock: () => new Date('2026-05-23T00:00:00.000Z'),
      driverFactory(_invocation, handle) {
        return new MockAcpDriver({events: [], handle})
      },
      idGenerator: () => `id-${++idCounter}`,
      permissionBroker: broker,
      pool,
      remotePeerDriverFactory: async (args) => new MockAcpDriver({events: [], handle: args.handle}),
      seqAllocator,
      store,
    })
  }

  const addRemotePeerToMeta = async (_orch: ChannelOrchestrator, options: {handle: string; peerId: string}): Promise<void> => {
    await store.updateChannelMeta({
      channelId,
      mutate: (m: ChannelMeta): ChannelMeta => ({
        ...m,
        members: [
          ...m.members,
          {
            handle: options.handle,
            joinedAt: '2026-05-23T00:00:00.000Z',
            memberKind: 'remote-peer' as const,
            peerId: options.peerId,
            status: 'idle' as const,
          },
        ],
        updatedAt: '2026-05-23T00:00:00.000Z',
      }),
      projectRoot,
    })
    // Also register a driver in the pool so uninvite's pool.release doesn't fail.
    const fakeDriver = new MockAcpDriver({events: [], handle: options.handle})
    pool.register({channelId, driver: fakeDriver})
  }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    resetCalls = []
    fakeQuota = {
      reset(peerId: string): void { resetCalls.push(peerId) },
      tryConsume(): boolean { return true },
    }

    orchestrator = makeOrchestrator(fakeQuota)
    await orchestrator.createChannel({channelId, projectRoot})
  })

  afterEach(async () => {
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  it('resets the quota for the uninvited remote-peer', async () => {
    const remotePeerId = '12D3KooWRemotePeerXXXXXXXXXXXXXXXXXXXXXXX'
    await addRemotePeerToMeta(orchestrator, {handle: '@remote', peerId: remotePeerId})

    await orchestrator.uninviteMember({channelId, memberHandle: '@remote', projectRoot})

    expect(resetCalls).to.deep.equal([remotePeerId])
  })

  it('does NOT call quota.reset when uninviting a non-remote-peer member', async () => {
    // Invite a local acp-agent member.
    await orchestrator.inviteMember({
      channelId,
      handle: '@local',
      invocation: {args: [], command: 'noop', cwd: projectRoot},
      projectRoot,
    })

    await orchestrator.uninviteMember({channelId, memberHandle: '@local', projectRoot})

    expect(resetCalls).to.deep.equal([])
  })

  it('does NOT throw if autoCreateQuota is not provided (backwards compat)', async () => {
    const orchNoQuota = makeOrchestrator()
    const tmpRoot = await makeTempContextTree()
    try {
      await orchNoQuota.createChannel({channelId: 'quota-compat', projectRoot: tmpRoot})
      await orchNoQuota.inviteMember({
        channelId: 'quota-compat',
        handle: '@local',
        invocation: {args: [], command: 'noop', cwd: tmpRoot},
        projectRoot: tmpRoot,
      })
      // Should not throw even without a quota
      await orchNoQuota.uninviteMember({channelId: 'quota-compat', memberHandle: '@local', projectRoot: tmpRoot})
    } finally {
      await pool.releaseAll()
      await removeTempDir(tmpRoot)
    }
  })
})
