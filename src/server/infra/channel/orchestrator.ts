import type {
  AgentDriverProfileInvocation,
  Channel,
  ChannelMember,
  ChannelMemberAcpAgent,
  ChannelMentionSyncResult,
  ContentBlock,
  Turn,
  TurnDelivery,
  TurnEvent,
} from '../../../shared/types/index.js'
import type {IAgentDriver, TurnEventPayload} from '../../core/interfaces/channel/i-agent-driver.js'
import type {IChannelBroadcaster} from '../../core/interfaces/channel/i-channel-broadcaster.js'
import type {
  CreateChannelArgs,
  DispatchMentionArgs,
  DispatchMentionResult,
  IChannelOrchestrator,
  InviteMemberArgs,
} from '../../core/interfaces/channel/i-channel-orchestrator.js'
import type {IChannelStore} from '../../core/interfaces/channel/i-channel-store.js'
import type {IDriverPool} from '../../core/interfaces/channel/i-driver-pool.js'
import type {IDriverProfileStore} from '../../core/interfaces/channel/i-driver-profile-store.js'
import type {ITranscriptStore} from '../../core/interfaces/channel/i-transcript-store.js'
import type {ITurnSequenceAllocator} from '../../core/interfaces/channel/i-turn-sequence-allocator.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {TurnEventSchema} from '../../../shared/types/index.js'
import {
  AgentDriverProfileNotFoundError,
  CHANNEL_ERROR_CODE,
  ChannelDeliveryFailedError,
  ChannelError,
  ChannelInvalidRequestError,
  ChannelMentionEmptyError,
  ChannelNotFoundError,
  ChannelSyncTimeoutError,
} from '../../core/domain/channel/errors.js'
import {assertLegalDeliveryTransition, assertLegalTurnTransition} from '../../core/domain/channel/turn-state-machine.js'
import {parseMentions} from './mention-parser.js'

/** Default wait budget for a synchronous mention (5 minutes). */
const DEFAULT_SYNC_TIMEOUT_MS = 300_000

const NON_TERMINAL_DELIVERY_STATES = new Set<TurnDelivery['state']>([
  'awaiting_permission',
  'dispatched',
  'queued',
  'streaming',
])

/** In-flight turn tracked between dispatch and finalisation (single member). */
type ActiveTurn = {
  channelId: string
  delivery: TurnDelivery
  memberHandle: string
  suppressThoughts: boolean
  turn: Turn
}

/** Per-turn buffer + promise wiring for a `mode: 'sync'` mention. */
type PendingSyncEntry = {
  readonly channelId: string
  chunks: string[]
  readonly promise: Promise<ChannelMentionSyncResult>
  readonly reject: (error: Error) => void
  readonly resolve: (result: ChannelMentionSyncResult) => void
  settled: boolean
  readonly startedAtMs: number
  timer: NodeJS.Timeout | undefined
  readonly turnId: string
}

export type ChannelOrchestratorDeps = {
  readonly broadcaster: IChannelBroadcaster
  readonly clock: () => Date
  readonly driverFactory: (invocation: AgentDriverProfileInvocation, handle: string) => IAgentDriver
  readonly idGenerator: () => string
  readonly pool: IDriverPool
  readonly profileStore: IDriverProfileStore
  /** Project this orchestrator is bound to; transcript writes resolve location from it. */
  readonly projectRoot: string
  readonly seqAllocator: ITurnSequenceAllocator
  readonly store: IChannelStore
  readonly transcriptStore: ITranscriptStore
}

const firstTextOf = (blocks: ContentBlock[]): string => {
  for (const block of blocks) {
    if (block.type === 'text') return block.text
  }

  return '[structured prompt]'
}

const collectBlockText = (block: ContentBlock): string => (block.type === 'text' ? block.text : '')

const normalisePrompt = (args: {prompt?: string; promptBlocks?: ContentBlock[]}): ContentBlock[] => {
  if (args.promptBlocks !== undefined && args.promptBlocks.length > 0) return args.promptBlocks
  return [{text: args.prompt ?? '', type: 'text'}]
}

/**
 * Thin per-project coordinator for the channel subsystem. Owns turn lifecycle
 * for a single addressed member and the synchronous-mention promise wiring,
 * delegating sequencing, persistence, and fan-out to focused collaborators so
 * no single method becomes a god-object.
 */
export class ChannelOrchestrator implements IChannelOrchestrator {
  private readonly activeTurns = new Map<string, ActiveTurn>()
  private readonly deps: ChannelOrchestratorDeps
  private readonly pendingSyncResponses = new Map<string, PendingSyncEntry>()

  public constructor(deps: ChannelOrchestratorDeps) {
    this.deps = deps
  }

