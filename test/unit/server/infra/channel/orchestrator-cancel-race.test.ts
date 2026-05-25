import {expect} from 'chai'

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

 
const noop = (): void => {}

// Post-merge review item #1: cancelTurn vs maybeFinaliseTurn race.
//
// Scenario: cancelTurn flips `active.cancelling = true` synchronously,
// then awaits cancelCoordinator.cancelTurn(). The state mutation
// `active.turn.state = 'cancelled'` happens AFTER that await. During
// the await, a background streaming task can finish its delivery and
// call maybeFinaliseTurn, which previously only checked
// `active.turn.state === 'dispatched'` — NOT `active.cancelling` — and
// would race to emit `turn_state_change dispatched → completed` AFTER
// the coordinator has already started emitting cancel events.
//
// This test parks a permission_request on one delivery, calls cancelTurn
// with a coordinator that releases on a controlled signal, and verifies
// the final transcript has exactly one terminal turn_state_change.

describe('ChannelOrchestrator — cancelTurn vs maybeFinaliseTurn race (review #1)', () => {
  let projectRoot: string
  let store: ChannelStore
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  let releaseCancelCoordinator: () => void
  let broadcasts: TurnEvent[]
  const channelId = 'pi-test'

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
      broadcastToChannel(_id: string, event: string, payload: unknown): void {
        if (event === ChannelEvents.TURN_EVENT) {
          broadcasts.push((payload as {event: TurnEvent}).event)
        }
      },
    }

    const realCoordinator = new CancelCoordinator({
      broker,
      pool,
      seqAllocator,
      async writeEvent(event, ctx) {
        await store.appendTurnEvent({channelId: ctx.channelId, event, projectRoot: ctx.projectRoot, turnId: ctx.turnId})
        broadcaster.broadcastToChannel(ctx.channelId, ChannelEvents.TURN_EVENT, {channelId: ctx.channelId, event})
      },
    })
     
    let releaseResolve: () => void = noop
    const releaseGate = new Promise<void>((r) => {
      releaseResolve = r
    })
    releaseCancelCoordinator = releaseResolve
    const cancelCoordinator: typeof realCoordinator = Object.create(realCoordinator) as typeof realCoordinator
    Object.assign(cancelCoordinator, {
      async cancelTurn(args: Parameters<typeof realCoordinator.cancelTurn>[0]) {
        await releaseGate
        return realCoordinator.cancelTurn(args)
      },
    })

    // Driver yields a permission_request that parks until cancel() resolves
    // it. Critically: the mock-driver's iterator returns AFTER the
    // permission gate releases, so the background streaming task races to
    // call maybeFinaliseTurn during cancelTurn's await on the coordinator.
    const mockDriver = new MockAcpDriver({
      events: [
        {
          kind: 'permission_request',
          permissionRequestId: 'p-race',
          request: {
            options: [{kind: 'allow_once', name: 'Allow', optionId: 'allow'}],
            sessionId: 's',
            toolCall: {toolCallId: 'tc-1'},
          },
        },
      ],
      handle: '@a',
    })
    await mockDriver.start()
    pool.register({channelId, driver: mockDriver})

    orchestrator = new ChannelOrchestrator({
      broadcaster,
      cancelCoordinator,
      clock: () => new Date('2026-05-12T11:00:00.000Z'),
      driverFactory: (_invocation, handle) => new MockAcpDriver({events: [], handle}),
      idGenerator,
      permissionBroker: broker,
      pool,
      seqAllocator,
      store,
    })

    await seedChannel({channelId, members: [{handle: '@a'}], projectRoot, settings: undefined, store})
  })

  afterEach(async () => {
    releaseCancelCoordinator()
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  it('does NOT emit turn_state_change → completed when cancelTurn is in flight', async () => {
    const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@a hello'})

    // Wait for the background task to reach `awaiting_permission` (parked).
    await new Promise((r) => {
      setTimeout(r, 50)
    })

    // Kick cancelTurn — its await blocks on the gate.
    const cancelPromise = orchestrator.cancelTurn({channelId, projectRoot, turnId: accepted.turn.turnId})

    // Open the race window. With the bug, maybeFinaliseTurn would fire here
    // after the broker's drainTurn resolves the parked permission (which
    // happens inside cancelCoordinator.cancelTurn — but the gate is holding
    // that). With the fix, even if the background task did somehow complete
    // during the await, it would bail because `cancelling === true`.
    await new Promise((r) => {
      setTimeout(r, 25)
    })

    releaseCancelCoordinator()
    await cancelPromise
    await new Promise((r) => {
      setTimeout(r, 25)
    })

    // Filter to TERMINAL transitions only (ignoring the initial
    // pending → dispatched). The bug would emit both `dispatched → completed`
    // and `dispatched → cancelled`; the fix should leave exactly one.
    const terminalTurnStateChanges = broadcasts.filter(
      (e): e is Extract<TurnEvent, {kind: 'turn_state_change'}> =>
        e.kind === 'turn_state_change' && (e.to === 'completed' || e.to === 'cancelled'),
    )

    expect(
      terminalTurnStateChanges,
      'expected exactly one terminal turn_state_change',
    ).to.have.lengthOf(1)
    expect(terminalTurnStateChanges[0].to).to.equal('cancelled')
  })

  it('maybeFinaliseTurn guard: turn dispatched + cancelling=true → no completed event emitted', async () => {
    const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@a hello'})

    // Wait for awaiting_permission state.
    await new Promise((r) => {
      setTimeout(r, 50)
    })

    // Look up the in-memory active-turn entry and flip cancelling=true
    // manually. This simulates the synchronous flip that cancelTurn makes
    // BEFORE awaiting the coordinator — but without entering the cancel
    // codepath, so any subsequent maybeFinaliseTurn call is purely
    // gated by the new `active.cancelling` guard.
    const {activeTurns} = (orchestrator as unknown as {activeTurns: Map<string, {cancelling: boolean}>})
    const active = activeTurns.get(accepted.turn.turnId)
    expect(active, 'orchestrator should be tracking the active turn').to.not.equal(undefined)
    active!.cancelling = true

    // Resolve the parked permission via the broker so the background task
    // can complete the delivery and reach the maybeFinaliseTurn call site.
    await orchestrator.permissionDecision({
      channelId,
      outcome: {optionId: 'allow', outcome: 'selected'},
      permissionRequestId: 'p-race',
      projectRoot,
      turnId: accepted.turn.turnId,
    })

    // Drain background task.
    await new Promise((r) => {
      setTimeout(r, 75)
    })

    const completedEvent = broadcasts.find(
      (e): e is Extract<TurnEvent, {kind: 'turn_state_change'}> =>
        e.kind === 'turn_state_change' && e.to === 'completed',
    )
    expect(completedEvent, 'maybeFinaliseTurn must bail when cancelling=true').to.equal(undefined)

    // The turn should remain in `activeTurns` (the cancellation flow,
    // which would normally remove it, never ran).
    expect(activeTurns.has(accepted.turn.turnId)).to.equal(true)
  })
})

const seedChannel = async (args: {
  channelId: string
  members: Array<{handle: string}>
  projectRoot: string
  settings: ChannelMeta['settings']
  store: ChannelStore
}): Promise<void> => {
  await args.store.createChannel({
    meta: {
      channelId: args.channelId,
      createdAt: '2026-05-12T11:00:00.000Z',
      members: args.members.map((m) => ({
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
      settings: args.settings,
      updatedAt: '2026-05-12T11:00:00.000Z',
    },
    projectRoot: args.projectRoot,
  })
}
