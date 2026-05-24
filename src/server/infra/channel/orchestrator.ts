import {promises as fs} from 'node:fs'

import type {
  AgentDriverProfileInvocation,
  Channel,
  ChannelMember,
  ChannelMemberAcpAgent,
  ChannelMemberRemotePeer,
  ChannelMeta,
  ContentBlock,
  Turn,
  TurnDelivery,
  TurnEvent,
} from '../../../shared/types/channel.js'
import type {IAcpDriver, TurnEventPayload} from '../../core/interfaces/channel/i-acp-driver.js'
import type {IChannelBroadcaster} from '../../core/interfaces/channel/i-channel-broadcaster.js'
import type {
  ArchiveChannelArgs,
  CancelTurnArgs,
  CancelTurnResult,
  ChannelMentionSyncResult,
  CreateChannelArgs,
  DispatchHandle,
  DispatchMentionArgs,
  DispatchMentionResult,
  DispatchOneArgs,
  GetChannelArgs,
  GetTurnArgs,
  GetTurnResult,
  IChannelOrchestrator,
  InviteMemberArgs,
  ListChannelsArgs,
  ListTurnsArgs,
  ListTurnsResult,
  PermissionDecisionArgs,
  PostTurnArgs,
  TerminalDelivery,
  UninviteMemberArgs,
} from '../../core/interfaces/channel/i-channel-orchestrator.js'
import type {IChannelStore} from '../../core/interfaces/channel/i-channel-store.js'
import type {IAcpDriverPool} from '../../core/interfaces/channel/i-driver-pool.js'
import type {IDriverProfileStore} from '../../core/interfaces/channel/i-driver-profile-store.js'
import type {ITurnSequenceAllocator} from '../../core/interfaces/channel/i-turn-sequence-allocator.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {
  AcpPromptFailedError,
  AgentDriverProfileNotFoundError,
  CHANNEL_ERROR_CODE,
  ChannelAlreadyExistsError,
  ChannelArchivedError,
  ChannelDaemonShutdownError,
  ChannelDeliveryFailedError,
  ChannelError,
  ChannelInvalidRequestError,
  ChannelMentionEmptyError,
  ChannelNotFoundError,
  ChannelPermissionLostOnRestartError,
  ChannelSyncOverflowError,
  ChannelSyncTimeoutError,
  ChannelTurnCancelledError,
  ChannelTurnNotFoundError,
} from '../../core/domain/channel/errors.js'
import {assertLegalTurnTransition} from '../../core/domain/channel/turn-state-machine.js'
import {type AutoCreateQuota} from './bridge/auto-create-quota.js'
import {type RestartLossRecord} from './channel-recovery.js'
import {CancelCoordinator, type CancelDeliveryRef} from './drivers/cancel-coordinator.js'
import {IPermissionBroker} from './drivers/permission-broker.js'
import {DEFAULT_IDEMPOTENCY_TTL_MS, deriveIdempotencyKey} from './idempotency-key.js'
import {buildLookback} from './lookback-builder.js'
import {resolveMentions} from './member-resolver.js'
import {parseMentions} from './mention-parser.js'
import {decideAutoApprovalForEditAsWrite} from './permission-auto-approver.js'
import {type IProfileMetadataStore} from './profile-metadata-store.js'
import {normalisePrompt} from './prompt-normaliser.js'
import {refreshRemotePeerL2PubKey} from './refresh-remote-peer-l2.js'
import {channelPaths} from './storage/paths.js'

/**
 * Channel orchestrator (Phase 1 lifecycle + Phase 2 active dispatch).
 *
 * Phase 1 surface: create / list / get / archive / postTurn / listTurns /
 * getTurn — passive transcript management.
 *
 * Phase 2 surface (Slice 2.4):
 *   - `inviteMember`: spawn + ACP `initialize` synchronously, persist member,
 *     register driver in the pool. Failure does NOT persist anything.
 *   - `uninviteMember`: cancel in-flight deliveries, release pool driver,
 *     remove member from meta.json.
 *   - `dispatchMention`: synchronous validation + dispatch (emit message
 *     seq-0 + turn_state_change + delivery_state_change) then RETURN; the
 *     background streaming task continues to consume the driver iterator,
 *     emit events, persist snapshots, and finalise the turn.
 *   - `cancelTurn`: delegate to {@link CancelCoordinator} for §7.2 ordering.
 *   - `permissionDecision`: delegate to {@link PermissionBroker.resolve},
 *     emit delivery_state_change + permission_decision events.
 */
export type ChannelOrchestratorDeps = {
  /**
   * Phase 9.5.4 deferral (§6) — per-peer auto-create quota. When provided,
   * `uninviteMember` calls `reset(peerId)` when the removed member is a
   * `remote-peer`, clearing the peer's hourly counter so subsequent auto-
   * creates from the same peer succeed.
   */
  readonly autoCreateQuota?: AutoCreateQuota
  readonly broadcaster: IChannelBroadcaster
  readonly cancelCoordinator: CancelCoordinator
  readonly clock: () => Date
  readonly driverFactory: (
    invocation: ChannelMemberAcpAgent['invocation'],
    handle: string,
  ) => IAcpDriver
  readonly idGenerator: () => string
  // Phase 10 Tier B2 (V6 run-2/run-3 §3b) — when true, the orchestrator
  // auto-approves `permission_request` events whose toolCall is an Edit
  // with empty oldText on a file inside the project sandbox. Skips the
  // human-decision wait + the `streaming → awaiting_permission` state
  // transition for the only operation class where it's structurally
  // safe (full-file rewrite of own-scope file = Write-equivalent).
  //
  // Defaults to true. Pass false to preserve the legacy behaviour of
  // gating every permission_request regardless of shape.
  readonly permissionAutoApproveEditAsWrite?: boolean
  readonly permissionBroker: IPermissionBroker
  readonly pool: IAcpDriverPool
  /**
   * Phase 10 Tier C #4 — per-profile metadata store. Optional: when
   * supplied, the orchestrator records each completed delivery's
   * wall-clock duration so `channel profile show` can surface per-
   * agent variance ahead of the next dispatch.
   */
  readonly profileMetadataStore?: IProfileMetadataStore
  /**
   * Phase-3 driver-profile registry. Optional so Phase-1/2 unit tests can
   * keep constructing the orchestrator without ferrying a store in.
   * `inviteMember` consults the store when `profileName` is supplied.
   */
  readonly profileStore?: IDriverProfileStore
  /**
   * Phase 9 / Slice 9.4 — factory for `remote-peer` channel members.
   * The orchestrator calls this in `inviteMember` when the invite
   * carries `remotePeer` instead of `invocation` / `profileName`. The
   * factory MUST return an `IAcpDriver` whose `prompt()` dials a
   * Parley stream to the supplied multiaddr. Optional: when omitted,
   * `inviteMember` rejects remote-peer invites with
   * `CHANNEL_INVITE_REMOTE_UNSUPPORTED`.
   */
  readonly remotePeerDriverFactory?: (args: {
    channelId: string
    handle: string
    multiaddr: string
    peerId: string
    remoteL2PubKey: string
  }) => Promise<IAcpDriver>
  /**
   * Phase 9 / Slice 9.4d — resolve a remote peer's L2 tree pubkey
   * in-band when `inviteMember.remotePeer.remoteL2PubKey` is absent.
   * Implementations typically call `fetchAndPin({fetchTreeCert: true})`
   * against the libp2p bridge host + TOFU store. When omitted (or
   * resolution fails), the orchestrator rejects the invite with
   * `CHANNEL_INVITE_REMOTE_L2_UNRESOLVED` and the operator must
   * re-issue with an explicit `--l2-pub-key`.
   */
  readonly resolveRemotePeerL2PubKey?: (args: {
    multiaddr: string
    peerId: string
  }) => Promise<string>
  readonly seqAllocator: ITurnSequenceAllocator
  readonly store: IChannelStore
}

type ActiveTurn = {
  /**
   * Phase-3 cancel guard. Set to `true` synchronously at the start of
   * `cancelTurn` so concurrent background tasks finishing mid-cancel skip
   * `releaseNextQueued` — without this, a late-completing in-flight task
   * could dispatch the next queued delivery AFTER the cancel coordinator
   * has already iterated, leaving a `queued → dispatched` event without
   * a matching `→ cancelled` follow-up.
   */
  cancelling: boolean
  channelId: string
  deliveries: TurnDelivery[]
  members: ChannelMember[]
  projectRoot: string
  // Slice 8.0 — if true, `persistAndBroadcast` drops `agent_thought_chunk`
  // events (neither persisted nor broadcast). Read by `persistAndBroadcast`
  // via `this.activeTurns.get(turnId)`.
  suppressThoughts: boolean
  turn: Turn
}

/**
 * Slice 8.0 — per-turn buffer + promise wiring for `mode: 'sync'`. One
 * entry per sync mention. `awaitSyncMention(turnId)` returns this entry's
 * promise. The buffer accumulates per-member `agent_message_chunk`
 * content as it streams; on terminal `turn_state_change`, the buffer is
 * assembled into `finalAnswer` and the promise resolves. Timeouts,
 * overflow, external cancel, and daemon shutdown reject it.
 */
type PendingSyncEntry = {
  readonly byteBudget: number
  bytesWritten: number
  readonly channelId: string
  chunks: Map<string, string[]>
  readonly reject: (error: Error) => void
  readonly resolve: (result: ChannelMentionSyncResult) => void
  settled: boolean
  readonly startedAtMs: number
  timer?: NodeJS.Timeout
  toolCalls: Map<string, {callId: string; name: string; status?: string}>
  readonly turnId: string
}

// Default per-turn buffer ceiling for sync mode (1 MiB). Configurable via
// `BRV_CHANNEL_SYNC_BYTE_BUDGET` env var so operators can raise it for
// chatty agents without recompiling.
const DEFAULT_SYNC_BYTE_BUDGET = 1_048_576

const resolveSyncByteBudget = (): number => {
  const raw = process.env.BRV_CHANNEL_SYNC_BYTE_BUDGET
  if (raw === undefined || raw === '') return DEFAULT_SYNC_BYTE_BUDGET
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SYNC_BYTE_BUDGET
  return parsed
}

const DEFAULT_SYNC_TIMEOUT_MS = 300_000

const SYNC_FAN_OUT_SEPARATOR = '\n\n[@'

const firstTextOf = (blocks: ContentBlock[]): string => {
  for (const b of blocks) {
    if (b.type === 'text') return b.text
  }

  return '[structured prompt]'
}

const collectBlockText = (b: ContentBlock): string => (b.type === 'text' ? b.text : '')

const RESERVED_MENTIONS = new Set(['@all', '@everyone'])

const NON_TERMINAL_DELIVERY_STATES = new Set<TurnDelivery['state']>([
  'awaiting_permission',
  'dispatched',
  'queued',
  'streaming',
])

const FAN_OUT_DEFAULT_MAX_PARALLEL = 4