  async awaitSyncMention(turnId: string): Promise<ChannelMentionSyncResult> {
    const entry = this.pendingSyncResponses.get(turnId)
    if (entry === undefined) {
      throw new ChannelError(`no pending synchronous mention for turn ${turnId}`, CHANNEL_ERROR_CODE.NOT_FOUND, {turnId})
    }

    return entry.promise
  }

  async createChannel(args: CreateChannelArgs): Promise<Channel> {
    const channelId = args.channelId ?? this.deps.idGenerator()
    const channel = await this.deps.store.createChannel({channelId, title: args.title})
    this.deps.broadcaster.broadcastToChannel(channelId, ChannelEvents.STATE_CHANGE, {channel, channelId})
    return channel
  }

  async dispatchMention(args: DispatchMentionArgs): Promise<DispatchMentionResult> {
    const channel = await this.deps.store.readChannel(args.channelId)
    if (channel === undefined) throw new ChannelNotFoundError(args.channelId)

    const promptBlocks = normalisePrompt(args)
    const memberHandle = this.resolveSingleMember(channel, promptBlocks, args.mentions)

    const turnId = this.deps.idGenerator()
    const startedAt = this.deps.clock().toISOString()
    this.deps.seqAllocator.reset({channelId: args.channelId, turnId})

    // Step 1: user `message` event at seq 0.
    await this.persistAndBroadcast(
      this.stamp({
        channelId: args.channelId,
        deliveryId: null,
        memberHandle: null,
        payload: {content: firstTextOf(promptBlocks), kind: 'message', role: 'user'},
        turnId,
      }),
    )

    // Step 2: build the in-memory Turn + single queued delivery.
    const delivery: TurnDelivery = {
      artifactsTouched: [],
      channelId: args.channelId,
      deliveryId: this.deps.idGenerator(),
      memberHandle,
      startedAt,
      state: 'queued',
      toolCallCount: 0,
      turnId,
    }
    const turn: Turn = {
      author: {handle: 'you', kind: 'local-user'},
      channelId: args.channelId,
      mentions: [memberHandle],
      promptBlocks,
      promptedBy: 'user',
      startedAt,
      state: 'pending',
      turnId,
    }
    const active: ActiveTurn = {
      channelId: args.channelId,
      delivery,
      memberHandle,
      suppressThoughts: args.suppressThoughts === true,
      turn,
    }
    this.activeTurns.set(turnId, active)

    // Step 3: register the sync entry BEFORE any streaming can emit chunks.
    if (args.mode === 'sync') {
      this.registerPendingSync({channelId: args.channelId, timeoutMs: args.timeoutMs, turnId})
    }

    // Step 4: turn pending → dispatched.
    assertLegalTurnTransition('pending', 'dispatched')
    turn.state = 'dispatched'
    await this.persistAndBroadcast(
      this.stamp({
        channelId: args.channelId,
        deliveryId: null,
        memberHandle: null,
        payload: {from: 'pending', kind: 'turn_state_change', to: 'dispatched'},
        turnId,
      }),
    )

    // Step 5: delivery queued → dispatched.
    assertLegalDeliveryTransition('queued', 'dispatched')
    delivery.state = 'dispatched'
    await this.persistAndBroadcast(
      this.stamp({
        channelId: args.channelId,
        deliveryId: delivery.deliveryId,
        memberHandle,
        payload: {from: 'queued', kind: 'delivery_state_change', to: 'dispatched'},
        turnId,
      }),
    )

    // Step 6: stream in the background; the sync caller awaits awaitSyncMention.
    // Fire-and-forget — failures surface via delivery_state_change → errored
    // and the sync-promise rejection.
    this.runBackgroundStreaming(active, promptBlocks).catch(() => {})

    return {deliveries: [delivery], turn}
  }

  async inviteMember(args: InviteMemberArgs): Promise<ChannelMember> {
    const channel = await this.deps.store.readChannel(args.channelId)
    if (channel === undefined) throw new ChannelNotFoundError(args.channelId)

    let invocation: AgentDriverProfileInvocation
    let driverClass: ChannelMemberAcpAgent['driverClass'] = 'B'
    let acpVersion: string | undefined
    let capabilities: string[] = []

    if (args.profileName !== undefined) {
      const profile = await this.deps.profileStore.get(args.profileName)
      if (profile === undefined) throw new AgentDriverProfileNotFoundError(args.profileName)
      invocation = profile.invocation
      driverClass = profile.driverClass
      acpVersion = profile.detectedAcpVersion
      capabilities = profile.capabilities ?? []
    } else if (args.invocation === undefined) {
      throw new ChannelInvalidRequestError('invite requires a --profile or an inline invocation', {
        fields: ['profileName', 'invocation'],
      })
    } else {
      invocation = args.invocation
    }

    const driver = this.deps.driverFactory(invocation, args.handle)
    // A start failure (binary missing, handshake) propagates as a typed error;
    // nothing is registered or persisted.
    await driver.start()
    this.deps.pool.register({channelId: args.channelId, driver, memberHandle: args.handle})

    const member: ChannelMemberAcpAgent = {
      acpVersion,
      agentName: args.handle.replace(/^@/, ''),
      capabilities,
      driverClass,
      handle: args.handle,
      invocation,
      joinedAt: this.deps.clock().toISOString(),
      memberKind: 'acp-agent',
      status: 'idle',
    }
    await this.deps.store.addMember({channelId: args.channelId, member})
    this.deps.broadcaster.broadcastToChannel(args.channelId, ChannelEvents.MEMBER_UPDATE, {
      channelId: args.channelId,
      member,
      op: 'added',
    })

    return member
  }

