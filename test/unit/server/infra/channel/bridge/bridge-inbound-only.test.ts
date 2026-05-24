
import {expect} from 'chai'

import type {
  ChannelStoreCloseTranscriptArgs,
  ChannelStoreCreateArgs,
  ChannelStoreReadArgs,
  ChannelStoreSnapshotArgs,
  ChannelStoreUpdateMetaArgs,
  ChannelStoreWriteDeliveryArgs,
  IChannelStore,
} from '../../../../../../src/server/core/interfaces/channel/i-channel-store.js'
import type {
  Channel,
  ChannelMemberRemotePeer,
  ChannelMeta,
  Turn,
  TurnDelivery,
  TurnEvent,
} from '../../../../../../src/shared/types/channel.js'

import {BridgeTranscriptService} from '../../../../../../src/server/infra/channel/bridge/bridge-transcript-service.js'
import {ChannelDoctorService} from '../../../../../../src/server/infra/channel/doctor-service.js'

// Phase 9.5.9 §2.5 — inbound-only auto-create marker tests.
// When remoteAddr or remoteL2PubKey is absent, member must be created
// with addressability='inbound-only'.

class FakeEventsWriter {
  public readonly appended: TurnEvent[] = []

  async append(args: {channelId: string; event: TurnEvent; projectRoot: string; turnId: string}): Promise<void> {
    this.appended.push(args.event)
  }
}

class FakeChannelStore implements IChannelStore {
  public readonly createdChannels: ChannelMeta[] = []
  public readonly metaByChannel = new Map<string, ChannelMeta>()

  async appendTurnEvent(): Promise<void> { /* unused */ }

  async appendTurnIndexEntry(): Promise<void> { /* unused */ }

  async closeTranscriptStream(_args: ChannelStoreCloseTranscriptArgs): Promise<void> { /* unused */ }

  async createChannel(args: ChannelStoreCreateArgs): Promise<Channel> {
    this.createdChannels.push(args.meta)
    this.metaByChannel.set(args.meta.channelId, args.meta)
    return {
      channelId: args.meta.channelId,
      createdAt: args.meta.createdAt,
      memberCount: args.meta.members.length,
      members: [],
      updatedAt: args.meta.updatedAt,
    }
  }

  async listChannels(): Promise<Channel[]> { return [] }

  async listTurns(): Promise<{turns: Turn[]}> { return {turns: []} }

  async readChannel(): Promise<Channel | undefined> { return undefined }

  async readChannelMeta(args: ChannelStoreReadArgs): Promise<ChannelMeta | undefined> {
    return this.metaByChannel.get(args.channelId)
  }

  async readDeliveries(): Promise<TurnDelivery[]> { return [] }

  async readTurn(): Promise<undefined> { return undefined }

  async sweepTranscripts(): Promise<void> { /* unused */ }

  async updateChannelMeta(args: ChannelStoreUpdateMetaArgs): Promise<Channel> {
    const current = this.metaByChannel.get(args.channelId)
    if (current === undefined) throw new Error(`no meta for ${args.channelId}`)
    const next = args.mutate(current)
    this.metaByChannel.set(args.channelId, next)
    return {channelId: next.channelId, createdAt: next.createdAt, memberCount: next.members.length, members: [], updatedAt: next.updatedAt}
  }

  async writeDeliverySnapshot(_args: ChannelStoreWriteDeliveryArgs): Promise<void> { /* unused */ }

  async writeMessage(): Promise<void> { /* unused */ }

  async writeTurnSnapshot(_args: ChannelStoreSnapshotArgs): Promise<void> { /* unused */ }
}

function buildService(channelStore: FakeChannelStore) {
  let idCounter = 0
  return new BridgeTranscriptService({
    autoProvisionPolicy: 'auto',
    channelStore,
    clock: () => new Date('2026-05-24T00:00:00.000Z'),
    eventsWriter: new FakeEventsWriter() as unknown as never,
    idGenerator: () => `id-${++idCounter}`,
    projectRoot: '/tmp/test',
  })
}