export class ChannelOrchestrator implements IChannelOrchestrator {
  private readonly activeTurns = new Map<string, ActiveTurn>()
  // Phase 9.5.4 deferral (§6) — optional quota; when absent, uninvite
  // skips the reset call (backwards-compatible with pre-9.5.4 installs).
  private readonly autoCreateQuota: AutoCreateQuota | undefined
  private readonly broadcaster: IChannelBroadcaster
  private readonly cancelCoordinator: CancelCoordinator
  private readonly clock: () => Date
  private readonly driverFactory: (
    invocation: ChannelMemberAcpAgent['invocation'],
    handle: string,
  ) => IAcpDriver
  // Phase 10 Tier C #2 (V6 run-4 §4a) — auto-idempotency cache. Maps
  // `${channelId}\0${idempotencyKey}` → {turnId, expiresAtMs}. A new
  // `dispatchMention` whose key matches a still-active entry returns the
  // cached `{turn, deliveries}` snapshot instead of starting a parallel
  // turn. Entries are best-effort: swept on every dispatch.
  private readonly idempotencyIndex = new Map<string, {expiresAtMs: number; turnId: string}>()
  private readonly idGenerator: () => string
  // Phase 10 Tier B2 — per-turn queue of pending broker.resolve()
  // callbacks. The prompt-iteration loop drains this AFTER it advances
  // past each yield, when the driver's permission gate is guaranteed to
  // be registered. See `handleDriverPayload` for the auto-approval path.
  private readonly pendingAutoApprovals = new Map<string, Array<() => Promise<void>>>()
  // Slice 8.0 — `mode: 'sync'` pending entries keyed by turnId. Populated
  // synchronously inside `dispatchMention` BEFORE any background delivery
  // task can run; settled by `finaliseTurn` / `cancelTurn` / timeout /
  // overflow / `dispose`.
  private readonly pendingSyncResponses = new Map<string, PendingSyncEntry>()
  private readonly permissionAutoApproveEditAsWrite: boolean
  private readonly permissionBroker: IPermissionBroker
  private readonly pool: IAcpDriverPool
  private readonly profileMetadataStore: IProfileMetadataStore | undefined
  private readonly profileStore: IDriverProfileStore | undefined
  // Phase 10 follow-up — track project-level warm-driver passes so a mention
  // arriving during the cold-start race window awaits the warm instead of
  // erroring with CHANNEL_DRIVER_NOT_REGISTERED. Keyed by projectRoot;
  // entries clear once the warm resolves (success or failure).
  private readonly projectWarmInFlight = new Map<string, Promise<void>>()
  // Phase 9 / Slice 9.4 — see `ChannelOrchestratorDeps.remotePeerDriverFactory`.
  private readonly remotePeerDriverFactory: ChannelOrchestratorDeps['remotePeerDriverFactory']
  private readonly resolveRemotePeerL2PubKey: ChannelOrchestratorDeps['resolveRemotePeerL2PubKey']
  // Slice 8.10 — orphan registry for in-flight permissions lost on daemon
  // restart. Populated once at daemon startup via `seedRestartLosses()` from
  // `runChannelRecovery()` results. Consulted by `permissionDecision()` when
  // `activeTurns.get()` misses so we surface CHANNEL_PERMISSION_LOST_ON_RESTART
  // (with a Slice-8.9 cursor) instead of the misleading CHANNEL_TURN_NOT_FOUND.
  // Keyed by permissionRequestId per codex Q6 — a single turn can host
  // multiple orphaned permissions, one per delivery.
  private readonly restartLosses = new Map<string, RestartLossRecord>()
  private readonly seqAllocator: ITurnSequenceAllocator
  private readonly store: IChannelStore
  // Slice 8.11 Layer 2 — per-key (channelId\0memberHandle) in-flight spawn
  // tracker so concurrent warm + inviteMember don't double-spawn the same
  // ACP subprocess. Codex Q6.
  private readonly warmInFlight = new Map<string, Promise<void>>()

  public constructor(deps: ChannelOrchestratorDeps) {
    this.autoCreateQuota = deps.autoCreateQuota
    this.broadcaster = deps.broadcaster
    this.cancelCoordinator = deps.cancelCoordinator
    this.clock = deps.clock
    this.driverFactory = deps.driverFactory
    this.idGenerator = deps.idGenerator
    this.permissionAutoApproveEditAsWrite = deps.permissionAutoApproveEditAsWrite ?? true
    this.permissionBroker = deps.permissionBroker
    this.pool = deps.pool
    this.profileMetadataStore = deps.profileMetadataStore
    this.profileStore = deps.profileStore
    this.remotePeerDriverFactory = deps.remotePeerDriverFactory
    this.resolveRemotePeerL2PubKey = deps.resolveRemotePeerL2PubKey
    this.seqAllocator = deps.seqAllocator
    this.store = deps.store
  }

  // ─── Phase-1 lifecycle ─────────────────────────────────────────────────

  async archiveChannel(args: ArchiveChannelArgs): Promise<Channel> {
    const now = this.clock().toISOString()
    let channel: Channel
    try {
      channel = await this.store.updateChannelMeta({
        channelId: args.channelId,
        mutate: (meta) => ({...meta, archivedAt: meta.archivedAt ?? now, updatedAt: now}),
        projectRoot: args.projectRoot,
      })
    } catch (error) {
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw new ChannelNotFoundError(args.channelId)
      }

      throw error
    }

    await this.pool.releaseChannel(args.channelId)
    this.broadcaster.broadcastToChannel(args.channelId, ChannelEvents.STATE_CHANGE, {
      channel,
      channelId: args.channelId,
    })

