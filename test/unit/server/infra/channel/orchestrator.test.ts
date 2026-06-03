import {expect} from 'chai'
import {promises as fs} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {
  AgentDriverPromptArgs,
  AgentDriverStatus,
  IAgentDriver,
  TurnEventPayload,
} from '../../../../../src/server/core/interfaces/channel/i-agent-driver.js'
import type {IChannelBroadcaster} from '../../../../../src/server/core/interfaces/channel/i-channel-broadcaster.js'
import type {IDriverProfileStore} from '../../../../../src/server/core/interfaces/channel/i-driver-profile-store.js'
import type {AgentDriverProfile} from '../../../../../src/shared/types/index.js'

import {ChannelDeliveryFailedError, ChannelMentionEmptyError} from '../../../../../src/server/core/domain/channel/errors.js'
import {FileChannelStore} from '../../../../../src/server/infra/channel/channel-store.js'
import {DriverPool} from '../../../../../src/server/infra/channel/drivers/driver-pool.js'
import {ChannelOrchestrator} from '../../../../../src/server/infra/channel/orchestrator.js'
import {FileTranscriptStore} from '../../../../../src/server/infra/channel/storage/file-transcript-store.js'
import {TurnSequenceAllocator} from '../../../../../src/server/infra/channel/turn-sequence-allocator.js'
import {ChannelEvents, ChannelTurnEventBroadcastSchema} from '../../../../../src/shared/transport/events/channel-events.js'

const emptyProfileStore: IDriverProfileStore = {
  async get(): Promise<AgentDriverProfile | undefined> {
    return undefined
  },
  async list(): Promise<AgentDriverProfile[]> {
    return []
  },
  async remove(): Promise<boolean> {
    return false
  },
  async upsert(): Promise<void> {},
}

class SpyBroadcaster implements IChannelBroadcaster {
  public readonly sent: Array<{channelId: string; data: unknown; event: string}> = []

  broadcastToChannel<T>(channelId: string, event: string, data: T): void {
    this.sent.push({channelId, data, event})
  }

  /** Kinds of every `turn-event` broadcast, in order. */
  wireEventKinds(): string[] {
    return this.sent
      .filter((s) => s.event === ChannelEvents.TURN_EVENT)
      .map((s) => ChannelTurnEventBroadcastSchema.safeParse(s.data))
      .flatMap((r) => (r.success ? [r.data.event.kind] : []))
  }
}

class FakeAgentDriver implements IAgentDriver {
  public status: AgentDriverStatus = 'idle'
  private readonly payloads: TurnEventPayload[]
  private readonly throwError: Error | undefined

  public constructor(public readonly handle: string, payloads: TurnEventPayload[], throwError?: Error) {
    this.payloads = payloads
    this.throwError = throwError
  }

  async cancel(): Promise<void> {}

  async *prompt(_args: AgentDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
    for (const payload of this.payloads) yield payload
    if (this.throwError !== undefined) throw this.throwError
  }

  async respondToPermission(): Promise<void> {}

  async start(): Promise<void> {}

  async stop(): Promise<void> {}
}

const chunk = (content: string): TurnEventPayload => ({content, kind: 'agent_message_chunk'})
const thought = (content: string): TurnEventPayload => ({content, kind: 'agent_thought_chunk'})

