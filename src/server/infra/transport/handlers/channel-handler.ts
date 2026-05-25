import type {z} from 'zod'

import type {IChannelOrchestrator} from '../../../core/interfaces/channel/i-channel-orchestrator.js'
import type {IDriverProfileStore} from '../../../core/interfaces/channel/i-driver-profile-store.js'
import type {
  ITransportServer,
  RequestContext,
  RequestHandler,
} from '../../../core/interfaces/transport/i-transport-server.js'
import type {IChannelDoctorService} from '../../channel/doctor-service.js'
import type {IChannelOnboardService} from '../../channel/onboard-service.js'
import type {IProfileMetadataStore} from '../../channel/profile-metadata-store.js'

import {
  ChannelArchiveRequestSchema,
  ChannelCancelRequestSchema,
  ChannelCreateRequestSchema,
  ChannelDoctorRequestSchema,
  ChannelEvents,
  ChannelGetRequestSchema,
  ChannelGetTurnRequestSchema,
  ChannelInviteRequestSchema,
  ChannelListRequestSchema,
  ChannelListTurnsRequestSchema,
  ChannelMentionQuorumRequestSchema,
  ChannelMentionRequestSchema,
  ChannelOnboardRequestSchema,
  ChannelPermissionDecisionRequestSchema,
  ChannelPostRequestSchema,
  ChannelProfileClearDriftRequestSchema,
  ChannelProfileListRequestSchema,
  ChannelProfileRecordDriftRequestSchema,
  ChannelProfileRemoveRequestSchema,
  ChannelProfileShowRequestSchema,
  ChannelRotateTokenRequestSchema,
  ChannelShowQuorumRequestSchema,
  ChannelUninviteRequestSchema,
} from '../../../../shared/transport/events/channel-events.js'
import {
  ChannelInvalidRequestError,
  ChannelProfileNotFoundError,
} from '../../../core/domain/channel/errors.js'
import {makeChannelAuthMiddleware} from '../../auth/channel-auth-middleware.js'

/**
 * Phase-1 channel transport handler.
 *
 * Registers handlers for the 7 client-to-host events that Phase 1 supports
 * (create/list/get/archive/post/list-turns/get-turn). Each handler:
 *
 *   1. Runs behind the {@link makeChannelAuthMiddleware} so missing or
 *      invalid tokens fail with CHANNEL_UNAUTHORIZED before any orchestrator
 *      method is called.
 *   2. Validates the request payload against the zod schema for that event
 *      (CHANNEL_PROTOCOL.md §8); validation failures throw
 *      CHANNEL_INVALID_REQUEST with structured `details` so clients can
 *      surface specific field errors.
 *   3. Pulls `projectRoot` from `ctx.cwd` (Socket.IO handshake `cwd` query
 *      param). Missing cwd is treated as CHANNEL_INVALID_REQUEST — Phase 1
 *      clients always send a cwd.
 *   4. Delegates to the orchestrator and forwards the response or
 *      ChannelError back through the transport's error envelope.
 *
 * Phase-2 events (mention/cancel/invite/uninvite/members/permission) are
 * deliberately NOT registered. Phase-3 events (onboard/doctor) are also
 * absent. Broadcasts (channel:turn-event, channel:member-update,
 * channel:state-change) are emitted by the orchestrator via the broadcaster;
 * they are not request handlers.
 */
export type ChannelHandlerDeps = {
  /**
   * Either a static token (legacy / unit tests) OR a provider callback
   * (production wiring as of Slice 3.5a). The middleware reads the value
   * on every request so rotation takes effect without re-registering.
   */
  readonly authToken: (() => string) | string
  /** Phase-3 doctor service. Optional so Phase-1/2 tests can omit it. */
  readonly doctorService?: IChannelDoctorService
  /** Phase-3 onboard service. Optional so Phase-1/2 tests can omit it. */
  readonly onboardService?: IChannelOnboardService
  readonly orchestrator: IChannelOrchestrator
  /**
   * Phase 10 Tier B3 — local-only profile metadata store (drift
   * observations, last-probe state). Optional so Phase-1/2 and
   * Phase-3-without-metadata tests can omit it.
   */
  readonly profileMetadataStore?: IProfileMetadataStore
  /** Phase-3 driver-profile registry. Optional so Phase-1/2 tests can omit it. */
  readonly profileStore?: IDriverProfileStore
  /**
   * Phase-3 token-rotation callback. The handler fires this when
   * `channel:rotate-token` runs successfully. Slice 3.5 wires this to
   * disconnect every active client + emit a structured INFO log.
   */
  readonly rotateToken?: () => Promise<{disconnectedClients: number; tokenFingerprint: string}>
}

