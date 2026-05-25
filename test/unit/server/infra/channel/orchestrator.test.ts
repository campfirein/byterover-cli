import {expect} from 'chai'

import type {IChannelBroadcaster} from '../../../../../src/server/core/interfaces/channel/i-channel-broadcaster.js'
import type {ContentBlock} from '../../../../../src/shared/types/channel.js'

import {
  ChannelAlreadyExistsError,
  ChannelArchivedError,
  ChannelNotFoundError,
  ChannelPromptEmptyError,
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

// Slice 1.4 — passive-only orchestrator. Phase-2 mention/cancel/permission
// methods are out of scope and not yet exposed on the orchestrator surface.
describe('ChannelOrchestrator (Phase 1 / passive only)', () => {
  let projectRoot: string
  let orchestrator: ChannelOrchestrator
  let broadcasts: Array<{channelId: string; data: unknown; event: string}>

  const mockBroadcaster = (): IChannelBroadcaster => ({
    broadcastToChannel(channelId, event, data) {
      broadcasts.push({channelId, data, event})
    },
  })

  let idSeq = 0
  const monotonicId = (): string => {
    idSeq += 1
    return `id-${String(idSeq).padStart(4, '0')}`
  }

  let nowMs = 1_700_000_000_000
  const clock = (): Date => {
    nowMs += 1
    return new Date(nowMs)
  }

  beforeEach(async () => {
    projectRoot = await makeTempContextTree()
    broadcasts = []
    idSeq = 0
    nowMs = 1_700_000_000_000

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
      async writeEvent() {
        // Phase-1 passive tests do not exercise cancel-coordinator output.
      },
    })

    orchestrator = new ChannelOrchestrator({
      broadcaster: mockBroadcaster(),
      cancelCoordinator,
      clock,
      driverFactory: (_invocation, handle) => new MockAcpDriver({events: [], handle}),
      idGenerator: monotonicId,
      permissionBroker: broker,
      pool,
      seqAllocator,
      store,
    })
  })

  afterEach(async () => {
    await removeTempDir(projectRoot)
  })

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  describe('createChannel', () => {
    it('persists meta.json and returns a Channel projection', async () => {
      const channel = await orchestrator.createChannel({channelId: 'pi-test', projectRoot})

      expect(channel.channelId).to.equal('pi-test')
      expect(channel.memberCount).to.equal(0)
      expect(channel.members).to.deep.equal([])
      expect(channel.archivedAt).to.be.undefined
    })

    it('emits a channel:state-change broadcast on creation', async () => {
      await orchestrator.createChannel({channelId: 'pi-test', projectRoot})
      const stateChanges = broadcasts.filter((b) => b.event === 'channel:state-change')
      expect(stateChanges).to.have.lengthOf(1)
      expect(stateChanges[0].channelId).to.equal('pi-test')
    })

    it('rejects a duplicate channelId with CHANNEL_ALREADY_EXISTS', async () => {
      await orchestrator.createChannel({channelId: 'pi-test', projectRoot})

      let threw: unknown
      try {
        await orchestrator.createChannel({channelId: 'pi-test', projectRoot})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelAlreadyExistsError)
    })

    it('auto-generates a channelId when none is supplied', async () => {
      const channel = await orchestrator.createChannel({projectRoot})
      expect(channel.channelId).to.match(/^id-/)
    })
  })

  describe('listChannels', () => {
    it('returns all non-archived channels by default', async () => {
      await orchestrator.createChannel({channelId: 'a', projectRoot})
      await orchestrator.createChannel({channelId: 'b', projectRoot})
      await orchestrator.archiveChannel({channelId: 'a', projectRoot})

      const channels = await orchestrator.listChannels({projectRoot})
      expect(channels.map((c) => c.channelId).sort()).to.deep.equal(['b'])
    })

    it('returns archived too when archived: true', async () => {
      await orchestrator.createChannel({channelId: 'a', projectRoot})
      await orchestrator.archiveChannel({channelId: 'a', projectRoot})

      const channels = await orchestrator.listChannels({archived: true, projectRoot})
      expect(channels.map((c) => c.channelId)).to.include('a')
    })

    it('returns an empty array when no channels exist', async () => {
      const channels = await orchestrator.listChannels({projectRoot})
      expect(channels).to.deep.equal([])
    })
  })

  describe('getChannel', () => {
    it('returns the channel record', async () => {
      await orchestrator.createChannel({channelId: 'pi-test', projectRoot})
      const channel = await orchestrator.getChannel({channelId: 'pi-test', projectRoot})
      expect(channel.channelId).to.equal('pi-test')
    })

    it('throws CHANNEL_NOT_FOUND for an unknown channelId', async () => {
      let threw: unknown
      try {
        await orchestrator.getChannel({channelId: 'missing', projectRoot})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelNotFoundError)
    })
  })

  describe('archiveChannel', () => {
    it('sets archivedAt and broadcasts a state-change', async () => {
      await orchestrator.createChannel({channelId: 'pi-test', projectRoot})
      broadcasts.length = 0

      const archived = await orchestrator.archiveChannel({channelId: 'pi-test', projectRoot})
      expect(archived.archivedAt).to.be.a('string')

      const stateChanges = broadcasts.filter((b) => b.event === 'channel:state-change')
      expect(stateChanges).to.have.lengthOf(1)
    })

    it('throws CHANNEL_NOT_FOUND when archiving an unknown channel', async () => {
      let threw: unknown
      try {
        await orchestrator.archiveChannel({channelId: 'missing', projectRoot})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelNotFoundError)
    })
  })

  // ─── Turns ───────────────────────────────────────────────────────────────

  describe('postTurn', () => {
    beforeEach(async () => {
      await orchestrator.createChannel({channelId: 'pi-test', projectRoot})
      broadcasts.length = 0
    })

    it('persists a Turn in state "completed" for a plain prompt', async () => {
      const turn = await orchestrator.postTurn({
        channelId: 'pi-test',
        projectRoot,
        prompt: 'this is a note',
      })

      expect(turn.channelId).to.equal('pi-test')
      expect(turn.state).to.equal('completed')
      expect(turn.author).to.deep.equal({handle: 'you', kind: 'local-user'})
      expect(turn.promptBlocks).to.deep.equal([{text: 'this is a note', type: 'text'}])
      expect(turn.promptedBy).to.equal('user')
    })

    it('uses promptBlocks as-is when only promptBlocks is supplied', async () => {
      const promptBlocks: ContentBlock[] = [
        {type: 'resource_link', uri: 'file:///a.md'},
      ]
      const turn = await orchestrator.postTurn({channelId: 'pi-test', projectRoot, promptBlocks})
      expect(turn.promptBlocks).to.deep.equal(promptBlocks)
    })

    it('appends prompt as a final text block when BOTH prompt and promptBlocks are supplied', async () => {
      const promptBlocks: ContentBlock[] = [{type: 'resource_link', uri: 'file:///a.md'}]
      const turn = await orchestrator.postTurn({
        channelId: 'pi-test',
        projectRoot,
        prompt: 'tail',
        promptBlocks,
      })
      expect(turn.promptBlocks).to.deep.equal([
        {type: 'resource_link', uri: 'file:///a.md'},
        {text: 'tail', type: 'text'},
      ])
    })

    it('rejects a prompt-empty request with CHANNEL_PROMPT_EMPTY (no prompt, no blocks)', async () => {
      let threw: unknown
      try {
        await orchestrator.postTurn({channelId: 'pi-test', projectRoot})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelPromptEmptyError)
    })

    it('rejects whitespace-only prompt as CHANNEL_PROMPT_EMPTY', async () => {
      let threw: unknown
      try {
        await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: '   \t  '})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelPromptEmptyError)
    })

    it('rejects promptBlocks with only empty text as CHANNEL_PROMPT_EMPTY', async () => {
      let threw: unknown
      try {
        await orchestrator.postTurn({
          channelId: 'pi-test',
          projectRoot,
          promptBlocks: [{text: '  ', type: 'text'}],
        })
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelPromptEmptyError)
    })

    it('accepts a structured-only request (resource_link with no text) as non-empty', async () => {
      const turn = await orchestrator.postTurn({
        channelId: 'pi-test',
        projectRoot,
        promptBlocks: [{type: 'resource_link', uri: 'file:///a.md'}],
      })
      expect(turn.state).to.equal('completed')
    })

    it('emits message + turn_state_change events as turn-event broadcasts', async () => {
      await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: 'hi'})

      const turnEvents = broadcasts.filter((b) => b.event === 'channel:turn-event')
      expect(turnEvents.length).to.be.at.least(2)
      const kinds = turnEvents.map(
        (b) => ((b.data as {event: {kind: string}}).event.kind),
      )
      expect(kinds).to.include('message')
      expect(kinds).to.include('turn_state_change')
    })

    it('throws CHANNEL_NOT_FOUND when the channel does not exist', async () => {
      let threw: unknown
      try {
        await orchestrator.postTurn({channelId: 'missing', projectRoot, prompt: 'hi'})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelNotFoundError)
    })

    it('throws CHANNEL_ARCHIVED when posting to an archived channel', async () => {
      await orchestrator.archiveChannel({channelId: 'pi-test', projectRoot})

      let threw: unknown
      try {
        await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: 'hi'})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelArchivedError)
    })
  })

  describe('listTurns / getTurn', () => {
    beforeEach(async () => {
      await orchestrator.createChannel({channelId: 'pi-test', projectRoot})
    })

    it('returns recently-posted turns', async () => {
      await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: 'a'})
      await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: 'b'})
      await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: 'c'})

      const result = await orchestrator.listTurns({channelId: 'pi-test', projectRoot})
      expect(result.turns).to.have.lengthOf(3)
      expect(result.turns.every((t) => t.state === 'completed')).to.equal(true)
    })

    it('returns the latest turn first when limit is applied', async () => {
      await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: 'first'})
      await orchestrator.postTurn({channelId: 'pi-test', projectRoot, prompt: 'second'})

      const result = await orchestrator.listTurns({channelId: 'pi-test', limit: 1, projectRoot})
      expect(result.turns).to.have.lengthOf(1)
      expect(
        (result.turns[0].promptBlocks[0] as {text: string; type: string}).text,
      ).to.equal('second')
    })

    it('getTurn returns the turn record and its event stream', async () => {
      const posted = await orchestrator.postTurn({
        channelId: 'pi-test',
        projectRoot,
        prompt: 'hi',
      })

      const result = await orchestrator.getTurn({
        channelId: 'pi-test',
        projectRoot,
        turnId: posted.turnId,
      })

      expect(result.turn.turnId).to.equal(posted.turnId)
      expect(result.events.some((e) => e.kind === 'message')).to.equal(true)
      expect(result.events.some((e) => e.kind === 'turn_state_change')).to.equal(true)
    })

    it('getTurn throws CHANNEL_TURN_NOT_FOUND for an unknown turnId', async () => {
      let threw: unknown
      try {
        await orchestrator.getTurn({channelId: 'pi-test', projectRoot, turnId: 'never'})
      } catch (error) {
        threw = error
      }

      expect(threw).to.be.instanceOf(ChannelTurnNotFoundError)
    })
  })
})
