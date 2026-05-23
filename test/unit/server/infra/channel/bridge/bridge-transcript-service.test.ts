 

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

import {BridgeTranscriptService} from '../../../../../../src/server/infra/channel/bridge/bridge-transcript-service.js'

// Phase 9 / Slice 9.4e — kimi round-1 LOW-11 regression coverage for
// the auto-provision policy gate + channel-meta auto-creation +
// transcript seq monotonicity.

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

const buildService = (overrides: Partial<{
  autoProvisionPolicy: 'auto' | 'deny' | 'pinned-only'
  channelStore: IChannelStore
  eventsWriter: FakeEventsWriter
}> = {}) => {
  const channelStore = (overrides.channelStore ?? new FakeChannelStore()) as FakeChannelStore
  const eventsWriter = overrides.eventsWriter ?? new FakeEventsWriter()
  let idCounter = 0
  const service = new BridgeTranscriptService({
    autoProvisionPolicy: overrides.autoProvisionPolicy ?? 'auto',
    channelStore,
    clock: () => new Date('2026-05-19T00:00:00.000Z'),
    eventsWriter: eventsWriter as unknown as never,
    idGenerator: () => `del-${++idCounter}`,
    projectRoot: '/tmp/test',
  })
  return {channelStore, eventsWriter, service}
}

const beginArgs = (overrides: Partial<{
  channelId: string
  senderPinState: 'auto-tofu' | 'ca-bound' | 'user-confirmed'
  turnId: string
}> = {}) => ({
  channelId: overrides.channelId ?? 'channel-1',
  prompt: [{text: 'hello', type: 'text' as const}] as const,
  senderDisplayHandle: '@alice',
  senderPeerId: '12D3KooWAlice',
  senderPinState: overrides.senderPinState ?? ('user-confirmed' as const),
  turnId: overrides.turnId ?? 'turn-1',
})