/**
 * Subset of {@link ITransportServer} the handler depends on. Exposed
 * separately so tests can stub registration without booting Socket.IO.
 */
type TransportRegistry = Pick<ITransportServer, 'onRequest'>

const parseOrThrow = <T>(schema: z.ZodType<T>, data: unknown): T => {
  const parsed = schema.safeParse(data)
  if (!parsed.success) {
    throw new ChannelInvalidRequestError(
      'channel request payload failed schema validation',
      parsed.error.flatten(),
    )
  }

  return parsed.data
}

const projectRootFromCtx = (ctx?: RequestContext): string => {
  const cwd = ctx?.cwd
  if (typeof cwd !== 'string' || cwd === '') {
    throw new ChannelInvalidRequestError(
      'channel handlers require the client to send `cwd` on the Socket.IO handshake to resolve the project root',
      {field: 'cwd'},
    )
  }

  return cwd
}

export class ChannelHandler {
  private readonly authToken: (() => string) | string
  private readonly doctorService: IChannelDoctorService | undefined
  private readonly onboardService: IChannelOnboardService | undefined
  private readonly orchestrator: IChannelOrchestrator
  private readonly profileMetadataStore: IProfileMetadataStore | undefined
  private readonly profileStore: IDriverProfileStore | undefined
  private readonly rotateTokenFn: (() => Promise<{disconnectedClients: number; tokenFingerprint: string}>) | undefined

  public constructor(deps: ChannelHandlerDeps) {
    this.authToken = deps.authToken
    this.doctorService = deps.doctorService
    this.onboardService = deps.onboardService
    this.orchestrator = deps.orchestrator
    this.profileMetadataStore = deps.profileMetadataStore
    this.profileStore = deps.profileStore
    this.rotateTokenFn = deps.rotateToken
  }