describe('ChannelOrchestrator', () => {
  let projectRoot: string
  let broadcaster: SpyBroadcaster
  let pool: DriverPool
  let store: FileChannelStore
  let transcriptStore: FileTranscriptStore
  let nextDriver: IAgentDriver
  let orch: ChannelOrchestrator
  let counter: number

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(join(tmpdir(), 'brv-orch-'))
    broadcaster = new SpyBroadcaster()
    pool = new DriverPool()
    store = new FileChannelStore({projectRoot})
    transcriptStore = new FileTranscriptStore()
    counter = 0
    orch = new ChannelOrchestrator({
      broadcaster,
      clock: () => new Date('2026-06-02T08:00:00.000Z'),
      driverFactory: () => nextDriver,
      idGenerator: () => `id-${counter++}`,
      pool,
      profileStore: emptyProfileStore,
      projectRoot,
      seqAllocator: new TurnSequenceAllocator(),
      store,
      transcriptStore,
    })
  })

  afterEach(async () => {
    await pool.releaseAll()
    await fs.rm(projectRoot, {force: true, recursive: true})
  })

  const inviteFake = async (handle: string, payloads: TurnEventPayload[], throwError?: Error): Promise<void> => {
    nextDriver = new FakeAgentDriver(handle, payloads, throwError)
    await orch.inviteMember({channelId: 'x', handle, invocation: {args: [], command: 'node', cwd: projectRoot}})
  }

  it('sync mention assembles the final answer and completes', async () => {
    await orch.createChannel({channelId: 'x'})
    await inviteFake('@mock', [chunk('hello '), chunk('world')])

    const dispatch = await orch.dispatchMention({channelId: 'x', mode: 'sync', prompt: '@mock hi'})
    const result = await orch.awaitSyncMention(dispatch.turn.turnId)

    expect(result.endedState).to.equal('completed')
    expect(result.finalAnswer).to.equal('hello world')
    expect(result.durationMs).to.be.at.least(0)
    expect(result.turnId).to.equal(dispatch.turn.turnId)
  })

  it('persists the transcript NDJSON in seq order', async () => {
    await orch.createChannel({channelId: 'x'})
    await inviteFake('@mock', [chunk('a'), chunk('b')])

    const dispatch = await orch.dispatchMention({channelId: 'x', mode: 'sync', prompt: '@mock hi'})
    await orch.awaitSyncMention(dispatch.turn.turnId)

    const events = await transcriptStore.readTurnEvents({channelId: 'x', projectRoot, turnId: dispatch.turn.turnId})
    expect(events.map((e) => e.seq)).to.deep.equal([0, 1, 2, 3, 4, 5, 6, 7])
    expect(events.map((e) => e.kind)).to.deep.equal([
      'message',
      'turn_state_change',
      'delivery_state_change',
      'delivery_state_change',
      'agent_message_chunk',
      'agent_message_chunk',
      'delivery_state_change',
      'turn_state_change',
    ])
  })

  it('suppress-thoughts drops agent_thought_chunk from the wire AND the transcript', async () => {
    await orch.createChannel({channelId: 'x'})
    await inviteFake('@mock', [thought('thinking'), chunk('visible answer')])

    const dispatch = await orch.dispatchMention({channelId: 'x', mode: 'sync', prompt: '@mock hi', suppressThoughts: true})
    const result = await orch.awaitSyncMention(dispatch.turn.turnId)

    expect(result.finalAnswer).to.equal('visible answer')
    const events = await transcriptStore.readTurnEvents({channelId: 'x', projectRoot, turnId: dispatch.turn.turnId})
    expect(events.some((e) => e.kind === 'agent_thought_chunk')).to.equal(false)
    expect(broadcaster.wireEventKinds()).to.not.include('agent_thought_chunk')
  })

  it('without suppress-thoughts the agent_thought_chunk survives on disk', async () => {
    await orch.createChannel({channelId: 'x'})
    await inviteFake('@mock', [thought('thinking'), chunk('visible answer')])

    const dispatch = await orch.dispatchMention({channelId: 'x', mode: 'sync', prompt: '@mock hi'})
    await orch.awaitSyncMention(dispatch.turn.turnId)

    const events = await transcriptStore.readTurnEvents({channelId: 'x', projectRoot, turnId: dispatch.turn.turnId})
    expect(events.some((e) => e.kind === 'agent_thought_chunk')).to.equal(true)
  })

  it('throws ChannelMentionEmptyError when no member is addressed', async () => {
    await orch.createChannel({channelId: 'x'})
    await inviteFake('@mock', [chunk('hi')])

    let thrown: unknown
    try {
      await orch.dispatchMention({channelId: 'x', mode: 'sync', prompt: '@nobody hello'})
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelMentionEmptyError)
  })

  it('rejects the sync result when the driver fails mid-stream', async () => {
    await orch.createChannel({channelId: 'x'})
    await inviteFake('@mock', [chunk('partial')], new Error('boom'))

    const dispatch = await orch.dispatchMention({channelId: 'x', mode: 'sync', prompt: '@mock hi'})
    let thrown: unknown
    try {
      await orch.awaitSyncMention(dispatch.turn.turnId)
    } catch (error) {
      thrown = error
    }

    expect(thrown).to.be.instanceOf(ChannelDeliveryFailedError)
  })
})