describe('BridgeTranscriptService (slice 9.4e — kimi round-1 LOW-11)', () => {
  describe('auto-provision policy gate', () => {
    it('policy=auto declines auto-tofu sender when channel does not yet exist (9.5.4 auto-create trust gate)', async () => {
      // Phase 9.5.4: auto-create of a NEW channel requires user-confirmed/ca-bound
      // even under policy=auto. auto-tofu senders are declined on new-channel creation.
      const {service} = buildService({autoProvisionPolicy: 'auto'})
      const r = await service.beginTurn(beginArgs({senderPinState: 'auto-tofu'}))
      expect(r.accepted).to.equal(false)
    })

    it('policy=auto accepts user-confirmed sender', async () => {
      const {service} = buildService({autoProvisionPolicy: 'auto'})
      const r = await service.beginTurn(beginArgs({senderPinState: 'user-confirmed'}))
      expect(r.accepted).to.equal(true)
    })

    it('policy=auto accepts ca-bound sender', async () => {
      const {service} = buildService({autoProvisionPolicy: 'auto'})
      const r = await service.beginTurn(beginArgs({senderPinState: 'ca-bound'}))
      expect(r.accepted).to.equal(true)
    })

    it('policy=pinned-only rejects auto-tofu (first-contact) sender', async () => {
      const {service} = buildService({autoProvisionPolicy: 'pinned-only'})
      const r = await service.beginTurn(beginArgs({senderPinState: 'auto-tofu'}))
      expect(r.accepted).to.equal(false)
      if (r.accepted === false) {
        expect(r.reason).to.include('pinned-only')
        expect(r.reason).to.include('auto-tofu')
      }
    })

    it('policy=pinned-only accepts user-confirmed sender', async () => {
      const {service} = buildService({autoProvisionPolicy: 'pinned-only'})
      const r = await service.beginTurn(beginArgs({senderPinState: 'user-confirmed'}))
      expect(r.accepted).to.equal(true)
    })

    it('policy=pinned-only accepts ca-bound sender', async () => {
      const {service} = buildService({autoProvisionPolicy: 'pinned-only'})
      const r = await service.beginTurn(beginArgs({senderPinState: 'ca-bound'}))
      expect(r.accepted).to.equal(true)
    })

    it('policy=deny rejects every pin state', async () => {
      const pins = ['auto-tofu', 'user-confirmed', 'ca-bound'] as const
      const results = await Promise.all(
        pins.map(async (pin) => {
          const {service} = buildService({autoProvisionPolicy: 'deny'})
          return {pin, result: await service.beginTurn(beginArgs({senderPinState: pin}))}
        }),
      )
      for (const {pin, result} of results) {
        expect(result.accepted).to.equal(false, `policy=deny should reject pin_state=${pin}`)
      }
    })
  })

  describe('ensureChannelMeta', () => {
    it('auto-creates channel meta on first contact with sender as a remote-peer member', async () => {
      const {channelStore, service} = buildService()
      await service.beginTurn(beginArgs())
      expect(channelStore.createdChannels).to.have.length(1)
      const created = channelStore.createdChannels[0]
      expect(created.channelId).to.equal('channel-1')
      expect(created.members).to.have.length(1)
      const m = created.members[0] as {memberKind: string; multiaddr?: string; peerId: string; remoteL2PubKey?: string;}
      expect(m.memberKind).to.equal('remote-peer')
      expect(m.peerId).to.equal('12D3KooWAlice')
      // kimi MED-5 — these fields MUST be omitted, not seeded with sentinels.
      expect(m.remoteL2PubKey).to.equal(undefined)
      expect(m.multiaddr).to.equal(undefined)
    })

    it('is idempotent when the sender is already a channel member', async () => {
      const {channelStore, service} = buildService()
      await service.beginTurn(beginArgs())
      // Re-begin with same sender; should NOT add a duplicate member.
      await service.beginTurn(beginArgs({turnId: 'turn-2'}))
      const meta = channelStore.metaByChannel.get('channel-1')!
      expect(meta.members).to.have.length(1)
    })
  })

  describe('seq monotonicity', () => {
    it('beginTurn writes the inbound message at seq=1; recordChunk allocates 2,3,…', async () => {
      const {eventsWriter, service} = buildService()
      const begin = await service.beginTurn(beginArgs())
      expect(begin.accepted).to.equal(true)
      if (!begin.accepted) return
      await service.recordChunk({
        channelId: 'channel-1',
        chunk: {content: 'chunk-A', kind: 'agent_message_chunk'},
        deliveryId: begin.deliveryId,
        memberHandle: begin.mirrorHandle,
        turnId: 'turn-1',
      })
      await service.recordChunk({
        channelId: 'channel-1',
        chunk: {content: 'chunk-B', kind: 'agent_message_chunk'},
        deliveryId: begin.deliveryId,
        memberHandle: begin.mirrorHandle,
        turnId: 'turn-1',
      })
      const seqs = eventsWriter.appended.map((e) => e.seq)
      expect(seqs).to.deep.equal([1, 2, 3])
    })
  })

  describe('finaliseTurn', () => {
    it('writes the delivery_state_change + turn_state_change events and the Turn/Delivery snapshots', async () => {
      const {channelStore, eventsWriter, service} = buildService()
      const begin = await service.beginTurn(beginArgs())
      if (!begin.accepted) throw new Error('precondition failed')
      await service.finaliseTurn({
        channelId: 'channel-1',
        deliveryId: begin.deliveryId,
        endedState: 'completed',
        memberHandle: begin.mirrorHandle,
        turnId: 'turn-1',
      })

      const kinds = eventsWriter.appended.map((e) => e.kind)
      expect(kinds).to.deep.equal(['message', 'delivery_state_change', 'turn_state_change'])
      expect(channelStore.turnSnapshots).to.have.length(1)
      expect(channelStore.turnSnapshots[0].state).to.equal('completed')
      expect(channelStore.turnSnapshots[0].author.kind).to.equal('remote-peer')
      expect(channelStore.deliverySnapshots).to.have.length(1)
      expect(channelStore.deliverySnapshots[0].state).to.equal('completed')
      expect(channelStore.closedTranscripts).to.have.length(1)
    })

    it('maps endedState=errored to Turn.state=cancelled and persists errorCode/errorMessage on the delivery snapshot', async () => {
      const {channelStore, service} = buildService()
      const begin = await service.beginTurn(beginArgs())
      if (!begin.accepted) throw new Error('precondition failed')
      await service.finaliseTurn({
        channelId: 'channel-1',
        deliveryId: begin.deliveryId,
        endedState: 'errored',
        error: {code: 'TEST_ERROR', message: 'safe public msg'},
        memberHandle: begin.mirrorHandle,
        turnId: 'turn-1',
      })
      // Turn type only supports completed|cancelled, so errored projects
      // to cancelled but the failure information is preserved on the
      // delivery snapshot which DOES support 'errored' as a state.
      expect(channelStore.turnSnapshots[0].state).to.equal('cancelled')
      expect(channelStore.deliverySnapshots[0].state).to.equal('errored')
      expect(channelStore.deliverySnapshots[0].errorCode).to.equal('TEST_ERROR')
      expect(channelStore.deliverySnapshots[0].errorMessage).to.equal('safe public msg')
    })

    it('releases inFlight + seqByTurn entries after finaliseTurn (kimi round-2 LOW: no per-turn leak)', async () => {
      const {service} = buildService()
      const begin = await service.beginTurn(beginArgs())
      if (!begin.accepted) throw new Error('precondition failed')
      expect(service.inFlightTurnCount()).to.equal(1)
      await service.finaliseTurn({
        channelId: 'channel-1',
        deliveryId: begin.deliveryId,
        endedState: 'completed',
        memberHandle: begin.mirrorHandle,
        turnId: 'turn-1',
      })
      expect(service.inFlightTurnCount()).to.equal(0)
    })

    it('still calls closeTranscriptStream when finaliseTurn runs without a prior beginTurn (defensive cleanup path)', async () => {
      const {channelStore, service} = buildService()
      // Simulate the catch-block-of-the-catch-block path: a delivery
      // id we never registered. The service should still write the
      // terminal events + close the stream so it doesn't leak the
      // file descriptor.
      await service.finaliseTurn({
        channelId: 'channel-zzz',
        deliveryId: 'del-orphan',
        endedState: 'errored',
        error: {code: 'GENERATOR_ERROR', message: 'orphan'},
        memberHandle: '@whoever',
        turnId: 'turn-orphan',
      })
      expect(channelStore.closedTranscripts).to.have.length(1)
      // No inFlight entry → no Turn/Delivery snapshots written.
      expect(channelStore.turnSnapshots).to.have.length(0)
      expect(channelStore.deliverySnapshots).to.have.length(0)
    })
  })
})