  registerOn(transport: TransportRegistry): void {
    const withAuth = makeChannelAuthMiddleware(this.authToken)

    const register = <TReq, TRes>(event: string, inner: RequestHandler<TReq, TRes>): void => {
      transport.onRequest(event, withAuth(inner))
    }

    // channel:create
    register(ChannelEvents.CREATE, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelCreateRequestSchema, data)
      const channel = await this.orchestrator.createChannel({
        channelId: req.channelId,
        projectRoot,
        title: req.title,
      })
      return {channel}
    })

    // channel:list
    register(ChannelEvents.LIST, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelListRequestSchema, data)
      const channels = await this.orchestrator.listChannels({
        archived: req.archived,
        projectRoot,
      })
      return {channels}
    })

    // channel:get
    register(ChannelEvents.GET, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelGetRequestSchema, data)
      const channel = await this.orchestrator.getChannel({
        channelId: req.channelId,
        projectRoot,
      })
      return {channel}
    })

    // channel:archive
    register(ChannelEvents.ARCHIVE, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelArchiveRequestSchema, data)
      const channel = await this.orchestrator.archiveChannel({
        channelId: req.channelId,
        projectRoot,
      })
      return {channel}
    })

    // channel:post (passive turn)
    register(ChannelEvents.POST, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelPostRequestSchema, data)
      const turn = await this.orchestrator.postTurn({
        channelId: req.channelId,
        idempotencyKey: req.idempotencyKey,
        projectRoot,
        prompt: req.prompt,
        promptBlocks: req.promptBlocks,
      })
      // CHANNEL_PROTOCOL.md §8.4: passive turns return `{turn, deliveries: []}`
      // but the deliveries field is optional in the response schema.
      return {turn}
    })

    // channel:list-turns
    register(ChannelEvents.LIST_TURNS, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelListTurnsRequestSchema, data)
      const result = await this.orchestrator.listTurns({
        channelId: req.channelId,
        cursor: req.cursor,
        limit: req.limit,
        projectRoot,
      })
      return {nextCursor: result.nextCursor, turns: result.turns}
    })

    // channel:get-turn
    register(ChannelEvents.GET_TURN, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelGetTurnRequestSchema, data)
      const result = await this.orchestrator.getTurn({
        channelId: req.channelId,
        projectRoot,
        turnId: req.turnId,
      })
      // Phase-1 passive turns: omit `deliveries` entirely (the field is
      // optional in `ChannelGetTurnResponseSchema` per fixup `bae8bbf2`).
      // Phase-2 active turns: forward the reconstructed delivery list.
      return result.deliveries === undefined
        ? {events: result.events, turn: result.turn}
        : {deliveries: result.deliveries, events: result.events, turn: result.turn}
    })

    // ─── Phase-2 request events ───────────────────────────────────────

    // channel:invite
    register(ChannelEvents.INVITE, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelInviteRequestSchema, data)
      const member = await this.orchestrator.inviteMember({
        capabilities: req.capabilities,
        channelId: req.channelId,
        handle: req.handle,
        invocation: req.invocation,
        profileName: req.profileName,
        projectRoot,
        remotePeer: req.remotePeer,
      })
      return {member}
    })

    // channel:uninvite
    register(ChannelEvents.UNINVITE, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelUninviteRequestSchema, data)
      const member = await this.orchestrator.uninviteMember({
        channelId: req.channelId,
        memberHandle: req.memberHandle,
        projectRoot,
      })
      return {member}
    })

    // channel:mention — synchronous validation + dispatch; background streams.
    // Slice 8.0 — when `mode: 'sync'`, the handler awaits the orchestrator's
    // pending-sync promise and returns the assembled `ChannelMentionSyncResponse`
    // instead of the immediate `ChannelTurnAcceptedResponse`.
    register(ChannelEvents.MENTION, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelMentionRequestSchema, data)
      const result = await this.orchestrator.dispatchMention({
        channelId: req.channelId,
        idempotencyKey: req.idempotencyKey,
        mentions: req.mentions,
        mode: req.mode,
        projectRoot,
        prompt: req.prompt,
        promptBlocks: req.promptBlocks,
        suppressThoughts: req.suppressThoughts,
        timeout: req.timeout,
      })

      if (req.mode === 'sync') {
        return this.orchestrator.awaitSyncMention(result.turn.turnId)
      }

      return {deliveries: result.deliveries, turn: result.turn}
    })

    // channel:mention-quorum (Phase 10 Slice 10.2/10.3/10.4) — daemon-side
    // K-way fan-out via QuorumDispatcher + local-first orchestration with
    // remote escalation. Resolves selected agents from channel membership,
    // applies stake-driven sizing, runs the dispatcher (no shell-out — codex
    // Q4), returns a serialised `MergedQuorum` + escalation metadata.
    register(ChannelEvents.MENTION_QUORUM, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelMentionQuorumRequestSchema, data)
      const policyName = req.mergePolicy ?? 'union'
      if (policyName !== 'union') {
        throw new ChannelInvalidRequestError(
          `Merge policy '${policyName}' is not implemented in Tier 1 (CrdtUnionMergePolicy only).`,
          {mergePolicy: policyName},
        )
      }

      if (req.localOnly === true && req.remoteOnly === true) {
        throw new ChannelInvalidRequestError(
          '--local-only and --remote-only are mutually exclusive.',
          {localOnly: true, remoteOnly: true},
        )
      }

      const channel = await this.orchestrator.getChannel({
        channelId: req.channelId,
        projectRoot,
      })
      const handles = new Set(req.mentions)
      const allSelected = channel.members.filter(m => handles.has(m.handle))
      const missing = req.mentions.filter(h => !channel.members.some(m => m.handle === h))
      if (missing.length > 0) {
        throw new ChannelInvalidRequestError(
          `Unknown channel member(s): ${missing.join(', ')}`,
          {missingHandles: missing},
        )
      }

      // Lazy import — keeps the channel-handler module free of quorum types
      // unless this code path runs (and avoids a circular import chain in
      // tests that stub the orchestrator).
      const {CrdtUnionMergePolicy} = await import('../../channel/quorum/merge-policy.js')
      const {QuorumDispatcher} = await import('../../channel/quorum/dispatcher.js')
      const {dispatchLocalFirst} = await import('../../channel/quorum/local-first.js')
      const {dispatchParallelPools} = await import('../../channel/quorum/parallel-pools.js')
      const {LocalMatchmaker} = await import('../../channel/quorum/matchmaker.js')
      const {classifyAgent} = await import('../../channel/quorum/pools.js')
      const {writeQuorumSnapshot} = await import('../../channel/quorum/quorum-store.js')
      const {DEFAULT_STAKE, resolveStakeGroupSize} = await import('../../channel/quorum/stake.js')

      // Phase 10 Slice 10.4 — derive local/remote dispatch counts from stake.
      // The stake matrix caps how many local + remote agents the dispatcher
      // actually fan-outs to (`--quorum` is the agreement threshold within
      // that pool).
      const stake = req.stake ?? DEFAULT_STAKE
      const groupSize = resolveStakeGroupSize(stake)

      const localCandidates = allSelected.filter(a => classifyAgent(a) === 'local')
      const remoteCandidates = allSelected.filter(a => classifyAgent(a) === 'remote')

      // Phase 10 Slice 10.6 — when `needs` is provided, score each pool's
      // candidates against the requested tags via the matchmaker so the
      // highest-strength agents are picked BEFORE stake sizing trims.
      const matchmaker = new LocalMatchmaker()
      const localCount = req.remoteOnly === true ? 0 : Math.min(groupSize.local, localCandidates.length)
      const remoteCount = req.localOnly === true ? 0 : Math.min(groupSize.remote, remoteCandidates.length)
      const neededTags = req.needs ?? []
      const dispatchAgents = [
        ...matchmaker.matchAgents({neededTags, poolMembers: localCandidates, targetSize: localCount}),
        ...matchmaker.matchAgents({neededTags, poolMembers: remoteCandidates, targetSize: remoteCount}),
      ]

      if (dispatchAgents.length === 0) {
        throw new ChannelInvalidRequestError(
          `No agents available for stake=${stake} (local=${localCount}, remote=${remoteCount}) against ${allSelected.length} mentioned member(s).`,
          {localCount, remoteCount, stake},
        )
      }

      // Kimi F5: fail fast when the requested quorum threshold exceeds the
      // number of dispatched agents — otherwise every claim trivially lands
      // in `pending` with `partial: true`, which is valid but almost always
      // a caller error.
      if (req.quorumThreshold > dispatchAgents.length) {
        throw new ChannelInvalidRequestError(
          `Quorum threshold ${req.quorumThreshold} exceeds dispatched agents ${dispatchAgents.length} for stake=${stake}.`,
          {dispatchedAgents: dispatchAgents.length, quorumThreshold: req.quorumThreshold, stake},
        )
      }

      const dispatchId = `quorum-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const dispatcher = new QuorumDispatcher({orchestrator: this.orchestrator})
      const poolMode = req.poolMode ?? 'local-first'

      if (poolMode === 'parallel') {
        // Slice 10.5 — concurrent local + remote dispatch with per-pool timeouts.
        const result = await dispatchParallelPools(dispatcher, {
          agents: dispatchAgents,
          channelId: req.channelId,
          dispatchId,
          localTimeoutMs: req.localTimeoutMs,
          mergePolicy: new CrdtUnionMergePolicy(),
          projectRoot,
          prompt: req.prompt,
          quorumThreshold: req.quorumThreshold,
          remoteTimeoutMs: req.remoteTimeoutMs,
          suppressThoughts: req.suppressThoughts,
          taskSchemaHash: 'tier1-default',
          timeoutMs: req.timeout ?? 300_000,
        })

         
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const {localPoolOutcome, localTimeoutMs, pool, remotePoolOutcome, remoteTimeoutMs, ...mergedFields} = result
        const response = {
          channelId: req.channelId,
          dispatchId,
          escalated: false,
          localPoolOutcome,
          localTimeoutMs,
          merged: mergedFields,
          poolMode,
          poolSizes: {local: localCount, remote: remoteCount},
          remotePoolOutcome,
          remoteTimeoutMs,
        }
        // Phase 10 Slice 10.7 Phase A — persist the quorum result so
        // `brv channel show-quorum <ch> <dispatchId>` can surface it later.
        await writeQuorumSnapshot({
          channelId: req.channelId,
          dispatchId,
          projectRoot,
          snapshot: {
            channelId: req.channelId,
            dispatchId,
            escalated: false,
            localPoolOutcome,
            localTimeoutMs,
            merged: mergedFields,
            poolMode,
            poolSizes: {local: localCount, remote: remoteCount},
            remotePoolOutcome,
            remoteTimeoutMs,
          },
        })
        return response
      }

      // Default: Slice 10.3 sequential local-first with escalation.
      const result = await dispatchLocalFirst(dispatcher, {
        agents: dispatchAgents,
        channelId: req.channelId,
        dispatchId,
        escalateOn: req.escalateOn,
        lowConfidenceThreshold: req.lowConfidenceThreshold,
        mergePolicy: new CrdtUnionMergePolicy(),
        projectRoot,
        prompt: req.prompt,
        quorumThreshold: req.quorumThreshold,
        suppressThoughts: req.suppressThoughts,
        taskSchemaHash: 'tier1-default',
        timeoutMs: req.timeout ?? 300_000,
        treatMissingConfidenceAsHigh: req.treatMissingConfidenceAsHigh,
      })

      const {escalated, escalationError, escalationReason, ...mergedFields} = result
      const response = {
        channelId: req.channelId,
        dispatchId,
        escalated,
        ...(escalationError === undefined ? {} : {escalationError}),
        ...(escalationReason === undefined ? {} : {escalationReason}),
        merged: mergedFields,
        poolMode,
        poolSizes: {local: localCount, remote: remoteCount},
      }
      // Phase 10 Slice 10.7 Phase A — persist the quorum result.
      await writeQuorumSnapshot({
        channelId: req.channelId,
        dispatchId,
        projectRoot,
        snapshot: {
          channelId: req.channelId,
          dispatchId,
          escalated,
          escalationError,
          escalationReason,
          merged: mergedFields,
          poolMode,
          poolSizes: {local: localCount, remote: remoteCount},
        },
      })
      return response
    })

    // channel:show-quorum (Phase 10 Slice 10.7) — read a persisted quorum
    // snapshot by (channelId, dispatchId). Returns `{found: false}` when no
    // file exists yet; otherwise `{found: true, snapshot, snapshottedAt}`.
    register(ChannelEvents.SHOW_QUORUM, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelShowQuorumRequestSchema, data)
      const {readLatestQuorum} = await import('../../channel/quorum/quorum-store.js')
      const snapshot = await readLatestQuorum({
        channelId: req.channelId,
        dispatchId: req.dispatchId,
        projectRoot,
      })
      if (snapshot === undefined) {
        return {found: false}
      }

      const {snapshottedAt, ...rest} = snapshot
      return {found: true, snapshot: rest, snapshottedAt}
    })

    // channel:cancel
    register(ChannelEvents.CANCEL, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelCancelRequestSchema, data)
      const result = await this.orchestrator.cancelTurn({
        channelId: req.channelId,
        deliveryId: req.deliveryId,
        projectRoot,
        turnId: req.turnId,
      })
      return {deliveries: result.deliveries, turn: result.turn}
    })

    // channel:permission-decision
    register(ChannelEvents.PERMISSION_DECISION, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelPermissionDecisionRequestSchema, data)
      const event = await this.orchestrator.permissionDecision({
        channelId: req.channelId,
        outcome: req.outcome,
        permissionRequestId: req.permissionRequestId,
        projectRoot,
        turnId: req.turnId,
      })
      return {event}
    })

    // ─── Phase-3 request events ───────────────────────────────────────

    // channel:onboard — probe a candidate agent and persist the profile.
    register(ChannelEvents.ONBOARD, async (data, _clientId, ctx) => {
      // Ensure cwd is present for parity with the rest of the channel surface.
      projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelOnboardRequestSchema, data)
      const svc = this.onboardService
      if (svc === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:onboard is not wired on this host (the daemon was built without the onboard service)',
          {phase: 3},
        )
      }

      const result = await svc.onboard({
        displayName: req.displayName,
        invocation: req.invocation,
        profileName: req.profileName,
      })
      return result
    })

    // channel:doctor — aggregate channel/pool/broker/profile diagnostics.
    register(ChannelEvents.DOCTOR, async (data, _clientId, ctx) => {
      const projectRoot = projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelDoctorRequestSchema, data)
      const svc = this.doctorService
      if (svc === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:doctor is not wired on this host (the daemon was built without the doctor service)',
          {phase: 3},
        )
      }

      const result = await svc.run({
        channelId: req.channelId,
        memberHandle: req.memberHandle,
        profileName: req.profileName,
        projectRoot,
      })
      return result
    })

    // channel:profile-list — list every persisted driver profile.
    register(ChannelEvents.PROFILE_LIST, async (data, _clientId, ctx) => {
      projectRootFromCtx(ctx)
      parseOrThrow(ChannelProfileListRequestSchema, data)
      const store = this.profileStore
      if (store === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:profile-list requires the driver-profile registry (Phase 3)',
          {phase: 3},
        )
      }

      return {profiles: await store.list()}
    })

    // channel:profile-show — read one profile by name.
    register(ChannelEvents.PROFILE_SHOW, async (data, _clientId, ctx) => {
      projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelProfileShowRequestSchema, data)
      const store = this.profileStore
      if (store === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:profile-show requires the driver-profile registry (Phase 3)',
          {phase: 3},
        )
      }

      const profile = await store.get(req.name)
      if (profile === undefined) throw new ChannelProfileNotFoundError(req.name)
      // Phase 10 Tier B3 — surface drift observations alongside the
      // profile so `channel profile show` exposes "known drift"
      // automatically. Omitted when no metadata store wired or no
      // observations recorded.
      const metadata = this.profileMetadataStore === undefined
        ? undefined
        : await this.profileMetadataStore.get(req.name)
      const driftObservations = metadata?.driftObservations
      const recentTurnDurations = metadata?.recentTurnDurations
      const hasDrift = driftObservations !== undefined && driftObservations.length > 0
      const hasDurations = recentTurnDurations !== undefined && recentTurnDurations.length > 0
      // Build the response with only the fields that have data — keeps
      // the no-metadata path producing the same `{profile}` shape it
      // did before B3/C4 and lets the CLI render conditional sections
      // off `.length` cleanly.
      return {
        profile,
        ...(hasDrift ? {driftObservations} : {}),
        ...(hasDurations ? {recentTurnDurations} : {}),
      }
    })

    // channel:profile-remove — idempotent removal.
    register(ChannelEvents.PROFILE_REMOVE, async (data, _clientId, ctx) => {
      projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelProfileRemoveRequestSchema, data)
      const store = this.profileStore
      if (store === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:profile-remove requires the driver-profile registry (Phase 3)',
          {phase: 3},
        )
      }

      return {removed: await store.remove(req.name)}
    })

    // channel:profile-record-drift (Phase 10 Tier B3) — record a per-handle
    // drift observation. Surfaces in `channel profile show <name>` so the
    // orchestrator sees "known drift" before re-dispatching.
    register(ChannelEvents.PROFILE_RECORD_DRIFT, async (data, _clientId, ctx) => {
      projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelProfileRecordDriftRequestSchema, data)
      const metadataStore = this.profileMetadataStore
      if (metadataStore === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:profile-record-drift requires the profile-metadata store (Phase 3.5)',
          {phase: 3.5},
        )
      }

      await metadataStore.addDriftObservation({
        description: req.description,
        file: req.file,
        ...(req.line === undefined ? {} : {line: req.line}),
        name: req.name,
        observedAt: new Date().toISOString(),
      })
      const record = await metadataStore.get(req.name)
      return {observationCount: record?.driftObservations?.length ?? 0}
    })

    // channel:profile-clear-drift (Phase 10 Tier B3) — clear all drift
    // observations for a profile.
    register(ChannelEvents.PROFILE_CLEAR_DRIFT, async (data, _clientId, ctx) => {
      projectRootFromCtx(ctx)
      const req = parseOrThrow(ChannelProfileClearDriftRequestSchema, data)
      const metadataStore = this.profileMetadataStore
      if (metadataStore === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:profile-clear-drift requires the profile-metadata store (Phase 3.5)',
          {phase: 3.5},
        )
      }

      const before = await metadataStore.get(req.name)
      const had = (before?.driftObservations?.length ?? 0) > 0
      await metadataStore.clearDriftObservations(req.name)
      return {cleared: had}
    })

    // channel:rotate-token — regenerate the daemon-auth-token. Returns a
    // fingerprint and the count of disconnected clients; never the token.
    register(ChannelEvents.ROTATE_TOKEN, async (data) => {
      // Token rotation does NOT require cwd — it's a daemon-global op.
      parseOrThrow(ChannelRotateTokenRequestSchema, data)
      const rotate = this.rotateTokenFn
      if (rotate === undefined) {
        throw new ChannelInvalidRequestError(
          'channel:rotate-token requires the auth-token-rotation hook (Slice 3.5)',
          {phase: 3},
        )
      }

      return rotate()
    })
  }
}
