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
  ChannelMeta,
  Turn,
  TurnDelivery,
  TurnEvent,
} from '../../../../../../src/shared/types/channel.js'

import {createAutoCreateQuota} from '../../../../../../src/server/infra/channel/bridge/auto-create-quota.js'
import {
  BridgeTranscriptService,
} from '../../../../../../src/server/infra/channel/bridge/bridge-transcript-service.js'

// Phase 9.5.4 — tests for the channel mirror auto-create upgrade.

class FakeEventsWriter {
  public readonly appended: TurnEvent[] = []

  async append(args: {channelId: string; event: TurnEvent; projectRoot: string; turnId: string}): Promise<void> {
    this.appended.push(args.event)
  }
}

class FakeChannelStore implements IChannelStore {
  public readonly closedTranscripts: ChannelStoreCloseTranscriptArgs[] = []
  public readonly createdChannels: ChannelMeta[] = []
  public readonly deliverySnapshots: TurnDelivery[] = []
  public readonly metaByChannel = new Map<string, ChannelMeta>()
  public readonly turnSnapshots: Turn[] = []

  async appendTurnEvent(): Promise<void> { /* unused */ }

  async appendTurnIndexEntry(): Promise<void> { /* unused */ }

  async closeTranscriptStream(args: ChannelStoreCloseTranscriptArgs): Promise<void> {
    this.closedTranscripts.push(args)
  }

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

  async reconstructIfMissing(args: ChannelStoreCreateArgs): Promise<'already-exists' | 'wrote'> {
    if (this.metaByChannel.has(args.meta.channelId)) return 'already-exists'
    this.metaByChannel.set(args.meta.channelId, args.meta)
    return 'wrote'
  }

  async sweepTranscripts(): Promise<void> { /* unused */ }

  async updateChannelMeta(args: ChannelStoreUpdateMetaArgs): Promise<Channel> {
    const current = this.metaByChannel.get(args.channelId)
    if (current === undefined) throw new Error(`no meta for ${args.channelId}`)
    const next = args.mutate(current)
    this.metaByChannel.set(args.channelId, next)
    return {
      channelId: next.channelId,
      createdAt: next.createdAt,
      memberCount: next.members.length,
      members: [],
      updatedAt: next.updatedAt,
    }
  }

  async writeDeliverySnapshot(args: ChannelStoreWriteDeliveryArgs): Promise<void> {
    this.deliverySnapshots.push(args.delivery)
  }

  async writeMessage(): Promise<void> { /* unused */ }

  async writeTurnSnapshot(args: ChannelStoreSnapshotArgs): Promise<void> {
    this.turnSnapshots.push(args.turn)
  }
}

type ServiceOptions = {
  autoProvisionPolicy?: 'auto' | 'deny' | 'pinned-only'
  channelStore?: IChannelStore
  eventsWriter?: FakeEventsWriter
  onAutoCreated?: (event: unknown) => void
  quota?: ReturnType<typeof createAutoCreateQuota>
}

const buildService = (opts: ServiceOptions = {}) => {
  const channelStore = (opts.channelStore ?? new FakeChannelStore()) as FakeChannelStore
  const eventsWriter = opts.eventsWriter ?? new FakeEventsWriter()
  const logs: string[] = []
  let idCounter = 0

  const quotaArg = opts.quota ?? createAutoCreateQuota({log: (m) => logs.push(m), maxPerHour: 5})

  const service = new BridgeTranscriptService({
    autoCreateQuota: quotaArg,
    autoProvisionPolicy: opts.autoProvisionPolicy ?? 'auto',
    channelStore,
    clock: () => new Date('2026-05-22T10:00:00.000Z'),
    eventsWriter: eventsWriter as unknown as never,
    idGenerator: () => `del-${++idCounter}`,
    onAutoCreated: opts.onAutoCreated,
    projectRoot: '/tmp/test',
  })
  return {channelStore, eventsWriter, logs, service}
}

const baseBeginArgs = (overrides: {
  channelId?: string
  remoteAddr?: string
  remoteL2PubKey?: string
  senderPinState?: 'auto-tofu' | 'ca-bound' | 'user-confirmed'
  turnId?: string
} = {}) => ({
  channelId: overrides.channelId ?? 'my-channel',
  prompt: [{text: 'hello', type: 'text' as const}] as const,
  remoteAddr: overrides.remoteAddr ?? '/ip4/10.0.0.1/tcp/60001/p2p/12D3KooWAlice',
  remoteL2PubKey: overrides.remoteL2PubKey ?? 'base64pubkeyABC==',
  senderDisplayHandle: '@alice',
  senderPeerId: '12D3KooWAlice',
  senderPinState: overrides.senderPinState ?? ('user-confirmed' as const),
  turnId: overrides.turnId ?? 'turn-1',
})