    return channel
  }

  // ─── Phase-2 cancel ───────────────────────────────────────────────────

  public async awaitSyncMention(turnId: string): Promise<ChannelMentionSyncResult> {
    const entry = this.pendingSyncResponses.get(turnId)
    if (entry === undefined) {
      throw new ChannelTurnNotFoundError('', turnId)
    }

    return (entry as PendingSyncEntry & {promise: Promise<ChannelMentionSyncResult>}).promise
  }

  async cancelTurn(args: CancelTurnArgs): Promise<CancelTurnResult> {
    const active = this.activeTurns.get(args.turnId)
    if (active === undefined) throw new ChannelTurnNotFoundError(args.channelId, args.turnId)

    // CRITICAL: flip the guard synchronously BEFORE any await so a
    // concurrent background-task completion (running between our awaits)
    // cannot call releaseNextQueued and dispatch a new delivery while
    // the cancel sequence is mid-flight.
    active.cancelling = true

    const inFlight: CancelDeliveryRef[] = active.deliveries.map((d) => ({
      deliveryId: d.deliveryId,
      memberHandle: d.memberHandle,
      state: d.state,
    }))

    if (args.deliveryId === undefined) {
      await this.cancelCoordinator.cancelTurn({
        channelId: args.channelId,
        inFlightDeliveries: inFlight,
        projectRoot: args.projectRoot,
        turnId: args.turnId,
        turnState: active.turn.state,
      })

      // Update in-memory state.
      const endedAt = this.clock().toISOString()
      for (const d of active.deliveries) {
        if (NON_TERMINAL_DELIVERY_STATES.has(d.state)) d.state = 'cancelled'
      }

      active.turn.state = 'cancelled'
      active.turn.endedAt = endedAt
      await this.finaliseTurn(active)
    } else {
      const delivery = active.deliveries.find((d) => d.deliveryId === args.deliveryId)
      if (delivery === undefined) throw new ChannelTurnNotFoundError(args.channelId, args.turnId)
      await this.cancelCoordinator.cancelDelivery({
        channelId: args.channelId,
        delivery: {deliveryId: delivery.deliveryId, memberHandle: delivery.memberHandle, state: delivery.state},
        projectRoot: args.projectRoot,
        turnId: args.turnId,
      })
      delivery.state = 'cancelled'
    }

    return {deliveries: active.deliveries, turn: active.turn}
  }

  async createChannel(args: CreateChannelArgs): Promise<Channel> {
    const now = this.clock().toISOString()
    const channelId = args.channelId ?? this.idGenerator()

    const meta: ChannelMeta = {
      channelId,
      createdAt: now,
      members: [],
      title: args.title,
      updatedAt: now,
    }

    let channel: Channel
    try {
      channel = await this.store.createChannel({meta, projectRoot: args.projectRoot})
    } catch (error) {
      if (error instanceof Error && /already exists/i.test(error.message)) {
        throw new ChannelAlreadyExistsError(channelId)
      }

      throw error
    }

    this.broadcaster.broadcastToChannel(channelId, ChannelEvents.STATE_CHANGE, {
      channel,
      channelId,
    })

    return channel
  }

  // ─── Phase-2 dispatch ─────────────────────────────────────────────────

  async dispatchMention(args: DispatchMentionArgs): Promise<DispatchMentionResult> {
    // Phase 10 follow-up — cold-start race fix. If a project-wide warm is
    // in flight (daemon just restarted, drivers not yet spawned from
    // meta.json), block here until it settles. Avoids the
    // CHANNEL_DRIVER_NOT_REGISTERED that previously fired within ~12ms of
    // the first client connection after an idle-timeout shutdown.
    const inFlightWarm = this.projectWarmInFlight.get(args.projectRoot)
    if (inFlightWarm !== undefined) {
      await inFlightWarm
    }

    const meta = await this.store.readChannelMeta({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
    })
    if (meta === undefined) throw new ChannelNotFoundError(args.channelId)
    if (meta.archivedAt !== undefined) throw new ChannelArchivedError(args.channelId)

    const promptBlocks = normalisePrompt({prompt: args.prompt, promptBlocks: args.promptBlocks})

    // Union parsed mentions + explicit mentions[]; dedupe in first-occurrence
    // order so the parser's deterministic ordering is preserved.
    //
    // Phase 10 D1 — when `strictMentions === true`, skip the prompt-parse
    // step entirely and dispatch ONLY to the explicit list. This is what
    // `dispatchOne` needs: the V6 super-mario E2E retest exposed that
    // single-agent intent was being diluted by @-handles inside the prompt
    // body. Default false preserves Phase 1–9 union behaviour.
    const seen = new Set<string>()
    const allHandles: string[] = []
    if (args.strictMentions !== true) {
      for (const handle of parseMentions(promptBlocks.map((b) => collectBlockText(b)).join(' '))) {
        if (!seen.has(handle)) {
          seen.add(handle)
          allHandles.push(handle)
        }
      }
    }

    for (const handle of args.mentions ?? []) {
      if (!seen.has(handle)) {
        seen.add(handle)
        allHandles.push(handle)
      }
    }

    if (allHandles.length === 0) throw new ChannelMentionEmptyError()

    // Reject reserved handles before resolving membership.
    for (const handle of allHandles) {
      if (RESERVED_MENTIONS.has(handle)) {
        throw new ChannelInvalidRequestError(
          `Reserved mention ${handle} (e.g. @everyone, @all) is not supported in v0.1.`,
          {handle},
        )
      }
    }

    const members = resolveMentions(meta, allHandles)

    // Phase-3 fan-out: cap from channel settings (default 4). Surplus
    // members queue FIFO behind the in-flight slots. Phase 4+ may
    // introduce a global ChannelSettings.maxParallelAgents wire surface.
    const maxParallel = meta.settings?.maxParallelAgents ?? FAN_OUT_DEFAULT_MAX_PARALLEL

    // Phase 10 Tier C #2 (V6 run-4 §4a) — auto-derive an idempotency
    // key (if not provided) and try to collapse onto an active matching
    // turn. Returns the cached snapshot on hit; falls through to a
    // fresh dispatch on miss.
    const nowMs = this.clock().getTime()
    const idempotencyLookup = this.lookupIdempotentTurn({
      allHandles,
      channelId: args.channelId,
      explicitKey: args.idempotencyKey,
      nowMs,
      promptBlocks,
    })
    if (idempotencyLookup.cachedResult !== undefined) return idempotencyLookup.cachedResult

    const turnId = this.idGenerator()
    const startedAt = this.clock().toISOString()
    this.seqAllocator.reset({channelId: args.channelId, turnId})

    // Step 7: emit user `message` event at seq 0.
    const messageSeq = this.seqAllocator.next({channelId: args.channelId, turnId})
    const messageEvent: TurnEvent = {
      channelId: args.channelId,
      content: firstTextOf(promptBlocks),
      deliveryId: null,
      emittedAt: startedAt,
      kind: 'message',
      memberHandle: null,
      role: 'user',
      seq: messageSeq,
      turnId,
    }
    await this.persistAndBroadcast(args.channelId, args.projectRoot, turnId, messageEvent)

    // Step 8: build in-memory Turn + N TurnDelivery (all `queued`).
    const deliveries: TurnDelivery[] = members.map((m) => ({
      artifactsTouched: [],
      channelId: args.channelId,
      deliveryId: this.idGenerator(),
      memberHandle: m.handle,
      startedAt,
      state: 'queued',
      toolCallCount: 0,
      turnId,
    }))
    const turn: Turn = {
      author: {handle: 'you', kind: 'local-user'},
      channelId: args.channelId,
      idempotencyKey: idempotencyLookup.effectiveKey,
      mentions: allHandles,
      promptBlocks,
      promptedBy: 'user',
      startedAt,
      state: 'pending',
      turnId,
    }

    // Step 9: emit `turn_state_change pending → dispatched`.
    assertLegalTurnTransition('pending', 'dispatched')
    turn.state = 'dispatched'
    await this.persistAndBroadcast(args.channelId, args.projectRoot, turnId, {
      channelId: args.channelId,
      deliveryId: null,
      emittedAt: this.clock().toISOString(),
      from: 'pending',
      kind: 'turn_state_change',
      memberHandle: null,
      seq: this.seqAllocator.next({channelId: args.channelId, turnId}),
      to: 'dispatched',
      turnId,
    })

    // Track the in-flight turn so cancel/fan-out can introspect.
    const active: ActiveTurn = {
      cancelling: false,
      channelId: args.channelId,
      deliveries,
      members,
      projectRoot: args.projectRoot,
      // Slice 8.0 — per-turn suppressThoughts flag read by
      // `persistAndBroadcast` to drop `agent_thought_chunk` events at the
      // boundary where per-turn policy is in scope (NOT the projector).
      suppressThoughts: args.suppressThoughts === true,
      turn,
    }
    this.activeTurns.set(turnId, active)
    // Phase 10 Tier C #2 — register AFTER the turn is in `activeTurns`
    // so a concurrent dispatch hitting the same key races to the same
    // turnId. The 5-min TTL matches the bucket window used by
    // `deriveIdempotencyKey` so the index window aligns with the key
    // rollover boundary.
    this.idempotencyIndex.set(idempotencyLookup.indexKey, {
      expiresAtMs: nowMs + DEFAULT_IDEMPOTENCY_TTL_MS,
      turnId,
    })

    // Slice 8.0 — `mode: 'sync'` registers a pending entry BEFORE any
    // background task can emit chunks. The handler awaits
    // `awaitSyncMention(turnId)` instead of returning the
    // ChannelTurnAcceptedResponse immediately.
    if (args.mode === 'sync') {
      this.registerPendingSync({
        channelId: args.channelId,
        timeout: args.timeout,
        turnId,
      })
    }

    // Step 10: emit `delivery_state_change queued → dispatched` for the
    // first `maxParallel` deliveries; the rest stay `queued` and are
    // released as in-flight deliveries reach terminal state.
    const inFlight: Array<{delivery: TurnDelivery; member: ChannelMember}> = []
    for (let i = 0; i < deliveries.length && i < maxParallel; i += 1) {
      const delivery = deliveries[i]
      delivery.state = 'dispatched'
      // eslint-disable-next-line no-await-in-loop
      await this.persistAndBroadcast(args.channelId, args.projectRoot, turnId, {
        channelId: args.channelId,
        deliveryId: delivery.deliveryId,
        emittedAt: this.clock().toISOString(),
        from: 'queued',
        kind: 'delivery_state_change',
        memberHandle: delivery.memberHandle,
        seq: this.seqAllocator.next({channelId: args.channelId, turnId}),
        to: 'dispatched',
        turnId,
      })
      inFlight.push({delivery, member: members[i]})
    }

    // Step 11–13: kick off one background streaming task per in-flight
    // delivery. Each task, on terminal, releases the next queued delivery.
    for (const {delivery, member} of inFlight) {
      this.runBackgroundStreaming(active, member, delivery, promptBlocks).catch(() => {
        // Background errors surface via delivery_state_change → errored.
      })
    }

    // Step 13: return synchronously with the snapshot — dispatched/queued
    // states as set above.
    return {deliveries, turn}
  }

  /**
   * Phase 10 Slice 10.2 — single-agent dispatch returning a `DispatchHandle`.
   *
   * Implementation: routes through existing `dispatchMention(mode: 'sync')`
   * with `mentions: [memberHandle]` (no shell-out, single internal API per
   * codex Q4). The `terminal` Promise wraps `awaitSyncMention(turnId)` and
   * maps the assembled sync result to `TerminalDelivery`. The Q8 follow-on
   * (terminal-state filter) is upheld here: `awaitSyncMention` only resolves
   * on `completed`/`cancelled` (errored arrives via Promise rejection from
   * the channel-error subclasses).
   *
   * Race-safety (kimi R2): `dispatchMention` synchronously populates
   * `pendingSyncResponses` via `registerPendingSync` BEFORE the dispatch
   * task yields. The `awaitSyncMention(turnId)` call below is therefore a
   * Promise *lookup*, not a listener attachment, so no chunks can be missed
   * in the window between dispatch return and await call.
   *
   * Architectural note (kimi R1): Slice 10.2 ships K turns per quorum
   * dispatch (one per agent). The cleaner 1-turn / K-deliveries shape
   * requires per-delivery sync aggregation, deferred to Tier 2 — Slice 10.7
   * (partition-tolerant convergence) touches the same machinery.
   */
  async dispatchOne(args: DispatchOneArgs): Promise<DispatchHandle> {
    const result = await this.dispatchMention({
      channelId: args.channelId,
      idempotencyKey: args.idempotencyKey,
      mentions: [args.memberHandle],
      mode: 'sync',
      projectRoot: args.projectRoot,
      prompt: args.prompt,
      // Phase 10 D1 (V6 retest): without this, @-handles inside the prompt
      // body would union with `mentions: [memberHandle]` and dispatch to
      // multiple agents per turn, defeating the single-agent intent.
      strictMentions: true,
      suppressThoughts: args.suppressThoughts,
      timeout: args.timeoutMs,
    })

    const {turn} = result
    const delivery = result.deliveries.find(d => d.memberHandle === args.memberHandle)
    if (delivery === undefined) {
      throw new ChannelInvalidRequestError(
        `dispatchOne: no delivery for ${args.memberHandle} on turn ${turn.turnId}`,
        {memberHandle: args.memberHandle, turnId: turn.turnId},
      )
    }

    const {memberHandle} = args
    const {clock} = this
    const terminal: Promise<TerminalDelivery> = this.awaitSyncMention(turn.turnId).then(
      (sync): TerminalDelivery => ({
        artifactsTouched: delivery.artifactsTouched ?? [],
        deliveryId: delivery.deliveryId,
        endedAt: clock().toISOString(),
        finalAnswer: sync.finalAnswer,
        memberHandle,
        state: sync.endedState,
        toolCallCount: sync.toolCalls.length,
      }),
      // Kimi R3: narrow against the ChannelError base class instead of
      // duck-typing `code`. ChannelError-derived classes carry a typed
      // `code: string`; everything else is unrecognised infrastructure
      // failure and gets CHANNEL_UNKNOWN.
      //
      // Phase 10 follow-up A2 — promote a `ChannelSyncTimeoutError` that
      // carries a non-empty `partialFinalAnswer` into a usable
      // TerminalDelivery (state: 'errored' + finalAnswer populated). The
      // QuorumDispatcher's `extractFindings` checks state === 'completed'
      // for the happy path; we surface the partial under state: 'errored'
      // so downstream policies can decide whether to count it.
      (error: unknown): TerminalDelivery => {
        const partial = error instanceof ChannelSyncTimeoutError ? error.partialFinalAnswer : undefined
        return {
          artifactsTouched: [],
          deliveryId: delivery.deliveryId,
          endedAt: clock().toISOString(),
          errorCode: error instanceof ChannelError ? error.code : 'CHANNEL_UNKNOWN',
          errorMessage: error instanceof Error ? error.message : String(error),
          finalAnswer: partial,
          memberHandle,
          state: 'errored',
          toolCallCount: 0,
        }
      },
    )

    return {
      deliveryId: delivery.deliveryId,
      terminal,
      turnId: turn.turnId,
    }
  }

  /**
   * Reject every outstanding pending-sync entry with
   * `CHANNEL_DAEMON_SHUTDOWN`. Hook for daemon shutdown / orchestrator
   * disposal.
   */
  public disposeSyncMentions(): void {
    for (const turnId of this.pendingSyncResponses.keys()) {
      this.failPendingSync(turnId, new ChannelDaemonShutdownError())
    }
  }

  async getChannel(args: GetChannelArgs): Promise<Channel> {
    const channel = await this.store.readChannel({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
    })
    if (channel === undefined) throw new ChannelNotFoundError(args.channelId)
    return channel
  }

  // ─── Phase-2 invite/uninvite ──────────────────────────────────────────

  /**
   * Returns the in-flight warm promise for the project, or `undefined` if
   * no warm is currently running. dispatchMention reads this so the
   * cold-start race window (mention arriving before warmDriversForProject
   * finishes spawning ACP subprocesses) blocks instead of failing fast with
   * CHANNEL_DRIVER_NOT_REGISTERED.
   */
  public getInFlightProjectWarm(projectRoot: string): Promise<void> | undefined {
    return this.projectWarmInFlight.get(projectRoot)
  }

  async getTurn(args: GetTurnArgs): Promise<GetTurnResult> {
    const channel = await this.store.readChannel({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
    })
    if (channel === undefined) throw new ChannelNotFoundError(args.channelId)

    const result = await this.store.readTurn({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })
    if (result === undefined) throw new ChannelTurnNotFoundError(args.channelId, args.turnId)

    // Phase 10 follow-up A1 (V6 evaluation) — reconcile per-delivery
    // `finalAnswer` by concatenating `agent_message_chunk.content` for the
    // delivery. Only fills empty fields on terminal deliveries; drivers that
    // populate the field directly are untouched. Without this, agents that
    // streamed real text would silently produce `finalAnswer: null` on
    // `channel show` — the V6 retest's "missing kimi findings" symptom.
    if (result.deliveries === undefined) {
      return {events: result.events, turn: result.turn}
    }

    const chunksByDelivery = new Map<string, string[]>()
    for (const event of result.events) {
      if (event.kind !== 'agent_message_chunk') continue
      const {deliveryId} = event
      if (deliveryId === null || deliveryId === undefined) continue
      const list = chunksByDelivery.get(deliveryId) ?? []
      list.push(event.content)
      chunksByDelivery.set(deliveryId, list)
    }

    const enrichedDeliveries: TurnDelivery[] = result.deliveries.map(d => {
      if (d.finalAnswer !== undefined && d.finalAnswer !== '') return d
      const isTerminal = d.state === 'completed' || d.state === 'errored' || d.state === 'cancelled'
      if (!isTerminal) return d
      const chunks = chunksByDelivery.get(d.deliveryId)
      if (chunks === undefined || chunks.length === 0) return d
      return {...d, finalAnswer: chunks.join('')}
    })

    return {deliveries: enrichedDeliveries, events: result.events, turn: result.turn}
  }

  async inviteMember(args: InviteMemberArgs): Promise<ChannelMember> {
    // Phase 9 / Slice 9.4 — `remote-peer` invites bypass the entire
    // ACP-subprocess pipeline and create a `RemoteMemberDriver` that
    // dials a libp2p Parley stream per prompt.
    if (args.remotePeer !== undefined) {
      return this.inviteRemotePeerMember(args)
    }

    if (args.profileName !== undefined && args.invocation !== undefined) {
      throw new ChannelInvalidRequestError(
        'channel:invite accepts profileName OR invocation, not both',
        {fields: ['profileName', 'invocation']},
      )
    }

    // Resolve invocation + classification: Phase 3 reads profileName via the
    // driver-profile registry; Phase 2's inline invocation flow still works.
    let invocation: AgentDriverProfileInvocation
    let driverClass: 'A' | 'B' | 'C-prime' = 'C-prime'
    let inviteCapabilities: string[] = []
    if (args.profileName !== undefined) {
      if (this.profileStore === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:invite by profileName requires the daemon to be running with the Phase-3 driver-profile registry wired in',
          {phase: 3},
        )
      }

      const profile = await this.profileStore.get(args.profileName)
      if (profile === undefined) {
        throw new AgentDriverProfileNotFoundError(args.profileName)
      }

      invocation = profile.invocation
      driverClass = profile.driverClass
      inviteCapabilities = [...(profile.capabilities ?? [])]
    } else if (args.invocation === undefined) {
      throw new ChannelInvalidRequestError(
        'channel:invite requires profileName OR invocation',
        {fields: ['profileName', 'invocation']},
      )
    } else {
      invocation = args.invocation
    }

    // Spawn driver + run initialize synchronously. Failure does NOT persist.
    const driver = this.driverFactory(invocation, args.handle)
    await driver.start()

    const member: ChannelMemberAcpAgent = {
      acpVersion: driver.protocolVersion === undefined ? undefined : String(driver.protocolVersion),
      agentName: args.handle,
      // Dedupe — profile.capabilities and driver.capabilities are populated
      // from the same source (the agent's `initialize` advertisement) so a
      // Phase-3 invite-by-profile flow doubles every cap. The Set preserves
      // first-seen order which matches the prior concatenation order.
      capabilities: [
        ...new Set([...(args.capabilities ?? []), ...driver.capabilities, ...inviteCapabilities]),
      ],
      driverClass,
      handle: args.handle,
      invocation,
      joinedAt: this.clock().toISOString(),
      memberKind: 'acp-agent',
      status: 'idle',
    }

    try {
      await this.store.updateChannelMeta({
        channelId: args.channelId,
        mutate: (meta) => {
          // Replace any prior member with the same handle.
          const existing = meta.members.filter((m) => m.handle !== args.handle)
          return {...meta, members: [...existing, member], updatedAt: this.clock().toISOString()}
        },
        projectRoot: args.projectRoot,
      })
    } catch (error) {
      // Failed to persist → stop the driver, propagate.
      await driver.stop()
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw new ChannelNotFoundError(args.channelId)
      }

      throw error
    }

    this.pool.register({channelId: args.channelId, driver})
    this.broadcaster.broadcastToChannel(args.channelId, ChannelEvents.MEMBER_UPDATE, {
      channelId: args.channelId,
      member,
      op: 'added',
    })

    return member
  }

  async listChannels(args: ListChannelsArgs): Promise<Channel[]> {
    return this.store.listChannels({
      includeArchived: args.archived === true,
      projectRoot: args.projectRoot,
    })
  }

  // ─── Phase-2 permission decision ──────────────────────────────────────

  async listTurns(args: ListTurnsArgs): Promise<ListTurnsResult> {
    const channel = await this.store.readChannel({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
    })
    if (channel === undefined) throw new ChannelNotFoundError(args.channelId)

    const result = await this.store.listTurns({
      channelId: args.channelId,
      cursor: args.cursor,
      limit: args.limit,
      projectRoot: args.projectRoot,
    })

    return {nextCursor: result.nextCursor, turns: result.turns}
  }

  async permissionDecision(args: PermissionDecisionArgs): Promise<TurnEvent> {
    const active = this.activeTurns.get(args.turnId)
    if (active === undefined || active.channelId !== args.channelId) {
      // Slice 8.10 — when the daemon restarted while this delivery was in
      // `awaiting_permission`, the in-memory activeTurns entry is gone but
      // the orphan registry (seeded at startup from runChannelRecovery)
      // remembers the loss. Surface a precise error so the host LLM knows
      // (a) the ACP session can't be resumed and (b) where to pick up via
      // the Slice-8.9 subscribe cursor.
      const lost = this.restartLosses.get(args.permissionRequestId)
      if (lost !== undefined && lost.channelId === args.channelId && lost.turnId === args.turnId) {
        throw new ChannelPermissionLostOnRestartError(
          lost.channelId,
          lost.turnId,
          lost.permissionRequestId,
          lost.erroredSeq,
        )
      }

      throw new ChannelTurnNotFoundError(args.channelId, args.turnId)
    }

    const result = await this.permissionBroker.resolve({
      channelId: args.channelId,
      outcome: args.outcome,
      permissionRequestId: args.permissionRequestId,
      turnId: args.turnId,
    })

    const delivery = active.deliveries.find((d) => d.deliveryId === result.deliveryId)
    const memberHandle = delivery?.memberHandle ?? '@unknown'

    // Emit permission_decision event.
    const decisionSeq = this.seqAllocator.next({channelId: args.channelId, turnId: args.turnId})
    const decisionEvent: TurnEvent = {
      channelId: args.channelId,
      deliveryId: result.deliveryId,
      emittedAt: this.clock().toISOString(),
      kind: 'permission_decision',
      memberHandle,
      outcome: args.outcome,
      permissionRequestId: args.permissionRequestId,
      seq: decisionSeq,
      turnId: args.turnId,
    }
    await this.persistAndBroadcast(args.channelId, args.projectRoot, args.turnId, decisionEvent)

    // Emit delivery_state_change (awaiting_permission → streaming or cancelled).
    if (delivery !== undefined && delivery.state === 'awaiting_permission') {
      const to: TurnDelivery['state'] = result.isCancellation ? 'cancelled' : 'streaming'
      delivery.state = to
      await this.persistAndBroadcast(args.channelId, args.projectRoot, args.turnId, {
        channelId: args.channelId,
        deliveryId: result.deliveryId,
        emittedAt: this.clock().toISOString(),
        from: 'awaiting_permission',
        kind: 'delivery_state_change',
        memberHandle,
        seq: this.seqAllocator.next({channelId: args.channelId, turnId: args.turnId}),
        to,
        turnId: args.turnId,
      })
    }

    return decisionEvent
  }

  async postTurn(args: PostTurnArgs): Promise<Turn> {
    const channel = await this.store.readChannel({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
    })
    if (channel === undefined) throw new ChannelNotFoundError(args.channelId)
    if (channel.archivedAt !== undefined) throw new ChannelArchivedError(args.channelId)

    const promptBlocks = normalisePrompt({prompt: args.prompt, promptBlocks: args.promptBlocks})
    const turnId = this.idGenerator()
    const startedAt = this.clock().toISOString()

    const messageEvent: TurnEvent = {
      channelId: args.channelId,
      content: firstTextOf(promptBlocks),
      deliveryId: null,
      emittedAt: startedAt,
      kind: 'message',
      memberHandle: null,
      role: 'user',
      seq: 0,
      turnId,
    }
    await this.persistAndBroadcast(args.channelId, args.projectRoot, turnId, messageEvent)

    assertLegalTurnTransition('pending', 'completed')
    const endedAt = this.clock().toISOString()
    const stateChange: TurnEvent = {
      channelId: args.channelId,
      deliveryId: null,
      emittedAt: endedAt,
      from: 'pending',
      kind: 'turn_state_change',
      memberHandle: null,
      seq: 1,
      to: 'completed',
      turnId,
    }
    await this.persistAndBroadcast(args.channelId, args.projectRoot, turnId, stateChange)

    const turn: Turn = {
      author: {handle: 'you', kind: 'local-user'},
      channelId: args.channelId,
      endedAt,
      idempotencyKey: args.idempotencyKey,
      mentions: [],
      promptBlocks,
      promptedBy: 'user',
      startedAt,
      state: 'completed',
      turnId,
    }
    await this.store.writeTurnSnapshot({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turn,
      turnId,
    })

    // Slice 9.2 — passive turns reach terminal state inline; close the
    // held-open write stream so we don't leak a file descriptor between
    // mentions on the same channel.
    await this.store.closeTranscriptStream({channelId: args.channelId, turnId})

    // Slice 9.3 — passive turns have no deliveries; the index entry
    // surfaces them in `list-turns` without forcing a per-turn NDJSON
    // read for metadata.
    await this.store.appendTurnIndexEntry({
      channelId: args.channelId,
      entry: {deliveries: [], turn},
      projectRoot: args.projectRoot,
    })

    return turn
  }

  // ─── private helpers ──────────────────────────────────────────────────

  // ─── Slice 8.10 — orphan-permission registry ────────────────────────
  // Called once at daemon startup from brv-server.ts after
  // `runChannelRecovery()` resolves. Subsequent calls overwrite per
  // permissionRequestId — the V3 reproducer can recur if the daemon
  // restarts a second time, so we accept re-seeding.
  public seedRestartLosses(records: readonly RestartLossRecord[]): void {
    for (const record of records) {
      this.restartLosses.set(record.permissionRequestId, record)
    }
  }

  async uninviteMember(args: UninviteMemberArgs): Promise<ChannelMember> {
    const meta = await this.store.readChannelMeta({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
    })
    if (meta === undefined) throw new ChannelNotFoundError(args.channelId)

    const existing = meta.members.find((m) => m.handle === args.memberHandle)
    if (existing === undefined) {
      throw new ChannelInvalidRequestError(`No member ${args.memberHandle} to uninvite`, {
        handle: args.memberHandle,
      })
    }

    // Cancel any in-flight deliveries for this member.
    for (const [turnId, active] of this.activeTurns) {
      const delivery = active.deliveries.find(
        (d) => d.memberHandle === args.memberHandle && NON_TERMINAL_DELIVERY_STATES.has(d.state),
      )
      if (delivery === undefined) continue
      // eslint-disable-next-line no-await-in-loop
      await this.cancelTurn({channelId: args.channelId, deliveryId: delivery.deliveryId, projectRoot: args.projectRoot, turnId})
    }

    await this.pool.release({channelId: args.channelId, memberHandle: args.memberHandle})

    await this.store.updateChannelMeta({
      channelId: args.channelId,
      mutate: (m) => ({
        ...m,
        members: m.members.filter((mem) => mem.handle !== args.memberHandle),
        updatedAt: this.clock().toISOString(),
      }),
      projectRoot: args.projectRoot,
    })

    this.broadcaster.broadcastToChannel(args.channelId, ChannelEvents.MEMBER_UPDATE, {
      channelId: args.channelId,
      member: existing,
      op: 'removed',
    })

    // Phase 9.5.4 deferral (§6) — reset the auto-create quota for the
    // evicted peer so they can auto-create again after being uninvited.
    // Only fires for `remote-peer` members (the quota only applies to
    // remote-initiated auto-creates; local acp-agents are not throttled).
    if (this.autoCreateQuota !== undefined && existing.memberKind === 'remote-peer') {
      this.autoCreateQuota.reset(existing.peerId)
    }

    return existing
  }

  // ─── Slice 8.11 Layer 2 — driver auto-warm ──────────────────────────
  // Called on the first client connection per (project, daemon-lifetime)
  // from brv-server.ts. Reads each channel's meta.json and spawns ACP
  // drivers for every acp-agent member not already in the pool.
  // Codex Q6 invariants: per-key in-flight guard prevents double-spawn
  // when warm + inviteMember race; post-spawn re-check ensures we don't
  // register a driver for a now-archived channel or now-removed member.
  // V3 reproducer (2026-05-16, line 91: "Driver reinvite needed before
  // every phase") — this method eliminates the workaround.
  public async warmDriversForProject(projectRoot: string): Promise<void> {
    // Idempotent + race-safe: if a warm is already in flight for this
    // project, return the shared promise so concurrent callers (the brv-server
    // onConnection hook + any in-flight dispatchMention) wait on the same
    // pass. Entries clear once the warm settles.
    const existing = this.projectWarmInFlight.get(projectRoot)
    if (existing !== undefined) return existing

    const promise = this.runProjectWarm(projectRoot)
      .finally(() => {
        this.projectWarmInFlight.delete(projectRoot)
      })
    this.projectWarmInFlight.set(projectRoot, promise)
    return promise
  }

  /**
   * Concatenate per-member chunks into a single `finalAnswer`. For a
   * single member, no separator. For fan-out (>= 2 members), prefix each
   * member's section with `\n\n[@<handle>]\n` so the structured response
   * preserves who said what.
   */
  private assembleFinalAnswer(entry: PendingSyncEntry): string {
    const members = [...entry.chunks.entries()]
    if (members.length === 0) return ''
    if (members.length === 1) {
      const [, chunks] = members[0]!
      return chunks.join('')
    }

    const parts: string[] = []
    for (const [member, chunks] of members) {
      parts.push(`${SYNC_FAN_OUT_SEPARATOR}${member}]\n${chunks.join('')}`)
    }

    return parts.join('').trimStart()
  }

  /**
   * Reject the pending entry with a `ChannelError`. Used by timeout,
   * overflow, external cancel, and daemon shutdown paths. Idempotent.
   */
  private failPendingSync(turnId: string, error: Error): void {
    const entry = this.pendingSyncResponses.get(turnId)
    if (entry === undefined || entry.settled) return

    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pendingSyncResponses.delete(turnId)
    entry.reject(error)
  }

  private async fetchPriorTurns(args: {
    channelId: string
    currentTurnId: string
    projectRoot: string
  }): Promise<Turn[]> {
    // Slice 9.3 — listTurns is index-backed for terminal turns; falls
    // back to per-turn readTurn only for in-flight or legacy
    // pre-Phase-9 turns. Lookback rendering uses `turn.promptBlocks`
    // directly (see lookback-builder), so no events replay is needed
    // and no per-turn NDJSON files are opened on this hot path.
    const list = await this.store.listTurns({channelId: args.channelId, projectRoot: args.projectRoot})
    const out: Turn[] = []
    for (const turn of list.turns) {
      if (turn.turnId === args.currentTurnId) continue
      out.push(turn)
    }

    // listTurns returns most-recent-first; the lookback builder takes the
    // tail (last N), so reverse to oldest-first.
    return out.reverse()
  }

  private async finaliseTurn(active: ActiveTurn): Promise<void> {
    // Idempotency guard: cancelTurn and the background streaming task can
    // race to call finaliseTurn (both observe `activeTurns.has(turnId)`
    // true before either calls writeTurnSnapshot). Removing the entry
    // BEFORE any await ensures only one caller proceeds to disk writes.
    if (!this.activeTurns.has(active.turn.turnId)) return
    this.activeTurns.delete(active.turn.turnId)

    // Slice 8.0 — settle the sync-mode pending entry if one exists. For
    // `cancelled` we use the dedicated `CHANNEL_TURN_CANCELLED` reject
    // path (external cancel beat us to the assembled answer) unless the
    // turn cancelled itself via timeout/overflow (entry already settled).
    //
    // Bug 2 follow-up (2026-05-14): if any per-member delivery is in
    // `errored` state when the turn reaches `completed`, reject the
    // pending entry with `CHANNEL_DELIVERY_FAILED` instead of resolving
    // with an empty `finalAnswer`. Without this fix, callers saw
    // `{success: true, endedState: 'completed', finalAnswer: ''}` for
    // turns whose underlying delivery actually failed — the worst-of-
    // both-worlds "success with no answer" shape that masked real
    // failures. See `plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md`.
    if (this.pendingSyncResponses.has(active.turn.turnId)) {
      if (active.turn.state === 'cancelled') {
        this.failPendingSync(
          active.turn.turnId,
          new ChannelTurnCancelledError(active.turn.turnId),
        )
      } else if (active.turn.state === 'completed') {
        const erroredDeliveries = active.deliveries.filter((d) => d.state === 'errored')
        if (erroredDeliveries.length > 0) {
          this.failPendingSync(
            active.turn.turnId,
            new ChannelDeliveryFailedError(
              active.turn.turnId,
              erroredDeliveries.map((d) => ({
                code: d.errorCode,
                handle: d.memberHandle,
                reason: d.errorMessage,
              })),
            ),
          )
        } else {
          this.settlePendingSync(active.turn.turnId, 'completed')
        }
      }
    }

    // Slice 9.6 (codex D3): wrap the disk writes + index append in a
    // try/finally so the held-open per-turn write stream is ALWAYS
    // closed at terminal state, even when a snapshot/index write throws
    // unexpectedly. Without the finally, `activeTurns.delete` above had
    // already removed the idempotency guard and a thrown write would
    // leak the stream's file descriptor until process exit.
    try {
      // Persist turn snapshot + delivery snapshots + message body for each delivery.
      await this.store.writeTurnSnapshot({
        channelId: active.channelId,
        projectRoot: active.projectRoot,
        turn: active.turn,
        turnId: active.turn.turnId,
      })
      for (const delivery of active.deliveries) {
        // eslint-disable-next-line no-await-in-loop
        await this.store.writeDeliverySnapshot({
          channelId: active.channelId,
          delivery,
          deliveryId: delivery.deliveryId,
          projectRoot: active.projectRoot,
          turnId: active.turn.turnId,
        })
      }
    } finally {
      // Slice 9.2 — release the held-open write stream now that the turn
      // has reached terminal state. Subsequent reads come from the closed
      // NDJSON file via the tree-reader's lazy open; the next mention
      // opens a fresh stream for its own turnId. Catch is defensive:
      // a double-close (race with another close path) should not mask
      // the outer error.
      await this.store
        .closeTranscriptStream({
          channelId: active.channelId,
          turnId: active.turn.turnId,
        })
        .catch(() => {
          // intentionally swallowed — see comment above
        })
    }

    // Slice 9.3 — materialise this terminal turn into the per-channel
    // index so the next mention's list-turns + lookback paths skip
    // every per-turn NDJSON open. Kimi 2PC defect: a crash between
    // the per-turn NDJSON snapshot writes above and this index append
    // leaves the index stale; daemon startup's `recoverFromNdjson`
    // sweep rebuilds missing entries from the on-disk NDJSON.
    await this.store.appendTurnIndexEntry({
      channelId: active.channelId,
      entry: {
        deliveries: active.deliveries.map((d) => ({
          deliveryId: d.deliveryId,
          memberHandle: d.memberHandle,
          state: d.state,
        })),
        turn: active.turn,
      },
      projectRoot: active.projectRoot,
    })

    // Slice 9.4 — fire-and-forget transcript GC for this channel. The
    // sweep walks the index, deletes per-turn NDJSON files whose
    // endedAt is older than retention, and compacts the index.
    // Crucially: this is async — it does NOT block the terminal-state
    // path. Failures are swallowed so a GC bug never fails the
    // user-visible turn.
    this.store
      .sweepTranscripts({channelId: active.channelId, projectRoot: active.projectRoot})
      .catch(() => {
        // intentionally swallowed — see comment above
      })

    // Phase 10 Tier C #4 — record per-agent wall-clock duration into
    // the profile metadata store so `channel profile show` surfaces
    // variance. Fire-and-forget: telemetry failures must not fail the
    // user-visible terminal path. Keyed by the member's `agentName`
    // (which by convention matches the driver profile name).
    if (this.profileMetadataStore !== undefined) {
      const completedAtIso = this.clock().toISOString()
      const nowMs = this.clock().getTime()
      for (const delivery of active.deliveries) {
        if (delivery.state !== 'completed') continue
        const member = active.members.find((m) => m.handle === delivery.memberHandle)
        if (member === undefined) continue
        // Telemetry buckets are keyed by agent name (matches driver
        // profile name by convention). Only acp-agent + local-agent
        // members carry `agentName`; human-messaging members are
        // intentionally skipped — they aren't driven by a profile.
        if (member.memberKind !== 'acp-agent' && member.memberKind !== 'local-agent') continue
        const startedAtMs = Date.parse(delivery.startedAt)
        if (!Number.isFinite(startedAtMs)) continue
        const durationMs = Math.max(0, nowMs - startedAtMs)
        this.profileMetadataStore
          .recordTurnDuration({
            completedAt: completedAtIso,
            durationMs,
            endedState: 'completed',
            name: member.agentName,
          })
          .catch(() => {
            // Telemetry-only — never block the terminal path on a
            // metadata write failure.
          })
      }
    }

    this.seqAllocator.reset({channelId: active.channelId, turnId: active.turn.turnId})
  }

  private async handleDriverPayload(
    active: ActiveTurn,
    delivery: TurnDelivery,
    member: ChannelMember,
    payload: TurnEventPayload,
  ): Promise<void> {
    const {channelId} = active
    const {turnId} = active.turn
    const {projectRoot} = active

    // Transition delivery dispatched → streaming on the FIRST upstream event.
    if (delivery.state === 'dispatched') {
      delivery.state = 'streaming'
      await this.persistAndBroadcast(channelId, projectRoot, turnId, {
        channelId,
        deliveryId: delivery.deliveryId,
        emittedAt: this.clock().toISOString(),
        from: 'dispatched',
        kind: 'delivery_state_change',
        memberHandle: member.handle,
        seq: this.seqAllocator.next({channelId, turnId}),
        to: 'streaming',
        turnId,
      })
    }

    if (payload.kind === 'permission_request') {
      // Phase 10 Tier B2 (V6 run-2/run-3 §3b) — try the auto-approver first.
      // If the request is an empty-oldText Edit on a file inside projectRoot,
      // resolve it ourselves WITHOUT transitioning the delivery to
      // awaiting_permission. This skips the human-decision gate for the only
      // operation class where it's structurally safe (Write-equivalent on
      // own-scope file).
      const autoApprove = this.permissionAutoApproveEditAsWrite
        ? decideAutoApprovalForEditAsWrite({
            options: payload.request.options,
            projectRoot,
            toolCall: payload.request.toolCall,
          })
        : undefined

      // Track in the broker BEFORE writing the event so a concurrent
      // permissionDecision finds the pending entry. The track also seeds
      // the broker for auto-approval: resolve() below needs the entry.
      const driver = this.pool.acquire({channelId, memberHandle: delivery.memberHandle})
      if (driver !== undefined) {
        this.permissionBroker.track({
          channelId,
          deliveryId: delivery.deliveryId,
          driver,
          memberHandle: delivery.memberHandle,
          permissionRequestId: payload.permissionRequestId,
          projectRoot,
          turnId,
        })
      }

      if (autoApprove !== undefined && driver !== undefined) {
        // Resolve the broker with the allow-once option. The driver responds
        // via `respondToPermission` and resumes work; the delivery stays in
        // `streaming` so no awaiting_permission event ever lands on the
        // wire. Emit a `permission_decision` event so observers can see what
        // happened.
        //
        // Microtask deferral: the ACP driver's permission gate is set only
        // when the prompt iterator resumes (i.e. AFTER this processPayload
        // call returns and the next `for await` iteration runs). Calling
        // broker.resolve synchronously here would invoke
        // `driver.respondToPermission` before the gate exists and silently
        // drop the response. Scheduling via setImmediate lets the
        // generator advance, register the gate, and THEN see our resolve.
        const outcome = {optionId: autoApprove.optionId, outcome: 'selected' as const}
        const decisionSeq = this.seqAllocator.next({channelId, turnId})
        await this.persistAndBroadcast(channelId, projectRoot, turnId, {
          channelId,
          deliveryId: delivery.deliveryId,
          emittedAt: this.clock().toISOString(),
          kind: 'permission_decision',
          memberHandle: member.handle,
          outcome,
          permissionRequestId: payload.permissionRequestId,
          seq: decisionSeq,
          turnId,
        })
        // Queue the broker.resolve to run AFTER the prompt iterator advances
        // past this yield. The for-await loop drains pendingAutoApprovals[turnId]
        // post-handleDriverPayload, by which point the mock/ACP driver has
        // registered its permission gate. Without this deferral the resolve
        // fires too early and respondToPermission silently no-ops.
        const requestId = payload.permissionRequestId
        const queue = this.pendingAutoApprovals.get(turnId) ?? []
        queue.push(() => this.permissionBroker.resolve({
          channelId,
          outcome,
          permissionRequestId: requestId,
          turnId,
        }).then(() => {
          // Broker resolved → driver.respondToPermission has resumed the
          // generator. Nothing else for us to do; the loop will see the
          // next event on the following iteration.
        }))
        this.pendingAutoApprovals.set(turnId, queue)
      } else if (delivery.state === 'streaming') {
        // Human-decision path (legacy + non-auto-approvable requests).
        // delivery_state_change streaming → awaiting_permission.
        delivery.state = 'awaiting_permission'
        await this.persistAndBroadcast(channelId, projectRoot, turnId, {
          channelId,
          deliveryId: delivery.deliveryId,
          emittedAt: this.clock().toISOString(),
          from: 'streaming',
          kind: 'delivery_state_change',
          memberHandle: member.handle,
          seq: this.seqAllocator.next({channelId, turnId}),
          to: 'awaiting_permission',
          turnId,
        })
      }
    }

    // §9.5.8 Blocker 2 — propagate integrity-degraded markers from the
    // remote-member driver into the delivery record so they are persisted
    // to disk and visible in `brv channel show <turnId> --json`.
    // The driver emits an `agent_meta` event with subKind='parley_integrity'
    // immediately after yielding chunks when sealOrigin !== 'explicit'.
    if (
      payload.kind === 'agent_meta' &&
      payload.subKind === 'parley_integrity' &&
      typeof payload.payload === 'object' &&
      payload.payload !== null
    ) {
      const markers = payload.payload as Record<string, unknown>
      if (typeof markers.sealOrigin === 'string') {
        delivery.sealOrigin = markers.sealOrigin as typeof delivery.sealOrigin
      }

      if (typeof markers.integrityDegraded === 'boolean') {
        delivery.integrityDegraded = markers.integrityDegraded
      }

      if (markers.terminalMissing === true) {
        delivery.terminalMissing = true
      }
    }

    // Wrap the payload with TurnEventBase + seq.
    const wrapped = this.wrapPayload({channelId, delivery, memberHandle: member.handle, payload, turnId})
    await this.persistAndBroadcast(channelId, projectRoot, turnId, wrapped)
  }

  /**
   * Phase 9 / Slice 9.4 — invite a remote brv install as a channel
   * member. Bypasses subprocess spawn + ACP `initialize` (there is no
   * subprocess); instead asks the configured `remotePeerDriverFactory`
   * for a driver that wraps the Parley client.
   *
   * Validates that `multiaddr` carries a `/p2p/<peer-id>` suffix that
   * matches the supplied `peerId` — otherwise a typo would silently let
   * the dialer fail with `TRANSPORT_IDENTITY_MISMATCH` on first
   * mention.
   */
  private async inviteRemotePeerMember(args: InviteMemberArgs): Promise<ChannelMember> {
    if (args.remotePeer === undefined) {
      throw new ChannelInvalidRequestError(
        'inviteRemotePeerMember called without remotePeer payload',
        {fields: ['remotePeer']},
      )
    }

    if (args.invocation !== undefined || args.profileName !== undefined) {
      throw new ChannelInvalidRequestError(
        'channel:invite remotePeer cannot be combined with invocation or profileName',
        {fields: ['remotePeer', 'invocation', 'profileName']},
      )
    }

    if (this.remotePeerDriverFactory === undefined) {
      throw new ChannelInvalidRequestError(
        'CHANNEL_INVITE_REMOTE_UNSUPPORTED: this daemon was started without a remotePeerDriverFactory; remote-peer invites need the Phase-9 bridge wired into orchestrator deps',
        {phase: 9},
      )
    }

    const {displayName, multiaddr, peerId, remoteL2PubKey: supplied} = args.remotePeer

    const suffix = multiaddr.match(/\/p2p\/([1-9A-HJ-NP-Za-km-z]+)$/)
    if (suffix === null) {
      throw new ChannelInvalidRequestError(
        `multiaddr ${multiaddr} is missing a /p2p/<peer-id> suffix`,
        {fields: ['remotePeer.multiaddr']},
      )
    }

    if (suffix[1] !== peerId) {
      throw new ChannelInvalidRequestError(
        `remotePeer.peerId ${peerId} does not match the /p2p/ suffix on multiaddr (${suffix[1]})`,
        {fields: ['remotePeer.peerId', 'remotePeer.multiaddr']},
      )
    }

    // Slice 9.4d — resolve the L2 pubkey in-band when not supplied.
    // The dep (typically backed by `fetchAndPin({fetchTreeCert: true})`
    // in the daemon) dials the remote's `/brv/identity/tree-cert/v1`
    // protocol, validates the chain, and persists the L2 pubkey to the
    // TOFU store. Operators no longer paste `--l2-pub-key` on every
    // invite as of 9.4d.
    let remoteL2PubKey: string
    if (supplied !== undefined) {
      remoteL2PubKey = supplied
    } else if (this.resolveRemotePeerL2PubKey === undefined) {
      throw new ChannelInvalidRequestError(
        'CHANNEL_INVITE_REMOTE_L2_UNRESOLVED: remote L2 public key is required. Either provide --l2-pub-key or upgrade the daemon to enable in-band discovery.',
        {fields: ['remotePeer.remoteL2PubKey']},
      )
    } else {
      try {
        remoteL2PubKey = await this.resolveRemotePeerL2PubKey({multiaddr, peerId})
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        throw new ChannelInvalidRequestError(
          `CHANNEL_INVITE_REMOTE_L2_UNRESOLVED: in-band L2 cert discovery failed: ${msg}. Re-run with --l2-pub-key <base64> from the remote's \`bridge whoami\` banner.`,
          {fields: ['remotePeer.remoteL2PubKey']},
        )
      }
    }

    // Validate L2 pubkey decodes to exactly 32 bytes (raw Ed25519
    // pubkey size) at invite time (kimi round-1 MEDIUM). A bad base64
    // or wrong length would otherwise surface as a late
    // `STREAM_END_SIG_INVALID` on the first mention, which is hard for
    // an operator who pasted the wrong banner value to diagnose.
    const decodedL2 = Buffer.from(remoteL2PubKey, 'base64')
    if (decodedL2.length !== 32) {
      throw new ChannelInvalidRequestError(
        `remotePeer.remoteL2PubKey decoded to ${decodedL2.length} bytes; expected 32 (raw Ed25519 pubkey)`,
        {fields: ['remotePeer.remoteL2PubKey']},
      )
    }

    const driver = await this.remotePeerDriverFactory({
      channelId: args.channelId,
      handle: args.handle,
      multiaddr,
      peerId,
      remoteL2PubKey,
    })
    await driver.start()

    const now = this.clock().toISOString()
    const member: ChannelMember = {
      handle: args.handle,
      joinedAt: now,
      memberKind: 'remote-peer',
      multiaddr,
      peerId,
      remoteL2PubKey,
      status: 'idle',
      ...(displayName === undefined ? {} : {displayName}),
    }

    try {
      await this.store.updateChannelMeta({
        channelId: args.channelId,
        mutate(meta) {
          const existing = meta.members.filter((m) => m.handle !== args.handle)
          return {...meta, members: [...existing, member], updatedAt: now}
        },
        projectRoot: args.projectRoot,
      })
    } catch (error) {
      await driver.stop()
      if (error instanceof Error && /not found/i.test(error.message)) {
        throw new ChannelNotFoundError(args.channelId)
      }

      throw error
    }

    this.pool.register({channelId: args.channelId, driver})
    this.broadcaster.broadcastToChannel(args.channelId, ChannelEvents.MEMBER_UPDATE, {
      channelId: args.channelId,
      member,
      op: 'added',
    })

    return member
  }

  // ─── Slice 8.0 — sync-mode pending-entry lifecycle ──────────────────────

  /**
   * Emit `turn_state_change dispatched → completed` + finalise snapshots
   * ONLY when every delivery has reached a terminal state. Multiple
   * background tasks may call this; the activeTurns Map gate ensures
   * we don't finalise twice.
   */
  // Phase 10 Tier C #2 — auto-idempotency lookup. Returns
  //   - `effectiveKey`: the key we'll persist on the new turn (caller-
  //     provided OR auto-derived from prompt+mentions+5-min bucket).
  //   - `indexKey`: the cache key used in `idempotencyIndex` (composite
  //     of channelId + effectiveKey).
  //   - `cachedResult`: snapshot of the matching active turn, if any.
  //     When set, the caller MUST return this directly and skip the
  //     rest of `dispatchMention`.
  // Sweeps expired index entries as a side effect.
  private lookupIdempotentTurn(args: {
    allHandles: string[]
    channelId: string
    explicitKey: string | undefined
    nowMs: number
    promptBlocks: ContentBlock[]
  }): {
    cachedResult: DispatchMentionResult | undefined
    effectiveKey: string
    indexKey: string
  } {
    this.sweepIdempotencyIndex(args.nowMs)
    const effectiveKey =
      args.explicitKey ??
      deriveIdempotencyKey({
        channelId: args.channelId,
        mentions: args.allHandles,
        nowMs: args.nowMs,
        promptBlocks: args.promptBlocks,
      })
    const indexKey = `${args.channelId}::${effectiveKey}`
    const cached = this.idempotencyIndex.get(indexKey)
    if (cached !== undefined) {
      const cachedActive = this.activeTurns.get(cached.turnId)
      if (cachedActive !== undefined) {
        return {
          cachedResult: {deliveries: cachedActive.deliveries, turn: cachedActive.turn},
          effectiveKey,
          indexKey,
        }
      }
      // Original turn already terminated and dropped from activeTurns;
      // fall through to a fresh dispatch. The stale entry will be
      // overwritten by the new turn's registration.
    }

    return {cachedResult: undefined, effectiveKey, indexKey}
  }

  private async maybeFinaliseTurn(active: ActiveTurn): Promise<void> {
    const {channelId} = active
    const {turnId} = active.turn
    const {projectRoot} = active
    if (!this.activeTurns.has(turnId)) return

    // Review fix #1: cancelTurn flips `active.cancelling = true` synchronously
    // before awaiting the coordinator; the mutation `active.turn.state =
    // 'cancelled'` happens AFTER that await. Without this guard, a background
    // task that completes its delivery DURING the cancel await would see
    // `state === 'dispatched'` (still true) and race to emit
    // `turn_state_change → completed`, leaving the on-disk transcript with
    // two contradictory terminal events. cancelTurn owns finalisation when
    // `cancelling` is set; we bail.
    if (active.cancelling) return

    const allTerminal = active.deliveries.every((d) => !NON_TERMINAL_DELIVERY_STATES.has(d.state))
    if (!allTerminal) return

    if (active.turn.state === 'dispatched') {
      active.turn.state = 'completed'
      active.turn.endedAt = this.clock().toISOString()
      await this.persistAndBroadcast(channelId, projectRoot, turnId, {
        channelId,
        deliveryId: null,
        emittedAt: active.turn.endedAt,
        from: 'dispatched',
        kind: 'turn_state_change',
        memberHandle: null,
        seq: this.seqAllocator.next({channelId, turnId}),
        to: 'completed',
        turnId,
      })
    }

    await this.finaliseTurn(active)
  }

  private async persistAndBroadcast(
    channelId: string,
    projectRoot: string,
    turnId: string,
    event: TurnEvent,
  ): Promise<void> {
    // Slice 8.0 — suppressThoughts policy: drop `agent_thought_chunk`
    // events at this boundary when the active turn opted in. Neither
    // persisted nor broadcast — saves disk + Socket.IO bandwidth for
    // agent-driven sync mentions. Stream callers can still set
    // `suppressThoughts: true` to get the savings without sync mode.
    if (event.kind === 'agent_thought_chunk') {
      const active = this.activeTurns.get(turnId)
      if (active?.suppressThoughts === true) return
    }

    await this.store.appendTurnEvent({channelId, event, projectRoot, turnId})
    this.broadcaster.broadcastToChannel(channelId, ChannelEvents.TURN_EVENT, {channelId, event})

    // Slice 8.0 — sync-mode side-channels. Run AFTER persist+broadcast so
    // the canonical transcript is the source of truth for any reader.
    this.recordSyncEvent(turnId, event)
  }

  /**
   * Side-channel into persist/broadcast that captures sync-relevant
   * events into the per-turn buffer. Idempotent across replays — only
   * `agent_message_chunk`, `tool_call`, and `tool_call_update` events
   * mutate the buffer; everything else is ignored.
   */
  private recordSyncEvent(turnId: string, event: TurnEvent): void {
    const entry = this.pendingSyncResponses.get(turnId)
    if (entry === undefined || entry.settled) return

    switch (event.kind) {
    case 'agent_message_chunk': {
      const member = event.memberHandle ?? '<unknown>'
      const {content} = (event as TurnEvent & {content?: unknown})
      const text = typeof content === 'string' ? content : ''
      if (text.length === 0) return
      const newBytes = Buffer.byteLength(text, 'utf8')
      if (entry.bytesWritten + newBytes > entry.byteBudget) {
        this.failPendingSync(
          turnId,
          new ChannelSyncOverflowError(turnId, entry.byteBudget),
        )
        // Trigger a real cancel so the turn produces a terminal event.
        this.scheduleCancelForSyncFailure(entry)
        return
      }

      entry.bytesWritten += newBytes
      const existing = entry.chunks.get(member)
      if (existing === undefined) {
        entry.chunks.set(member, [text])
      } else {
        existing.push(text)
      }
    
    break;
    }

    case 'tool_call': {
      const callId = (event as TurnEvent & {toolCallId?: unknown}).toolCallId
      const {name} = (event as TurnEvent & {name?: unknown})
      if (typeof callId === 'string') {
        entry.toolCalls.set(callId, {
          callId,
          name: typeof name === 'string' ? name : '<tool>',
        })
      }
    
    break;
    }

    case 'tool_call_update': {
      const callId = (event as TurnEvent & {toolCallId?: unknown}).toolCallId
      const {status} = (event as TurnEvent & {status?: unknown})
      if (typeof callId === 'string') {
        const existing = entry.toolCalls.get(callId)
        if (existing !== undefined && typeof status === 'string') {
          entry.toolCalls.set(callId, {...existing, status})
        }
      }
    
    break;
    }
    // No default
    }
  }

  /**
   * Synchronously register a pending-sync entry for `turnId`. Called
   * from `dispatchMention` BEFORE any background streaming task can
   * emit chunks, so the buffer never misses an event. `awaitSyncMention`
   * returns the entry's promise.
   */
  private registerPendingSync(args: {
    channelId: string
    timeout?: number
    turnId: string
  }): void {
    const byteBudget = resolveSyncByteBudget()
    const timeoutMs = args.timeout === undefined ? DEFAULT_SYNC_TIMEOUT_MS : args.timeout
    let resolveFn!: (result: ChannelMentionSyncResult) => void
    let rejectFn!: (error: Error) => void
    const promise = new Promise<ChannelMentionSyncResult>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })

    const entry: PendingSyncEntry = {
      byteBudget,
      bytesWritten: 0,
      channelId: args.channelId,
      chunks: new Map(),
      reject: rejectFn,
      resolve: resolveFn,
      settled: false,
      startedAtMs: this.clock().getTime(),
      toolCalls: new Map(),
      turnId: args.turnId,
    }

    entry.timer = setTimeout(() => {
      // Phase 10 follow-up A2 — surface partial finalAnswer (assembled
      // from buffered chunks) on the timeout error so callers can recover
      // in-progress streaming output instead of dropping it.
      const pending = this.pendingSyncResponses.get(args.turnId)
      const partial = pending === undefined ? '' : this.assembleFinalAnswer(pending)
      this.failPendingSync(
        args.turnId,
        new ChannelSyncTimeoutError(
          args.turnId,
          timeoutMs,
          partial === '' ? undefined : partial,
        ),
      )
    }, timeoutMs)
    // Don't keep the daemon alive just for a timeout-driven cleanup.
    if (typeof entry.timer.unref === 'function') entry.timer.unref()

    this.pendingSyncResponses.set(args.turnId, entry)
    // Stash the promise on the entry so awaitSyncMention can find it.
    ;(entry as PendingSyncEntry & {promise: Promise<ChannelMentionSyncResult>}).promise = promise
  }

  /**
   * Fan-out scheduler: when an in-flight delivery reaches a terminal
   * state, find the next `queued` delivery (FIFO order matches mention
   * order from {@link parseMentions}) and dispatch it.
   */
  private async releaseNextQueued(active: ActiveTurn, normalisedPromptBlocks: ContentBlock[]): Promise<void> {
    // Race guard: if cancelTurn has begun, do not dispatch new deliveries.
    // The cancel coordinator's existing loop is responsible for emitting
    // `queued → cancelled` events for every remaining queued delivery.
    if (active.cancelling) return
    const next = active.deliveries.find((d) => d.state === 'queued')
    if (next === undefined) return
    const member = active.members.find((m) => m.handle === next.memberHandle)
    if (member === undefined) {
      next.state = 'errored'
      return
    }

    next.state = 'dispatched'
    await this.persistAndBroadcast(active.channelId, active.projectRoot, active.turn.turnId, {
      channelId: active.channelId,
      deliveryId: next.deliveryId,
      emittedAt: this.clock().toISOString(),
      from: 'queued',
      kind: 'delivery_state_change',
      memberHandle: next.memberHandle,
      seq: this.seqAllocator.next({channelId: active.channelId, turnId: active.turn.turnId}),
      to: 'dispatched',
      turnId: active.turn.turnId,
    })

    // Fire-and-forget — errors surface via delivery_state_change → errored.
    this.runBackgroundStreaming(active, member, next, normalisedPromptBlocks).catch(() => {})
  }

  private async runBackgroundStreaming(
    active: ActiveTurn,
    member: ChannelMember,
    delivery: TurnDelivery,
    normalisedPromptBlocks: ContentBlock[],
  ): Promise<void> {
    const {channelId} = active
    const {turnId} = active.turn
    const {projectRoot} = active

    const driver = this.pool.acquire({channelId, memberHandle: member.handle})
    if (driver === undefined) {
      // Slice 8.11 Layer 1: surface CHANNEL_DRIVER_NOT_REGISTERED instead of
      // the misleading `'unknown'` (errors.ts fallback). Populate
      // delivery.errorCode/Message AND emit a delivery_state_change → errored
      // event so subscribe/watch hosts see the transition (codex Q6).
      // V3 super-mario reproducer (2026-05-16, line 91).
      const from = delivery.state
      delivery.errorCode = CHANNEL_ERROR_CODE.DRIVER_NOT_REGISTERED
      delivery.errorMessage =
        `No live ACP driver registered for ${member.handle} in channel #${channelId}. ` +
        `Daemon may have restarted before warmDriversForProject fired. ` +
        `Re-invite the member: brv channel invite ${channelId} ${member.handle} --profile <name>`
      delivery.state = 'errored'
      await this.persistAndBroadcast(channelId, projectRoot, turnId, {
        channelId,
        deliveryId: delivery.deliveryId,
        emittedAt: this.clock().toISOString(),
        error: delivery.errorMessage,
        errorCode: delivery.errorCode,
        from,
        kind: 'delivery_state_change',
        memberHandle: member.handle,
        seq: this.seqAllocator.next({channelId, turnId}),
        to: 'errored',
        turnId,
      })
      // Don't tear down the whole turn — other deliveries may still be running.
      await this.maybeFinaliseTurn(active)
      return
    }

    // Build lookback prefix (capability-gated). Fetch the channel's prior
    // turns from the store so the renderer has actual context to fold in.
    const acpMember = member.memberKind === 'acp-agent' ? member : undefined
    const capabilities = acpMember?.capabilities ?? []
    const priorTurns = await this.fetchPriorTurns({channelId, currentTurnId: turnId, projectRoot})
    const lookback = buildLookback({
      capabilities,
      channelId,
      normalisedPromptBlocks,
      priorTurns,
    })

    const envelope = {
      author: active.turn.author,
      channelId,
      deliveryId: delivery.deliveryId,
      lookbackDigest: lookback.digest,
      members: [],
      mentions: active.turn.mentions,
      schemaVersion: '1',
      turnId,
    }

    try {
      const iterator = driver.prompt({
        meta: {_meta: {'brv.channel': envelope}},
        prompt: lookback.blocks,
        turnId,
      })

      // Phase 10 Tier B2 — manual iteration (instead of `for await`) so we can
      // kick off `iterator.next()` BEFORE firing pending auto-approve resolves.
      // Calling .next() on the async generator synchronously runs it from
      // after the previous yield up to the next yield/await — i.e. it runs
      // `gates.set(id, {resolve})` for permission_request events, REGISTERING
      // the gate. Only then do we fire the queued broker.resolve, so
      // driver.respondToPermission sees the gate.
       
      let iterResult = await iterator.next()
      while (!iterResult.done) {
        const payload = iterResult.value

        // eslint-disable-next-line no-await-in-loop
        await this.handleDriverPayload(active, delivery, member, payload)

        // Drain pending auto-approve resolves AFTER kicking off the next
        // iteration. The .next() call synchronously runs the generator
        // until its next yield/await — registering gates.set BEFORE our
        // resolves fire.
        // Codex F5: delete the map entry instead of leaving an empty array,
        // so the map doesn't accumulate one-per-turn cruft across long-lived
        // daemons.
        const drained = this.pendingAutoApprovals.get(active.turn.turnId) ?? []
        if (drained.length > 0) this.pendingAutoApprovals.delete(active.turn.turnId)
        const nextPromise = iterator.next()
        for (const resolveFn of drained) {
          // Fire-and-forget: queues as microtask after the generator's
          // .next() continuation, which itself queued its gates.set as
          // a synchronous side effect during the .next() call.
          resolveFn().catch(() => {
            // Broker resolve can fail if the permission was concurrently
            // drained (e.g. cancelTurn during the deferral window). The
            // cancel path emits its own terminal events; nothing to do.
          })
        }

        // eslint-disable-next-line no-await-in-loop
        iterResult = await nextPromise
      }

      // Driver returned normally → delivery completed.
      if (NON_TERMINAL_DELIVERY_STATES.has(delivery.state)) {
        const from = delivery.state
        delivery.state = 'completed'
        await this.persistAndBroadcast(channelId, projectRoot, turnId, {
          channelId,
          deliveryId: delivery.deliveryId,
          emittedAt: this.clock().toISOString(),
          from,
          kind: 'delivery_state_change',
          memberHandle: member.handle,
          seq: this.seqAllocator.next({channelId, turnId}),
          to: 'completed',
          turnId,
        })
      }
    } catch (error) {
      // Background-task error path: mark delivery errored, do NOT propagate.
      const reason = error instanceof Error ? error.message : String(error)
      const promptError = new AcpPromptFailedError(reason)
      if (NON_TERMINAL_DELIVERY_STATES.has(delivery.state)) {
        const from = delivery.state
        delivery.state = 'errored'
        delivery.errorCode = promptError.code
        delivery.errorMessage = promptError.message
        await this.persistAndBroadcast(channelId, projectRoot, turnId, {
          channelId,
          deliveryId: delivery.deliveryId,
          emittedAt: this.clock().toISOString(),
          error: promptError.message,
          from,
          kind: 'delivery_state_change',
          memberHandle: member.handle,
          seq: this.seqAllocator.next({channelId, turnId}),
          to: 'errored',
          turnId,
        })
      }
    }

    // If the cancel coordinator already finalised the turn, skip.
    if (!this.activeTurns.has(turnId)) return

    // Fan-out: release the next queued delivery, if any.
    await this.releaseNextQueued(active, normalisedPromptBlocks)

    // Try to finalise — only when every delivery is terminal.
    await this.maybeFinaliseTurn(active)
  }

  private async runProjectWarm(projectRoot: string): Promise<void> {
    // Defensive against pre-existing strict-validation bug in `tryReadMeta`
    // (channel-store.ts re-throws Zod parse errors). `listChannels` would
    // fail-the-whole-call on a single legacy/malformed meta.json, blocking
    // warm for every valid channel in the same project. We bypass it: read
    // the channel directory directly, then try-read each meta with per-
    // channel error handling. One bad meta logs + skips, others warm.
    // The underlying listChannels tolerance bug is tracked as a follow-up.
    const channelsRoot = channelPaths.channelsRoot(projectRoot)
    let entries: string[]
    try {
      entries = await fs.readdir(channelsRoot)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      // Best-effort: log via stdout (orchestrator has no logger by design;
      // brv-server's .catch() also logs the rejection).
      throw error
    }

    await Promise.allSettled(
      entries.map(async (channelId) => {
        const meta = await this.store.readChannelMeta({channelId, projectRoot}).catch(() => null)
        if (meta === null || meta === undefined) return
        if (meta.archivedAt !== undefined) return
        const results = await Promise.allSettled([
          ...meta.members
            .filter((m): m is ChannelMemberAcpAgent => m.memberKind === 'acp-agent')
            .map((m) => this.warmOneDriver(meta.channelId, projectRoot, m)),
          // Phase 9 / Slice 9.4b — reconstitute remote-peer drivers
          // from persisted meta. Without this, the daemon would have
          // a `remote-peer` member in meta.json but no driver in the
          // pool after restart, surfacing as
          // `CHANNEL_DRIVER_NOT_REGISTERED` on the next mention.
          ...meta.members
            .filter((m): m is ChannelMemberRemotePeer => m.memberKind === 'remote-peer')
            .map((m) => this.warmRemotePeerDriver(meta.channelId, m)),
        ])

        // Surface silent warm failures (kimi round-1 MEDIUM —
        // previously the `Promise.allSettled` swallowed them and the
        // operator only saw `CHANNEL_DRIVER_NOT_REGISTERED` on the
        // next mention with no upstream signal).
        for (const r of results) {
          if (r.status === 'rejected') {
            const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
            console.warn(`[channel] warm-driver failed for ${meta.channelId}: ${reason}`)
          }
        }
      }),
    )
  }

  /**
   * Overflow path — eagerly fail the pending entry, then schedule a
   * real `cancelTurn` so the turn produces a terminal `cancelled` event
   * on disk. Without this, an unbounded streaming agent could leak the
   * `activeTurns` entry.
   */
  private scheduleCancelForSyncFailure(entry: PendingSyncEntry): void {
    const active = this.activeTurns.get(entry.turnId)
    if (active === undefined) return
    // Fire-and-forget — errors during cancel surface via cancel's own
    // wire events; we've already failed the sync caller.
    this.cancelTurn({
      channelId: entry.channelId,
      projectRoot: active.projectRoot,
      turnId: entry.turnId,
    }).catch(() => {
      // Fire-and-forget: sync caller already failed; cancel errors are
      // surfaced via the cancel path's own wire events.
    })
  }

  /**
   * Called from `finaliseTurn` when an active turn reaches a terminal
   * state (completed or cancelled). Assembles `finalAnswer` from the
   * per-member buffer and resolves the pending promise. No-op if there
   * is no pending entry or it was already settled by timeout/overflow.
   */
  private settlePendingSync(turnId: string, endedState: 'cancelled' | 'completed'): void {
    const entry = this.pendingSyncResponses.get(turnId)
    if (entry === undefined || entry.settled) return

    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    this.pendingSyncResponses.delete(turnId)

    const finalAnswer = this.assembleFinalAnswer(entry)
    const durationMs = this.clock().getTime() - entry.startedAtMs
    const toolCalls = [...entry.toolCalls.values()]

    entry.resolve({
      channelId: entry.channelId,
      durationMs,
      endedState,
      finalAnswer,
      toolCalls,
      turnId: entry.turnId,
    })
  }

  // Phase 10 Tier C #2 — drop expired idempotency entries. Cheap O(N)
  // scan called once per dispatch; N is bounded by activity in the
  // last 5 minutes, so practical sizes stay small even on busy
  // daemons.
  private sweepIdempotencyIndex(nowMs: number): void {
    for (const [k, v] of this.idempotencyIndex) {
      if (v.expiresAtMs <= nowMs) this.idempotencyIndex.delete(k)
    }
  }

  // Per-key in-flight guard: dedupe concurrent warms for the same
  // (channelId, memberHandle). Returns the shared promise if one is in
  // flight, otherwise starts a new spawn and tracks it.
  private warmOneDriver(channelId: string, projectRoot: string, member: ChannelMemberAcpAgent): Promise<void> {
    if (this.pool.acquire({channelId, memberHandle: member.handle}) !== undefined) {
      return Promise.resolve()
    }

    const key = `${channelId}\0${member.handle}`
    const existing = this.warmInFlight.get(key)
    if (existing !== undefined) return existing

    const promise = (async () => {
      try {
        const driver = this.driverFactory(member.invocation, member.handle)
        await driver.start()

        // Codex Q4 race re-check: meta may have changed during the ACP handshake
        // (channel archived, member removed, etc). Re-read and validate before
        // registering to prevent zombie drivers in archived channels.
        const fresh = await this.store.readChannelMeta({channelId, projectRoot})
        const stillValid =
          fresh !== undefined &&
          fresh.archivedAt === undefined &&
          fresh.members.some((m) => m.handle === member.handle && m.memberKind === 'acp-agent')
        if (!stillValid) {
          await driver.stop()
          return
        }

        // Concurrent inviteMember may have raced to register — final check.
        if (this.pool.acquire({channelId, memberHandle: member.handle}) !== undefined) {
          await driver.stop()
          return
        }

        this.pool.register({channelId, driver})
      } finally {
        this.warmInFlight.delete(key)
      }
    })()
    this.warmInFlight.set(key, promise)
    return promise
  }

  /**
   * Phase 9 / Slice 9.4b — restart-time reconstitution of a remote-peer
   * driver. Re-runs the same `remotePeerDriverFactory` invoked at
   * invite time and registers the resulting driver in the pool.
   *
   * Best-effort: if the factory rejects (e.g. libp2p bootstrap fails),
   * the failure is swallowed and the channel becomes mention-unable
   * for the remote peer until the daemon restarts again or the
   * operator re-invites. The orchestrator's existing
   * `CHANNEL_DRIVER_NOT_REGISTERED` error surfaces on subsequent
   * mentions — same UX as for a missing ACP subprocess.
   */
  private async warmRemotePeerDriver(
    channelId: string,
    member: ChannelMemberRemotePeer,
  ): Promise<void> {
    if (this.pool.acquire({channelId, memberHandle: member.handle}) !== undefined) {
      return
    }

    if (this.remotePeerDriverFactory === undefined) return

    // Phase 9 / Slice 9.4e (kimi round-1 MED-5) — bridge-auto-
    // provisioned mirror members on the RECEIVING side carry only
    // `peerId` (the sender's libp2p identity). They have no observed
    // `multiaddr` and no fetched L2 pubkey until the operator runs
    // `brv channel invite` with real values. Skip the driver warm —
    // any mention against such a member will surface
    // `CHANNEL_DRIVER_NOT_REGISTERED`, prompting the operator to
    // upgrade the member record.
    if (member.multiaddr === undefined || member.remoteL2PubKey === undefined) {
      return
    }

    // Phase 9 / Slice 9.4i — re-resolve the L2 pubkey at warm time
    // so a long-running Alice daemon doesn't keep using a pubkey that
    // expired (or whose cert was rotated) after the invite landed.
    // The daemon's `resolveRemotePeerL2PubKey` already implements
    // expiry-aware caching (9.4h), so reuse it via the pure helper.
    const remoteL2PubKey = (await refreshRemotePeerL2PubKey({
      member: {
        multiaddr: member.multiaddr,
        peerId: member.peerId,
        remoteL2PubKey: member.remoteL2PubKey,
      },
      resolve: this.resolveRemotePeerL2PubKey,
    })) ?? member.remoteL2PubKey

    const driverArgs = {
      channelId,
      handle: member.handle,
      multiaddr: member.multiaddr,
      peerId: member.peerId,
      remoteL2PubKey,
    }

    const key = `${channelId}\0${member.handle}`
    const existing = this.warmInFlight.get(key)
    if (existing !== undefined) return existing

    const promise = (async () => {
      try {
        const driver = await this.remotePeerDriverFactory!(driverArgs)
        await driver.start()
        if (this.pool.acquire({channelId, memberHandle: member.handle}) !== undefined) {
          await driver.stop()
          return
        }

        this.pool.register({channelId, driver})
      } finally {
        this.warmInFlight.delete(key)
      }
    })()
    this.warmInFlight.set(key, promise)
    return promise
  }

  private wrapPayload(args: {
    channelId: string
    delivery: TurnDelivery
    memberHandle: string
    payload: TurnEventPayload
    turnId: string
  }): TurnEvent {
    const base = {
      channelId: args.channelId,
      deliveryId: args.delivery.deliveryId,
      emittedAt: this.clock().toISOString(),
      memberHandle: args.memberHandle,
      seq: this.seqAllocator.next({channelId: args.channelId, turnId: args.turnId}),
      turnId: args.turnId,
    } as const
    return {...args.payload, ...base} as TurnEvent
  }
}
