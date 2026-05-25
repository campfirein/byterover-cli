import {expect} from 'chai'
import {createSandbox, type SinonSandbox} from 'sinon'

import type {TurnEvent} from '../../../../../src/shared/types/channel.js'

import {
  AcpHandshakeFailedError,
  ChannelInvalidRequestError,
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
import {ChannelEvents} from '../../../../../src/shared/transport/events/channel-events.js'
import {makeTempContextTree} from '../../../../helpers/temp-context-tree.js'
import {removeTempDir} from '../../../../helpers/temp-dir.js'

// Slice 2.4 — Phase-2 orchestrator extensions: inviteMember, uninviteMember,
// dispatchMention, cancelTurn, permissionDecision. The orchestrator wires
// the Slice 2.0/2.2/2.3 helpers + pool + broker + cancel coordinator into
// the active-dispatch lifecycle described in IMPLEMENTATION_PHASE_2.md §2.4.

describe('ChannelOrchestrator (Phase 2)', () => {
  let projectRoot: string
  let store: ChannelStore
  let orchestrator: ChannelOrchestrator
  let pool: AcpDriverPool
  let broker: PermissionBroker
  let broadcasts: Array<{channelId: string; event: string; payload: unknown}>
  let driversCreated: MockAcpDriver[]
  let nextDriverConfig: MockAcpDriver['protocolVersion'] | undefined
  let nextDriver: MockAcpDriver | undefined
  let sandbox: SinonSandbox
  const channelId = 'pi-test'

  const broadcaster = {
    broadcastToChannel(channelId: string, event: string, payload: unknown) {
      broadcasts.push({channelId, event, payload})
    },
  }

  beforeEach(async () => {
    sandbox = createSandbox()
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
    driversCreated = []
    nextDriverConfig = undefined
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
      clock: () => new Date('2026-05-11T00:00:00.000Z'),
      driverFactory(_invocation, handle) {
        const driver = nextDriver ?? new MockAcpDriver({events: [], handle, protocolVersion: nextDriverConfig})
        driversCreated.push(driver)
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
    sandbox.restore()
    await pool.releaseAll()
    await removeTempDir(projectRoot)
  })

  const createChannel = async (): Promise<void> => {
    await orchestrator.createChannel({channelId, projectRoot})
  }

  const invite = async (handle = '@mock'): Promise<void> => {
    await orchestrator.inviteMember({
      channelId,
      handle,
      invocation: {args: [], command: 'noop', cwd: projectRoot},
      projectRoot,
    })
  }

  describe('inviteMember', () => {
    it('spawns + starts the driver, persists the member, returns a ChannelMember', async () => {
      await createChannel()
      const member = await orchestrator.inviteMember({
        channelId,
        handle: '@mock',
        invocation: {args: [], command: 'noop', cwd: projectRoot},
        projectRoot,
      })

      expect(member.handle).to.equal('@mock')
      expect(member.memberKind).to.equal('acp-agent')
      if (member.memberKind !== 'acp-agent') throw new Error('unreachable')
      expect(member.driverClass).to.equal('C-prime')
      expect(driversCreated).to.have.lengthOf(1)
      expect(pool.acquire({channelId, memberHandle: '@mock'})).to.equal(driversCreated[0])

      // Member persisted to meta.json.
      const meta = await store.readChannelMeta({channelId, projectRoot})
      expect(meta?.members).to.have.lengthOf(1)

      // member-update broadcast.
      expect(
        broadcasts.some(
          (b) => b.event === ChannelEvents.MEMBER_UPDATE && (b.payload as {op: string}).op === 'added',
        ),
      ).to.equal(true)
    })

    it('rejects profileName with CHANNEL_INVALID_REQUEST (Phase 3 introduces the registry)', async () => {
      await createChannel()
      try {
        await orchestrator.inviteMember({
          channelId,
          handle: '@mock',
          profileName: 'some-profile',
          projectRoot,
        })
        expect.fail('expected ChannelInvalidRequestError')
      } catch (error) {
        expect(error).to.be.instanceOf(ChannelInvalidRequestError)
      }
    })

    it('throws AcpHandshakeFailedError and does NOT persist a member when start() fails', async () => {
      await createChannel()
      const badDriver = new MockAcpDriver({events: [], handle: '@bad'})
      sandbox.stub(badDriver, 'start').rejects(new AcpHandshakeFailedError('@bad', 'boom'))
      nextDriver = badDriver

      try {
        await orchestrator.inviteMember({
          channelId,
          handle: '@bad',
          invocation: {args: [], command: 'noop', cwd: projectRoot},
          projectRoot,
        })
        expect.fail('expected AcpHandshakeFailedError')
      } catch (error) {
        expect(error).to.be.instanceOf(AcpHandshakeFailedError)
      }

      const meta = await store.readChannelMeta({channelId, projectRoot})
      expect(meta?.members).to.deep.equal([])
    })
  })

  describe('dispatchMention', () => {
    it('emits seq-0 user message, dispatched state, returns synchronously, streams in background', async () => {
      await createChannel()
      const driver = new MockAcpDriver({
        events: [
          {content: 'reply chunk', kind: 'agent_message_chunk'},
        ],
        handle: '@mock',
      })
      nextDriver = driver
      await invite('@mock')

      const accepted = await orchestrator.dispatchMention({
        channelId,
        projectRoot,
        prompt: '@mock hello',
      })

      // Synchronous return: turn is `dispatched`, delivery is `dispatched`.
      expect(accepted.turn.state).to.equal('dispatched')
      expect(accepted.deliveries).to.have.lengthOf(1)
      expect(accepted.deliveries[0].state).to.equal('dispatched')

      // events.jsonl received: seq-0 message, then turn_state_change pending→dispatched,
      // then delivery_state_change queued→dispatched.
      const {turnId} = accepted.turn
      const treeReader = new ChannelTreeReader()
      const events = await treeReader.readEvents({channelId, projectRoot, turnId})
      expect(events.length).to.be.greaterThan(2)
      expect(events[0].kind).to.equal('message')
      expect(events[0].seq).to.equal(0)
      expect(events[1].kind).to.equal('turn_state_change')
      expect((events[1] as {to: string}).to).to.equal('dispatched')
      expect(events[2].kind).to.equal('delivery_state_change')
      expect((events[2] as {to: string}).to).to.equal('dispatched')

      // Wait for the background task to complete.
      await new Promise((r) => {
        setTimeout(r, 100)
      })
      const finalEvents = await treeReader.readEvents({channelId, projectRoot, turnId})
      expect(finalEvents.some((e) => e.kind === 'agent_message_chunk')).to.equal(true)
      expect(finalEvents.some((e) => e.kind === 'turn_state_change' && (e as Extract<TurnEvent, {kind: 'turn_state_change'}>).to === 'completed')).to.equal(true)
    })

    it('Phase-3 fan-out: two mentions both dispatch immediately by default', async () => {
      await createChannel()
      await invite('@a')
      await invite('@b')

      const result = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@a @b ping'})
      expect(result.deliveries).to.have.lengthOf(2)
      expect(result.deliveries.every((d) => d.state === 'dispatched')).to.equal(true)

      // Drain background streaming so the tempdir cleanup does not race.
      await new Promise((r) => {
        setTimeout(r, 150)
      })
    })

    it('Phase 10 D1: strictMentions=true ignores @-handles in the prompt body', async () => {
      // V6 super-mario E2E retest defect: dispatchOne passed
      // `mentions: [@kimi]` but the prompt body had "@kimi @codex review …",
      // so the orchestrator unioned both and dispatched a 2-delivery turn.
      // With strictMentions=true the prompt @-handles MUST be ignored.
      await createChannel()
      await invite('@a')
      await invite('@b')

      const result = await orchestrator.dispatchMention({
        channelId,
        mentions: ['@a'],
        projectRoot,
        prompt: '@a @b please review',
        strictMentions: true,
      })

      expect(result.deliveries, 'strictMentions must NOT union with prompt @-handles').to.have.lengthOf(1)
      expect(result.deliveries[0].memberHandle).to.equal('@a')

      // Drain background streaming so the tempdir cleanup does not race.
      await new Promise((r) => {
        setTimeout(r, 150)
      })
    })

    it('Phase 10 D1: default behaviour (no strictMentions) still unions prompt + explicit mentions', async () => {
      // Regression guard: existing Phase 1–9 callers MUST keep the
      // union behaviour. Only the dispatchOne path opts into strict.
      await createChannel()
      await invite('@a')
      await invite('@b')

      const result = await orchestrator.dispatchMention({
        channelId,
        mentions: ['@a'],
        projectRoot,
        prompt: '@a @b please review',
      })

      expect(result.deliveries.map(d => d.memberHandle).sort(), 'default must union prompt @-handles with explicit list').to.deep.equal(['@a', '@b'])

      await new Promise((r) => {
        setTimeout(r, 150)
      })
    })

    it('rejects an empty mention list with CHANNEL_MENTION_EMPTY', async () => {
      await createChannel()
      await invite('@mock')

      try {
        await orchestrator.dispatchMention({channelId, projectRoot, prompt: 'hello (no mentions)'})
        expect.fail('expected ChannelMentionEmptyError')
      } catch (error) {
        expect((error as Error).message).to.match(/no resolvable mentions/i)
      }
    })
  })

  describe('permissionDecision', () => {
    it('routes the decision through the broker and emits awaiting_permission → streaming', async () => {
      await createChannel()
      const driver = new MockAcpDriver({
        events: [
          {
            kind: 'permission_request',
            permissionRequestId: 'p-1',
            request: {
              options: [{kind: 'allow_once', name: 'Allow', optionId: 'opt-allow'}],
              sessionId: 's',
              toolCall: {toolCallId: 'tc-1'},
            },
          },
          {content: 'after permission', kind: 'agent_message_chunk'},
        ],
        handle: '@mock',
      })
      nextDriver = driver
      await invite('@mock')

      const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@mock do thing'})
      const {turnId} = accepted.turn

      // Wait for the permission_request event to land in events.jsonl.
      const treeReader = new ChannelTreeReader()
      const deadline = Date.now() + 5000
      let permissionRequestId: string | undefined
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const events = await treeReader.readEvents({channelId, projectRoot, turnId})
        const found = events.find((e): e is Extract<TurnEvent, {kind: 'permission_request'}> => e.kind === 'permission_request')
        if (found !== undefined) {
          permissionRequestId = found.permissionRequestId
          break
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, 20)
        })
      }

      expect(permissionRequestId, 'permission_request event must appear in events.jsonl').to.not.equal(undefined)

      await orchestrator.permissionDecision({
        channelId,
        outcome: {optionId: 'opt-allow', outcome: 'selected'},
        permissionRequestId: permissionRequestId!,
        projectRoot,
        turnId,
      })

      // Wait for completion.
      const completionDeadline = Date.now() + 5000
      let completed = false
      while (Date.now() < completionDeadline) {
        // eslint-disable-next-line no-await-in-loop
        const events = await treeReader.readEvents({channelId, projectRoot, turnId})
        if (events.some((e) => e.kind === 'turn_state_change' && (e as Extract<TurnEvent, {kind: 'turn_state_change'}>).to === 'completed')) {
          completed = true
          break
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, 20)
        })
      }

      expect(completed, 'turn must reach completed state after permission resolves').to.equal(true)

      const events = await treeReader.readEvents({channelId, projectRoot, turnId})
      const transitions = events.filter((e) => e.kind === 'delivery_state_change').map((e) => `${(e as Extract<TurnEvent, {kind: 'delivery_state_change'}>).from}→${(e as Extract<TurnEvent, {kind: 'delivery_state_change'}>).to}`)
      expect(transitions).to.include('streaming→awaiting_permission')
      expect(transitions).to.include('awaiting_permission→streaming')
      expect(transitions).to.include('streaming→completed')
    })
  })

  describe('Phase 10 Tier B2: auto-approve empty-oldText Edit on sandboxed project files', () => {
    it('auto-approves empty-oldText Edit, skips awaiting_permission transition, emits permission_decision', async () => {
      // V6 run-2/run-3 §3b — codex re-writes its own file via Edit with
      // oldText="". Without B2 this gates the gather for 15min. With B2
      // the orchestrator auto-approves immediately.
      await createChannel()
      const driver = new MockAcpDriver({
        events: [
          {
            kind: 'permission_request',
            permissionRequestId: 'p-autoapprove',
            request: {
              options: [
                {kind: 'allow_once', name: 'Allow', optionId: 'opt-allow'},
                {kind: 'reject_once', name: 'Reject', optionId: 'opt-reject'},
              ],
              sessionId: 's',
              toolCall: {
                content: [{
                  newText: 'console.log("rewrite")\n',
                  oldText: '',
                  path: `${projectRoot}/engine.js`,
                  type: 'diff',
                }],
                kind: 'edit',
                toolCallId: 'tc-edit',
              },
            },
          },
          {content: 'after auto-approve', kind: 'agent_message_chunk'},
        ],
        handle: '@mock',
      })
      nextDriver = driver
      await invite('@mock')

      const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@mock rewrite engine.js'})
      const {turnId} = accepted.turn

      // Wait for completion — turn should reach 'completed' WITHOUT any
      // permissionDecision call from the test (auto-approval handled it).
      const treeReader = new ChannelTreeReader()
      const deadline = Date.now() + 5000
      let completed = false
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const events = await treeReader.readEvents({channelId, projectRoot, turnId})
        if (events.some((e) => e.kind === 'turn_state_change' && (e as Extract<TurnEvent, {kind: 'turn_state_change'}>).to === 'completed')) {
          completed = true
          break
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, 20)
        })
      }

      expect(completed, 'auto-approved turn must reach completed without external permissionDecision').to.equal(true)

      const events = await treeReader.readEvents({channelId, projectRoot, turnId})


      // Critical assertions: NO awaiting_permission transition fired, AND
      // a permission_decision event WAS emitted (auto-approval surfaces).
      const transitions = events.filter((e) => e.kind === 'delivery_state_change').map((e) => `${(e as Extract<TurnEvent, {kind: 'delivery_state_change'}>).from}→${(e as Extract<TurnEvent, {kind: 'delivery_state_change'}>).to}`)
      expect(transitions, 'streaming→awaiting_permission must NOT appear on the auto-approved path').to.not.include('streaming→awaiting_permission')
      const decision = events.find((e): e is Extract<TurnEvent, {kind: 'permission_decision'}> => e.kind === 'permission_decision')
      expect(decision, 'permission_decision event must surface the auto-approval').to.not.equal(undefined)
      expect(decision?.permissionRequestId).to.equal('p-autoapprove')
    })

    it('falls through to human-decision path when toolCall is NOT auto-approvable (non-empty oldText)', async () => {
      // Same shape as above but oldText is non-empty → must gate normally.
      await createChannel()
      const driver = new MockAcpDriver({
        events: [
          {
            kind: 'permission_request',
            permissionRequestId: 'p-needs-human',
            request: {
              options: [{kind: 'allow_once', name: 'Allow', optionId: 'opt-allow'}],
              sessionId: 's',
              toolCall: {
                content: [{
                  newText: 'after',
                  oldText: 'before',  // non-empty → not auto-approvable
                  path: `${projectRoot}/engine.js`,
                  type: 'diff',
                }],
                kind: 'edit',
                toolCallId: 'tc-edit',
              },
            },
          },
        ],
        handle: '@mock',
      })
      nextDriver = driver
      await invite('@mock')

      const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@mock partial edit'})
      const {turnId} = accepted.turn

      // Wait for awaiting_permission to land.
      const treeReader = new ChannelTreeReader()
      const deadline = Date.now() + 5000
      let gotAwaitingPermission = false
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const events = await treeReader.readEvents({channelId, projectRoot, turnId})
        if (events.some(e => e.kind === 'delivery_state_change' && (e as Extract<TurnEvent, {kind: 'delivery_state_change'}>).to === 'awaiting_permission')) {
          gotAwaitingPermission = true
          break
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, 20)
        })
      }

      expect(gotAwaitingPermission, 'partial-replacement Edit must still gate behind awaiting_permission').to.equal(true)
    })
  })

  describe('cancelTurn', () => {
    it('emits §7.2 sequence in events.jsonl: permission_decision → delivery_state_change → turn_state_change', async () => {
      await createChannel()
      const driver = new MockAcpDriver({
        events: [
          {
            kind: 'permission_request',
            permissionRequestId: 'p-cancel',
            request: {
              options: [{kind: 'allow_once', name: 'Allow', optionId: 'opt-allow'}],
              sessionId: 's',
              toolCall: {toolCallId: 'tc-1'},
            },
          },
        ],
        handle: '@mock',
      })
      nextDriver = driver
      await invite('@mock')

      const accepted = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@mock long task'})
      const {turnId} = accepted.turn

      // Wait for permission_request before cancelling.
      const treeReader = new ChannelTreeReader()
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        const events = await treeReader.readEvents({channelId, projectRoot, turnId})
        if (events.some((e) => e.kind === 'permission_request')) break
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, 20)
        })
      }

      await orchestrator.cancelTurn({channelId, projectRoot, turnId})

      // Wait for terminal.
      const terminalDeadline = Date.now() + 5000
      while (Date.now() < terminalDeadline) {
        // eslint-disable-next-line no-await-in-loop
        const events = await treeReader.readEvents({channelId, projectRoot, turnId})
        if (events.some((e) => e.kind === 'turn_state_change' && (e as Extract<TurnEvent, {kind: 'turn_state_change'}>).to === 'cancelled')) {
          break
        }

        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => {
          setTimeout(r, 20)
        })
      }

      const events = await treeReader.readEvents({channelId, projectRoot, turnId})
      const cancelSequence = events.filter(
        (e) =>
          (e.kind === 'permission_decision' && (e as Extract<TurnEvent, {kind: 'permission_decision'}>).outcome.outcome === 'cancelled') ||
          (e.kind === 'delivery_state_change' && (e as Extract<TurnEvent, {kind: 'delivery_state_change'}>).to === 'cancelled') ||
          (e.kind === 'turn_state_change' && (e as Extract<TurnEvent, {kind: 'turn_state_change'}>).to === 'cancelled'),
      )

      const kinds = cancelSequence.map((e) => e.kind)
      const permIdx = kinds.indexOf('permission_decision')
      const delIdx = kinds.indexOf('delivery_state_change')
      const turnIdx = kinds.indexOf('turn_state_change')
      expect(permIdx).to.be.greaterThan(-1)
      expect(delIdx).to.be.greaterThan(permIdx)
      expect(turnIdx).to.be.greaterThan(delIdx)
    })
  })

  describe('uninviteMember', () => {
    it('removes the member from meta.json and stops the driver', async () => {
      await createChannel()
      const driver = new MockAcpDriver({events: [], handle: '@mock'})
      const stopSpy = sandbox.spy(driver, 'stop')
      nextDriver = driver
      await invite('@mock')

      await orchestrator.uninviteMember({channelId, memberHandle: '@mock', projectRoot})

      const meta = await store.readChannelMeta({channelId, projectRoot})
      expect(meta?.members).to.deep.equal([])
      expect(stopSpy.called).to.equal(true)
      expect(pool.acquire({channelId, memberHandle: '@mock'})).to.equal(undefined)

      expect(
        broadcasts.some(
          (b) => b.event === ChannelEvents.MEMBER_UPDATE && (b.payload as {op: string}).op === 'removed',
        ),
      ).to.equal(true)
    })
  })

  // Suppress "unused" reference to nextDriverConfig until Phase 3 widens the
  // driver factory contract.
  it('keeps nextDriverConfig in scope for future tests', () => {
    expect(typeof nextDriverConfig).to.equal('undefined')
  })

  // ─── §9.5.8 Blocker 2 — delivery-record integrity marker persistence ──────

  describe('§9.5.8 Blocker 2: integrity markers persisted in TurnDelivery when agent_meta parley_integrity emitted', () => {
    it('sealOrigin and integrityDegraded are stored on the delivery when driver emits parley_integrity agent_meta', async () => {
      await createChannel()

      // Use a driver that emits an agent_meta parley_integrity event (simulating
      // what RemoteMemberDriver yields on the implicit-from-signed-terminal path).
      nextDriver = new MockAcpDriver({
        events: [
          {content: 'hello result', kind: 'agent_message_chunk'},
          {
            kind: 'agent_meta',
            payload: {
              integrityDegraded: true,
              sealOrigin: 'implicit-from-signed-terminal',
            },
            subKind: 'parley_integrity',
          },
        ],
        handle: '@mock',
      })

      await invite('@mock')

      const {turn} = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@mock hello'})

      // Wait for the background delivery to complete
      await new Promise((r) => {
        setTimeout(r, 150)
      })

      // Read deliveries from disk — they must have the integrity markers set
      const deliveries = await store.readDeliveries({channelId, projectRoot, turnId: turn.turnId})

      expect(deliveries).to.have.lengthOf(1)
      const delivery = deliveries[0]
      expect(delivery.sealOrigin).to.equal('implicit-from-signed-terminal')
      expect(delivery.integrityDegraded).to.equal(true)
      expect(delivery.terminalMissing).to.equal(undefined)
    })

    it('terminalMissing is stored when driver emits parley_integrity with terminalMissing=true', async () => {
      await createChannel()

      nextDriver = new MockAcpDriver({
        events: [
          {content: 'partial', kind: 'agent_message_chunk'},
          {
            kind: 'agent_meta',
            payload: {
              integrityDegraded: true,
              sealOrigin: 'implicit-from-stream-eof',
              terminalMissing: true,
            },
            subKind: 'parley_integrity',
          },
        ],
        handle: '@mock',
      })

      await invite('@mock')

      const {turn} = await orchestrator.dispatchMention({channelId, projectRoot, prompt: '@mock ping'})

      await new Promise((r) => {
        setTimeout(r, 150)
      })

      const deliveries = await store.readDeliveries({channelId, projectRoot, turnId: turn.turnId})

      expect(deliveries).to.have.lengthOf(1)
      const delivery = deliveries[0]
      expect(delivery.sealOrigin).to.equal('implicit-from-stream-eof')
      expect(delivery.integrityDegraded).to.equal(true)
      expect(delivery.terminalMissing).to.equal(true)
    })
  })
})