describe('BridgeTranscriptService — Phase 9.5.4 auto-create upgrade', () => {

  describe('#1 — tighter trust gate: auto-create declines auto-tofu', () => {
    it('declines auto-create for auto-tofu with policy=auto (auto-create requires higher trust)', async () => {
      // Even under policy=auto, creating a NEW channel for an auto-tofu peer is
      // declined. The per-turn parley call may succeed on an EXISTING channel,
      // but brand-new channel auto-creation requires user-confirmed / ca-bound.
      const {channelStore, service} = buildService({autoProvisionPolicy: 'auto'})
      const result = await service.beginTurn(baseBeginArgs({senderPinState: 'auto-tofu'}))

      // Auto-create is declined for auto-tofu
      expect(result.accepted).to.equal(false)
      if (!result.accepted) {
        expect(result.reason).to.include('auto-tofu')
      }

      // No channel created
      expect(channelStore.createdChannels).to.have.length(0)
    })

    it('auto-create succeeds for user-confirmed sender with policy=auto', async () => {
      const {channelStore, service} = buildService({autoProvisionPolicy: 'auto'})
      const result = await service.beginTurn(baseBeginArgs({senderPinState: 'user-confirmed'}))
      expect(result.accepted).to.equal(true)
      expect(channelStore.createdChannels).to.have.length(1)
    })

    it('auto-create succeeds for ca-bound sender with policy=auto', async () => {
      const {channelStore, service} = buildService({autoProvisionPolicy: 'auto'})
      const result = await service.beginTurn(baseBeginArgs({senderPinState: 'ca-bound'}))
      expect(result.accepted).to.equal(true)
      expect(channelStore.createdChannels).to.have.length(1)
    })

    it('policy=pinned-only still rejects auto-tofu for the turn entirely', async () => {
      const {service} = buildService({autoProvisionPolicy: 'pinned-only'})
      const result = await service.beginTurn(baseBeginArgs({senderPinState: 'auto-tofu'}))
      expect(result.accepted).to.equal(false)
    })
  })

  describe('#2 + #3 — multiaddr + L2 cert stored on auto-created member', () => {
    it('stores remoteAddr and remoteL2PubKey on the auto-created member record', async () => {
      const {channelStore, service} = buildService()
      await service.beginTurn(baseBeginArgs({
        remoteAddr: '/ip4/10.0.0.5/tcp/60001/p2p/12D3KooWAlice',
        remoteL2PubKey: 'dGVzdGtleQ==',
      }))
      const meta = channelStore.metaByChannel.get('my-channel')
      expect(meta).to.not.equal(undefined)
      const member = meta!.members[0] as {addressability?: string; multiaddr?: string; remoteL2PubKey?: string}
      expect(member.multiaddr).to.equal('/ip4/10.0.0.5/tcp/60001/p2p/12D3KooWAlice')
      expect(member.remoteL2PubKey).to.equal('dGVzdGtleQ==')
    })

    it('marks the member with addressability=bootstrap-only', async () => {
      const {channelStore, service} = buildService()
      await service.beginTurn(baseBeginArgs())
      const meta = channelStore.metaByChannel.get('my-channel')
      const member = meta!.members[0] as {addressability?: string}
      expect(member.addressability).to.equal('bootstrap-only')
    })
  })

  describe('#4 — quota rate limiting', () => {
    it('returns PARLEY_AUTO_CREATE_RATE_LIMIT when quota exhausted', async () => {
      const logs: string[] = []
      const quota = createAutoCreateQuota({log: (m) => logs.push(m), maxPerHour: 2})
      const {service} = buildService({quota})

      // Use up quota creating 2 NEW channels
      await service.beginTurn(baseBeginArgs({channelId: 'chan-1'}))
      await service.beginTurn(baseBeginArgs({channelId: 'chan-2', turnId: 'turn-2'}))
      // 3rd new channel should be rate limited
      const result = await service.beginTurn(baseBeginArgs({channelId: 'chan-3', turnId: 'turn-3'}))
      expect(result.accepted).to.equal(false)
      if (!result.accepted) {
        expect(result.reason).to.include('PARLEY_AUTO_CREATE_RATE_LIMIT')
      }
    })
  })

  describe('#5 — channelId validation', () => {
    it('rejects invalid channelId with PARLEY_INVALID_CHANNEL_ID', async () => {
      const {service} = buildService()
      const result = await service.beginTurn(baseBeginArgs({channelId: 'INVALID_ID!'}))
      expect(result.accepted).to.equal(false)
      if (!result.accepted) {
        expect(result.reason).to.include('PARLEY_INVALID_CHANNEL_ID')
      }
    })

    it('accepts valid channelId', async () => {
      const {service} = buildService()
      const result = await service.beginTurn(baseBeginArgs({channelId: 'valid-channel-123'}))
      expect(result.accepted).to.equal(true)
    })
  })

  describe('#6 — provenance fields', () => {
    it('sets autoProvisionedFrom and autoProvisionedAt on the auto-created channel meta', async () => {
      const {channelStore, service} = buildService()
      await service.beginTurn(baseBeginArgs())
      const meta = channelStore.metaByChannel.get('my-channel') as ChannelMeta & {
        autoProvisionedAt?: string
        autoProvisionedFrom?: string
      }
      expect(meta.autoProvisionedFrom).to.equal('12D3KooWAlice')
      expect(meta.autoProvisionedAt).to.equal('2026-05-22T10:00:00.000Z')
    })
  })

  describe('#7 — channel_auto_created event', () => {
    it('emits channel_auto_created event on successful auto-create', async () => {
      const emitted: unknown[] = []
      const {service} = buildService({onAutoCreated: (event) => emitted.push(event)})
      await service.beginTurn(baseBeginArgs())
      expect(emitted).to.have.length(1)
      const event = emitted[0] as Record<string, unknown>
      expect(event.kind).to.equal('channel_auto_created')
      expect(event.channelId).to.equal('my-channel')
      expect(event.autoProvisionedFrom).to.equal('12D3KooWAlice')
      expect(event.addressability).to.equal('bootstrap-only')
      expect(event.multiaddr).to.equal('/ip4/10.0.0.1/tcp/60001/p2p/12D3KooWAlice')
    })

    it('does not emit channel_auto_created when channel already exists', async () => {
      const emitted: unknown[] = []
      const {service} = buildService({onAutoCreated: (event) => emitted.push(event)})
      // First call creates the channel
      await service.beginTurn(baseBeginArgs())
      const firstEmitted = emitted.length
      // Second call for same channel → no new auto-create event
      await service.beginTurn(baseBeginArgs({turnId: 'turn-2'}))
      expect(emitted.length).to.equal(firstEmitted)
    })
  })
})