describe('inbound-only channel member (Phase 9.5.9 §2.5)', () => {
  // ─── BridgeTranscriptService inbound-only auto-create ───────────────────────

  describe('BridgeTranscriptService — auto-create', () => {
    it('creates member with addressability=bootstrap-only when both multiaddr AND L2 are present', async () => {
      const store = new FakeChannelStore()
      const svc = buildService(store)

      await svc.beginTurn({
        channelId: 'ch-full',
        prompt: [{text: 'hi', type: 'text'}],
        remoteAddr: '/ip4/1.2.3.4/tcp/1234',
        remoteL2PubKey: 'base64pubkey',
        senderPeerId: 'peer-alice',
        senderPinState: 'user-confirmed',
        turnId: 'turn-1',
      })

      const meta = store.metaByChannel.get('ch-full')
      expect(meta).to.not.equal(undefined)
      const member = meta!.members[0] as ChannelMemberRemotePeer
      expect(member.addressability).to.equal('bootstrap-only')
    })

    it('creates member with addressability=inbound-only when remoteAddr is missing', async () => {
      const store = new FakeChannelStore()
      const svc = buildService(store)

      await svc.beginTurn({
        channelId: 'ch-no-addr',
        prompt: [{text: 'hi', type: 'text'}],
        remoteAddr: undefined,
        remoteL2PubKey: 'base64pubkey',
        senderPeerId: 'peer-bob',
        senderPinState: 'user-confirmed',
        turnId: 'turn-2',
      })

      const meta = store.metaByChannel.get('ch-no-addr')
      expect(meta).to.not.equal(undefined)
      const member = meta!.members[0] as ChannelMemberRemotePeer
      expect(member.addressability).to.equal('inbound-only')
    })

    it('creates member with addressability=inbound-only when remoteL2PubKey is missing', async () => {
      const store = new FakeChannelStore()
      const svc = buildService(store)

      await svc.beginTurn({
        channelId: 'ch-no-l2',
        prompt: [{text: 'hi', type: 'text'}],
        remoteAddr: '/ip4/1.2.3.4/tcp/1234',
        remoteL2PubKey: undefined,
        senderPeerId: 'peer-carol',
        senderPinState: 'user-confirmed',
        turnId: 'turn-3',
      })

      const meta = store.metaByChannel.get('ch-no-l2')
      expect(meta).to.not.equal(undefined)
      const member = meta!.members[0] as ChannelMemberRemotePeer
      expect(member.addressability).to.equal('inbound-only')
    })

    it('creates member with addressability=inbound-only when both are missing', async () => {
      const store = new FakeChannelStore()
      const svc = buildService(store)

      await svc.beginTurn({
        channelId: 'ch-none',
        prompt: [{text: 'hi', type: 'text'}],
        senderPeerId: 'peer-dave',
        senderPinState: 'user-confirmed',
        turnId: 'turn-4',
      })

      const meta = store.metaByChannel.get('ch-none')
      expect(meta).to.not.equal(undefined)
      const member = meta!.members[0] as ChannelMemberRemotePeer
      expect(member.addressability).to.equal('inbound-only')
    })
  })

  // ─── DoctorService INBOUND_ONLY health code ─────────────────────────────────

  describe('ChannelDoctorService — INBOUND_ONLY code', () => {
    it('emits DOCTOR_INBOUND_ONLY for a member with addressability=inbound-only', async () => {
      const meta: ChannelMeta = {
        channelId: 'ch-test',
        createdAt: '2026-05-24T00:00:00.000Z',
        members: [
          {
            addressability: 'inbound-only' as const,
            handle: '@remote',
            joinedAt: '2026-05-24T00:00:00.000Z',
            memberKind: 'remote-peer' as const,
            peerId: 'peer-xyz',
            status: 'idle' as const,
          },
        ],
        updatedAt: '2026-05-24T00:00:00.000Z',
      }

      const fakeStore = {
        listTurns: async () => ({turns: []}),
        readChannelMeta: async () => meta,
      } as unknown as import('../../../../../../src/server/core/interfaces/channel/i-channel-store.js').IChannelStore

      const fakePool = {
        acquire() { /* unused */ },
        inspect: () => [],
      } as unknown as import('../../../../../../src/server/core/interfaces/channel/i-driver-pool.js').IAcpDriverPool

      const fakeBroker = {inspect: () => []} as unknown as import('../../../../../../src/server/infra/channel/drivers/permission-broker.js').IPermissionBroker

      const fakeProfileStore = {
        async get() { /* unused */ },
      } as unknown as import('../../../../../../src/server/core/interfaces/channel/i-driver-profile-store.js').IDriverProfileStore

      const svc = new ChannelDoctorService({
        broker: fakeBroker,
        clock: () => new Date('2026-05-24T00:00:00.000Z'),
        pool: fakePool,
        profileStore: fakeProfileStore,
        store: fakeStore,
      })

      const result = await svc.run({channelId: 'ch-test', projectRoot: '/tmp/proj'})
      const codes = result.diagnostics.map((d) => d.code)
      expect(codes).to.include('DOCTOR_INBOUND_ONLY')
    })
  })
})