  // ─── Streaming + finalisation ──────────────────────────────────────────

  private assembleFinalAnswer(entry: PendingSyncEntry): string {
    return entry.chunks.join('')
  }

  private failPendingSync(turnId: string, error: Error): void {
    const entry = this.pendingSyncResponses.get(turnId)
    if (entry === undefined || entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pendingSyncResponses.delete(turnId)
    entry.reject(error)
  }

  private async finaliseTurn(active: ActiveTurn): Promise<void> {
    const {turnId} = active.turn
    if (!this.activeTurns.has(turnId)) return

    if (active.turn.state === 'dispatched') {
      assertLegalTurnTransition('dispatched', 'completed')
      active.turn.state = 'completed'
      active.turn.endedAt = this.deps.clock().toISOString()
      await this.persistAndBroadcast(
        this.stamp({
          channelId: active.channelId,
          deliveryId: null,
          memberHandle: null,
          payload: {from: 'dispatched', kind: 'turn_state_change', to: 'completed'},
          turnId,
        }),
      )
    }

    this.activeTurns.delete(turnId)

    if (this.pendingSyncResponses.has(turnId) && active.turn.state === 'completed') {
      if (active.delivery.state === 'errored') {
        this.failPendingSync(
          turnId,
          new ChannelDeliveryFailedError(turnId, [
            {code: active.delivery.errorCode, handle: active.delivery.memberHandle, reason: active.delivery.errorMessage},
          ]),
        )
      } else {
        this.settlePendingSync(turnId, 'completed')
      }
    }

    this.deps.seqAllocator.reset({channelId: active.channelId, turnId})
  }

  private async handleDriverPayload(active: ActiveTurn, payload: TurnEventPayload): Promise<void> {
    const {channelId, delivery, memberHandle, turn} = active
    const {turnId} = turn

    if (delivery.state === 'dispatched') {
      assertLegalDeliveryTransition('dispatched', 'streaming')
      delivery.state = 'streaming'
      await this.persistAndBroadcast(
        this.stamp({
          channelId,
          deliveryId: delivery.deliveryId,
          memberHandle,
          payload: {from: 'dispatched', kind: 'delivery_state_change', to: 'streaming'},
          turnId,
        }),
      )
    }

    // Permission handling lands in a later milestone; ignore requests for now.
    if (payload.kind === 'permission_request') return

    await this.persistAndBroadcast(
      this.stamp({channelId, deliveryId: delivery.deliveryId, memberHandle, payload, turnId}),
    )
  }

  private async persistAndBroadcast(event: TurnEvent): Promise<void> {
    // Drop suppressed thoughts at this boundary — neither persisted nor broadcast.
    if (event.kind === 'agent_thought_chunk' && this.activeTurns.get(event.turnId)?.suppressThoughts === true) {
      return
    }

    await this.deps.transcriptStore.appendTurnEvent({
      channelId: event.channelId,
      event,
      projectRoot: this.deps.projectRoot,
      turnId: event.turnId,
    })
    this.deps.broadcaster.broadcastToChannel(event.channelId, ChannelEvents.TURN_EVENT, {channelId: event.channelId, event})
    this.recordSyncEvent(event)
  }

  private recordSyncEvent(event: TurnEvent): void {
    if (event.kind !== 'agent_message_chunk') return
    const entry = this.pendingSyncResponses.get(event.turnId)
    if (entry === undefined || entry.settled) return
    if (event.content.length > 0) entry.chunks.push(event.content)
  }

  private registerPendingSync(args: {channelId: string; timeoutMs?: number; turnId: string}): void {
    const timeoutMs = args.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS
    let resolveFn!: (result: ChannelMentionSyncResult) => void
    let rejectFn!: (error: Error) => void
    const promise = new Promise<ChannelMentionSyncResult>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })

    const timer = setTimeout(() => {
      this.failPendingSync(args.turnId, new ChannelSyncTimeoutError(args.turnId, timeoutMs))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    this.pendingSyncResponses.set(args.turnId, {
      channelId: args.channelId,
      chunks: [],
      promise,
      reject: rejectFn,
      resolve: resolveFn,
      settled: false,
      startedAtMs: this.deps.clock().getTime(),
      timer,
      turnId: args.turnId,
    })
  }

  private resolveSingleMember(channel: Channel, promptBlocks: ContentBlock[], explicit?: string[]): string {
    const seen = new Set<string>()
    const allHandles: string[] = []
    for (const handle of parseMentions(promptBlocks.map((block) => collectBlockText(block)).join(' '))) {
      if (!seen.has(handle)) {
        seen.add(handle)
        allHandles.push(handle)
      }
    }

    for (const handle of explicit ?? []) {
      if (!seen.has(handle)) {
        seen.add(handle)
        allHandles.push(handle)
      }
    }

    if (allHandles.length === 0) throw new ChannelMentionEmptyError()

    const memberHandles = new Set(channel.members.map((member) => member.handle))
    const resolved = allHandles.find((handle) => memberHandles.has(handle))
    if (resolved === undefined) throw new ChannelMentionEmptyError()
    return resolved
  }

  private async runBackgroundStreaming(active: ActiveTurn, promptBlocks: ContentBlock[]): Promise<void> {
    const {channelId, delivery, memberHandle, turn} = active
    const {turnId} = turn

    const driver = this.deps.pool.acquire({channelId, memberHandle})
    if (driver === undefined) {
      const from = delivery.state
      delivery.state = 'errored'
      delivery.errorCode = CHANNEL_ERROR_CODE.DRIVER_NOT_REGISTERED
      delivery.errorMessage =
        `No live driver registered for ${memberHandle} in #${channelId}. ` +
        `Re-invite the member: brv channel invite ${channelId} ${memberHandle} --profile <name>`
      await this.persistAndBroadcast(
        this.stamp({
          channelId,
          deliveryId: delivery.deliveryId,
          memberHandle,
          payload: {
            error: delivery.errorMessage,
            errorCode: delivery.errorCode,
            from,
            kind: 'delivery_state_change',
            to: 'errored',
          },
          turnId,
        }),
      )
      await this.finaliseTurn(active)
      return
    }

    try {
      for await (const payload of driver.prompt({prompt: promptBlocks, turnId})) {
        await this.handleDriverPayload(active, payload)
      }

      if (NON_TERMINAL_DELIVERY_STATES.has(delivery.state)) {
        const from = delivery.state
        assertLegalDeliveryTransition(from, 'completed')
        delivery.state = 'completed'
        await this.persistAndBroadcast(
          this.stamp({
            channelId,
            deliveryId: delivery.deliveryId,
            memberHandle,
            payload: {from, kind: 'delivery_state_change', to: 'completed'},
            turnId,
          }),
        )
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (NON_TERMINAL_DELIVERY_STATES.has(delivery.state)) {
        const from = delivery.state
        delivery.state = 'errored'
        delivery.errorCode = CHANNEL_ERROR_CODE.DELIVERY_FAILED
        delivery.errorMessage = reason
        await this.persistAndBroadcast(
          this.stamp({
            channelId,
            deliveryId: delivery.deliveryId,
            memberHandle,
            payload: {
              error: reason,
              errorCode: CHANNEL_ERROR_CODE.DELIVERY_FAILED,
              from,
              kind: 'delivery_state_change',
              to: 'errored',
            },
            turnId,
          }),
        )
      }
    }

    await this.finaliseTurn(active)
  }

  private settlePendingSync(turnId: string, endedState: 'cancelled' | 'completed'): void {
    const entry = this.pendingSyncResponses.get(turnId)
    if (entry === undefined || entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pendingSyncResponses.delete(turnId)
    entry.resolve({
      durationMs: this.deps.clock().getTime() - entry.startedAtMs,
      endedState,
      finalAnswer: this.assembleFinalAnswer(entry),
      turnId,
    })
  }

  /** Stamps a payload-only slice with the base coordination fields + a fresh seq. */
  private stamp(args: {
    channelId: string
    deliveryId: null | string
    memberHandle: null | string
    payload: Record<string, unknown>
    turnId: string
  }): TurnEvent {
    return TurnEventSchema.parse({
      ...args.payload,
      channelId: args.channelId,
      deliveryId: args.deliveryId,
      emittedAt: this.deps.clock().toISOString(),
      memberHandle: args.memberHandle,
      seq: this.deps.seqAllocator.next({channelId: args.channelId, turnId: args.turnId}),
      turnId: args.turnId,
    })
  }
}
