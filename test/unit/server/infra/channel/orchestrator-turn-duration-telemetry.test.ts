import {expect} from 'chai'

import type {
  AddDriftObservationArgs,
  IProfileMetadataStore,
  ProfileMetadataRecord,
  RecordTurnDurationArgs,
  SetLastProbeErrorArgs,
} from '../../../../../src/server/infra/channel/profile-metadata-store.js'

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

// Phase 10 Tier C #4 (V6 run-4 §4b) — orchestrator records each
// completed delivery's wall-clock duration into the profile metadata
// store, keyed by the member's `agentName`. Failures must not break
// the terminal path.

class StubProfileMetadataStore implements IProfileMetadataStore {
  public readonly calls: RecordTurnDurationArgs[] = []

  async addDriftObservation(_args: AddDriftObservationArgs): Promise<void> {}

  async clearDriftObservations(_name: string): Promise<void> {}

  async clearLastProbeError(_name: string): Promise<void> {}

  async get(_name: string): Promise<ProfileMetadataRecord | undefined> {
    return undefined
  }

  async recordTurnDuration(args: RecordTurnDurationArgs): Promise<void> {
    this.calls.push(args)
  }

  async setLastProbeError(_args: SetLastProbeErrorArgs): Promise<void> {}
}

describe('ChannelOrchestrator (turn-duration telemetry)', () => {
  let projectRoot: string
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  let metaStore: StubProfileMetadataStore
  let nextDriver: MockAcpDriver | undefined
  let nowMs: number
  const channelId = 'tlm-test'
  const channelStarted = Date.parse('2026-05-18T12:00:00.000Z')

  const broadcaster = {
    broadcastToChannel(_channelId: string, _event: string, _payload: unknown) {},
  }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    nowMs = channelStarted
    const serializer = new ChannelWriteSerializer()
    const store = new ChannelStore({
      eventsWriter: new ChannelEventsWriter({serializer}),
      snapshotWriter: new ChannelSnapshotWriter({eventsWriter: new ChannelEventsWriter({serializer: new ChannelWriteSerializer()})}),
      treeReader: new ChannelTreeReader(),
      writeSerializer: serializer,
    })
    pool = new AcpDriverPool()
    broker = new PermissionBroker()
    metaStore = new StubProfileMetadataStore()
    nextDriver = undefined

    let idCounter = 0
    const idGenerator = () => `id-${++idCounter}`

    const seqAllocator = new TurnSequenceAllocator()
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
      clock: () => new Date(nowMs),
      driverFactory(_invocation, handle) {
        return nextDriver ?? new MockAcpDriver({events: [], handle})
      },
      idGenerator,
      permissionBroker: broker,
      pool,
      profileMetadataStore: metaStore,
      seqAllocator,
      store,
    })

    await orchestrator.createChannel({channelId, projectRoot})
    await orchestrator.inviteMember({
      channelId,
      handle: '@pi',
      invocation: {args: [], command: 'noop', cwd: projectRoot},
      projectRoot,
    })
  })

  afterEach(async () => {
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  const dispatchAndWait = async (prompt: string): Promise<void> => {
    const driver = new MockAcpDriver({
      events: [{content: 'reply', kind: 'agent_message_chunk'}],
      handle: '@pi',
    })
    nextDriver = driver
    await orchestrator.inviteMember({
      channelId,
      handle: '@pi',
      invocation: {args: [], command: 'noop', cwd: projectRoot},
      projectRoot,
    })
    await orchestrator.dispatchMention({
      channelId,
      mentions: ['@pi'],
      projectRoot,
      prompt,
    })
    // Let the background streaming task settle (matches the
    // ~150ms wait used by other Phase-2 tests).
    await new Promise((r) => {
      setTimeout(r, 150)
    })
  }

  it('records a completed delivery into the profile metadata store keyed by agentName', async () => {
    // Advance clock by 1500ms before the turn completes so durationMs
    // is observable.
    nowMs = channelStarted + 1500
    await dispatchAndWait('hello pi')

    expect(metaStore.calls.length).to.be.greaterThan(0)
    const call = metaStore.calls[0]
    expect(call.name).to.equal('@pi')
    expect(call.endedState).to.equal('completed')
    expect(call.durationMs).to.be.a('number')
    expect(call.durationMs).to.be.greaterThanOrEqual(0)
    expect(call.completedAt).to.be.a('string')
  })
})
