import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import {ChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {AcpDriverPool} from '../../../../../src/server/infra/channel/drivers/acp-driver-pool.js'
import {CancelCoordinator} from '../../../../../src/server/infra/channel/drivers/cancel-coordinator.js'
import {MockAcpDriver} from '../../../../../src/server/infra/channel/drivers/mock-driver.js'
import {PermissionBroker} from '../../../../../src/server/infra/channel/drivers/permission-broker.js'
import {DEFAULT_IDEMPOTENCY_BUCKET_MS} from '../../../../../src/server/infra/channel/idempotency-key.js'
import {ChannelOrchestrator} from '../../../../../src/server/infra/channel/orchestrator.js'
import {ChannelEventsWriter} from '../../../../../src/server/infra/channel/storage/events-writer.js'
import {ChannelSnapshotWriter} from '../../../../../src/server/infra/channel/storage/snapshot-writer.js'
import {ChannelTreeReader} from '../../../../../src/server/infra/channel/storage/tree-reader.js'
import {TurnSequenceAllocator} from '../../../../../src/server/infra/channel/storage/turn-sequence-allocator.js'
import {ChannelWriteSerializer} from '../../../../../src/server/infra/channel/storage/write-serializer.js'
import {ChannelEvents} from '../../../../../src/shared/transport/events/channel-events.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Phase 10 Tier C #2 (V6 run-4 §4a) — `dispatchMention` auto-derives an
// idempotency key from (channelId | canonical prompt | sorted mentions |
// 5-min bucket) when the caller doesn't supply one, and collapses
// duplicate dispatches inside the same bucket onto the original turn.

describe('ChannelOrchestrator (auto-idempotency)', () => {
  let projectRoot: string
  let store: ChannelStore
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  let broadcasts: Array<{channelId: string; event: string; payload: unknown}>
  let driversCreated: MockAcpDriver[]
  let nextDriver: MockAcpDriver | undefined
  let sandbox: SinonSandbox
  let nowMs: number
  const channelId = 'pi-test'

  const broadcaster = {
    broadcastToChannel(channelId: string, event: string, payload: unknown) {
      broadcasts.push({channelId, event, payload})
    },
  }

  beforeEach(async () => {
    sandbox = createSandbox()
    projectRoot = await makeTempContextTree()
    nowMs = Date.parse('2026-05-18T12:00:00.000Z')
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
    driversCreated = []
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
        const driver = nextDriver ?? new MockAcpDriver({events: [], handle})
        driversCreated.push(driver)
        return driver
      },
      idGenerator,
      permissionBroker: broker,
      pool,
      seqAllocator,
      store,
    })

    await orchestrator.createChannel({channelId, projectRoot})
    await orchestrator.inviteMember({
      channelId,
      handle: '@mock',
      invocation: {args: [], command: 'noop', cwd: projectRoot},
      projectRoot,
    })
  })

  afterEach(async () => {
    sandbox.restore()
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  const dispatch = async (prompt: string): Promise<string> => {
    const result = await orchestrator.dispatchMention({
      channelId,
      mentions: ['@mock'],
      projectRoot,
      prompt,
    })
    return result.turn.turnId
  }

  it('collapses a duplicate identical dispatch onto the original turnId', async () => {
    const firstTurnId = await dispatch('hello world')
    const secondTurnId = await dispatch('hello world')
    expect(secondTurnId).to.equal(firstTurnId)
  })

  it('creates a distinct turn when the prompt differs', async () => {
    const firstTurnId = await dispatch('hello world')
    const secondTurnId = await dispatch('different prompt')
    expect(secondTurnId).to.not.equal(firstTurnId)
  })

  it('creates a distinct turn after the bucket window advances', async () => {
    const firstTurnId = await dispatch('hello world')
    nowMs += DEFAULT_IDEMPOTENCY_BUCKET_MS * 2
    const secondTurnId = await dispatch('hello world')
    expect(secondTurnId).to.not.equal(firstTurnId)
  })

  it('honours an explicit idempotencyKey (different keys → different turns)', async () => {
    const first = await orchestrator.dispatchMention({
      channelId,
      idempotencyKey: 'explicit-a',
      mentions: ['@mock'],
      projectRoot,
      prompt: 'hello world',
    })
    const second = await orchestrator.dispatchMention({
      channelId,
      idempotencyKey: 'explicit-b',
      mentions: ['@mock'],
      projectRoot,
      prompt: 'hello world',
    })
    expect(second.turn.turnId).to.not.equal(first.turn.turnId)
  })

  it('collapses two dispatches sharing the same explicit idempotencyKey', async () => {
    const first = await orchestrator.dispatchMention({
      channelId,
      idempotencyKey: 'same-key',
      mentions: ['@mock'],
      projectRoot,
      prompt: 'hello world',
    })
    const second = await orchestrator.dispatchMention({
      channelId,
      idempotencyKey: 'same-key',
      mentions: ['@mock'],
      projectRoot,
      prompt: 'different prompt entirely',
    })
    expect(second.turn.turnId).to.equal(first.turn.turnId)
  })

  it('persists the auto-derived idempotencyKey on the returned turn', async () => {
    const result = await orchestrator.dispatchMention({
      channelId,
      mentions: ['@mock'],
      projectRoot,
      prompt: 'hello world',
    })
    expect(result.turn.idempotencyKey).to.be.a('string')
    expect(result.turn.idempotencyKey).to.match(/^[\da-f]{64}$/)
  })

  it('does NOT emit a fresh user message when collapsing a duplicate', async () => {
    await dispatch('hello world')
    const broadcastsBeforeDup = broadcasts.length
    await dispatch('hello world')
    const newBroadcasts = broadcasts.slice(broadcastsBeforeDup)
    expect(newBroadcasts.length).to.equal(0)
  })
})
