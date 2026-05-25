import {z} from 'zod'

import {
  AgentDriverProfileInvocationSchema,
  AgentDriverProfileSchema,
  ChannelMemberSchema,
  ChannelSchema,
  ContentBlockSchema,
  HandleSchema,
  RequestPermissionOutcomeSchema,
  TurnDeliverySchema,
  TurnEventSchema,
  TurnSchema,
} from '../../types/channel.js'

/**
 * Channel protocol event names.
 *
 * Per `plan/channel-protocol/CHANNEL_PROTOCOL.md` §3, every channel event name
 * is locked from day one so phases do not churn the wire. Phase 1 (this slice)
 * registers handlers for the 7 client-to-host request events listed under the
 * "Phase 1" comment block; Phase 2 wires up mention/cancel/invite/uninvite/
 * members/permission-decision; Phase 3 wires up onboard/doctor. The three
 * broadcast events are emitted by the orchestrator and arrive as broadcasts on
 * the channel's Socket.IO room — they are NOT registered via `onRequest`.
 */
/* eslint-disable perfectionist/sort-objects */
export const ChannelEvents = {
  // Lifecycle (Phase 1 + Phase 2: leave)
  CREATE: 'channel:create',
  LIST: 'channel:list',
  GET: 'channel:get',
  ARCHIVE: 'channel:archive',
  LEAVE: 'channel:leave',

  // Membership (Phase 2: invite/uninvite/members; Phase 3: onboard/doctor)
  INVITE: 'channel:invite',
  UNINVITE: 'channel:uninvite',
  MEMBERS: 'channel:members',
  ONBOARD: 'channel:onboard',
  DOCTOR: 'channel:doctor',

  // Phase 3 ops (rotate-token + profile registry CRUD)
  ROTATE_TOKEN: 'channel:rotate-token',
  PROFILE_LIST: 'channel:profile-list',
  PROFILE_SHOW: 'channel:profile-show',
  PROFILE_REMOVE: 'channel:profile-remove',
  // Phase 10 Tier B3 (V6 run-3 §4a) — record/clear per-profile drift
  // observations (file:line + description). Surfaces in profile-show.
  PROFILE_RECORD_DRIFT: 'channel:profile-record-drift',
  PROFILE_CLEAR_DRIFT: 'channel:profile-clear-drift',

  // Turns (Phase 1: post/list-turns/get-turn; Phase 2: mention/cancel/permission)
  POST: 'channel:post',
  MENTION: 'channel:mention',
  // Phase 10 Slice 10.2 — quorum dispatch (K-way agent fan-out + merged findings).
  MENTION_QUORUM: 'channel:mention-quorum',
  // Phase 10 Slice 10.7 — read a persisted quorum result by dispatchId.
  SHOW_QUORUM: 'channel:show-quorum',
  LIST_TURNS: 'channel:list-turns',
  GET_TURN: 'channel:get-turn',
  CANCEL: 'channel:cancel',
  PERMISSION_DECISION: 'channel:permission-decision',

  // Broadcasts (server → client; not registered via onRequest)
  TURN_EVENT: 'channel:turn-event',
  MEMBER_UPDATE: 'channel:member-update',
  STATE_CHANGE: 'channel:state-change',
} as const
/* eslint-enable perfectionist/sort-objects */

export type ChannelEvent = (typeof ChannelEvents)[keyof typeof ChannelEvents]

// ─── Phase-1 request schemas ────────────────────────────────────────────────
// Each Phase-1 client-to-host event has its request and response zod schemas
// here. Phase-2 events are intentionally absent until Phase 2 lands.

// channel:create -------------------------------------------------------------

export const ChannelCreateRequestSchema = z.object({
  channelId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  title: z.string().optional(),
})
export type ChannelCreateRequest = z.infer<typeof ChannelCreateRequestSchema>

export const ChannelCreateResponseSchema = z.object({
  channel: ChannelSchema,
})
export type ChannelCreateResponse = z.infer<typeof ChannelCreateResponseSchema>

// channel:list ---------------------------------------------------------------

export const ChannelListRequestSchema = z.object({
  archived: z.boolean().optional(),
})
export type ChannelListRequest = z.infer<typeof ChannelListRequestSchema>

export const ChannelListResponseSchema = z.object({
  channels: z.array(ChannelSchema),
})
export type ChannelListResponse = z.infer<typeof ChannelListResponseSchema>

// channel:get ----------------------------------------------------------------

export const ChannelGetRequestSchema = z.object({
  channelId: z.string(),
})
export type ChannelGetRequest = z.infer<typeof ChannelGetRequestSchema>

export const ChannelGetResponseSchema = z.object({
  channel: ChannelSchema,
})
export type ChannelGetResponse = z.infer<typeof ChannelGetResponseSchema>

// channel:archive ------------------------------------------------------------

export const ChannelArchiveRequestSchema = z.object({
  channelId: z.string(),
})
export type ChannelArchiveRequest = z.infer<typeof ChannelArchiveRequestSchema>

export const ChannelArchiveResponseSchema = z.object({
  channel: ChannelSchema,
})
export type ChannelArchiveResponse = z.infer<typeof ChannelArchiveResponseSchema>

// channel:post (passive turn — no dispatch) ---------------------------------

export const ChannelPostRequestSchema = z.object({
  channelId: z.string(),
  idempotencyKey: z.string().optional(),
  prompt: z.string().optional(),
  promptBlocks: z.array(ContentBlockSchema).optional(),
})
export type ChannelPostRequest = z.infer<typeof ChannelPostRequestSchema>

export const ChannelPostResponseSchema = z.object({
  deliveries: z.array(TurnDeliverySchema),
  turn: TurnSchema,
})
export type ChannelPostResponse = z.infer<typeof ChannelPostResponseSchema>

// channel:list-turns ---------------------------------------------------------

export const ChannelListTurnsRequestSchema = z.object({
  channelId: z.string(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().optional(),
})
export type ChannelListTurnsRequest = z.infer<typeof ChannelListTurnsRequestSchema>

export const ChannelListTurnsResponseSchema = z.object({
  nextCursor: z.string().optional(),
  turns: z.array(TurnSchema),
})
export type ChannelListTurnsResponse = z.infer<typeof ChannelListTurnsResponseSchema>

// channel:get-turn -----------------------------------------------------------

export const ChannelGetTurnRequestSchema = z.object({
  channelId: z.string(),
  turnId: z.string(),
})
export type ChannelGetTurnRequest = z.infer<typeof ChannelGetTurnRequestSchema>

export const ChannelGetTurnResponseSchema = z.object({
  deliveries: z.array(TurnDeliverySchema).optional(), // passive channels (Phase 1) have no deliveries
  events: z.array(TurnEventSchema),
  turn: TurnSchema,
})
export type ChannelGetTurnResponse = z.infer<typeof ChannelGetTurnResponseSchema>

// ─── Broadcast schemas (server → client on the channel room) ───────────────

export const ChannelTurnEventBroadcastSchema = z.object({
  channelId: z.string(),
  event: TurnEventSchema,
})
export type ChannelTurnEventBroadcast = z.infer<typeof ChannelTurnEventBroadcastSchema>

export const ChannelStateChangeBroadcastSchema = z.object({
  channel: ChannelSchema,
  channelId: z.string(),
})
export type ChannelStateChangeBroadcast = z.infer<typeof ChannelStateChangeBroadcastSchema>

export const ChannelMemberUpdateBroadcastSchema = z.object({
  channelId: z.string(),
  member: ChannelMemberSchema,
  op: z.enum(['added', 'updated', 'removed']),
})
export type ChannelMemberUpdateBroadcast = z.infer<typeof ChannelMemberUpdateBroadcastSchema>

// ─── Phase-2 request schemas (CHANNEL_PROTOCOL.md §8.2 + §8.4 + §8.5) ──────

// channel:invite -------------------------------------------------------------

// Reuse the canonical AgentDriverProfileInvocationSchema from shared/types so
// Phase-2 invite and Phase-3 onboard stay in lockstep — if invocation
// validation tightens (e.g. cwd absolute), the change applies everywhere.
const InvocationSchema = AgentDriverProfileInvocationSchema

/**
 * §8.2 verbatim shape plus two Phase-2 refinements:
 *   (a) `handle` MUST start with `@` (canonical-handle convention).
 *   (b) `profileName` XOR `invocation` — exactly one must be present.
 *
 * Phase 2's handler additionally rejects `profileName` with
 * `CHANNEL_INVALID_REQUEST` because the driver-profile registry doesn't
 * land until Phase 3.
 */
/**
 * Phase 9 / Slice 9.4 — remote-peer invite payload. Mutually exclusive
 * with `invocation` and `profileName`. The orchestrator validates
 * `multiaddr` carries a `/p2p/<peerId>` suffix matching `peerId`.
 */
const ChannelInviteRemotePeerSchema = z
  .object({
    displayName: z.string().optional(),
    multiaddr: z.string().min(1),
    peerId: z.string().min(1),
    /**
     * Slice 9.4d — optional. When absent, the daemon resolves it
     * in-band via `fetchAndPin({fetchTreeCert: true})` against
     * `/brv/identity/tree-cert/v1`. The CLI `--l2-pub-key` flag is
     * now an OPTIONAL override / fallback for legacy peers that
     * don't yet expose the sister identity protocol.
     */
    remoteL2PubKey: z.string().min(1).optional(),
  })
  .strict()

export const ChannelInviteRequestSchema = z
  .object({
    capabilities: z.array(z.string()).optional(),
    channelId: z.string(),
    handle: HandleSchema,
    invocation: InvocationSchema.optional(),
    profileName: z.string().optional(),
    remotePeer: ChannelInviteRemotePeerSchema.optional(),
  })
  .refine(
    (data) => {
      const provided = [data.invocation, data.profileName, data.remotePeer].filter(
        (v) => v !== undefined,
      )
      return provided.length === 1
    },
    {
      message: 'exactly one of `profileName`, `invocation`, or `remotePeer` must be provided',
      path: ['invocation'],
    },
  )
export type ChannelInviteRequest = z.infer<typeof ChannelInviteRequestSchema>

export const ChannelInviteResponseSchema = z.object({
  member: ChannelMemberSchema,
})
export type ChannelInviteResponse = z.infer<typeof ChannelInviteResponseSchema>

// channel:uninvite -----------------------------------------------------------

export const ChannelUninviteRequestSchema = z.object({
  channelId: z.string(),
  memberHandle: HandleSchema,
})
export type ChannelUninviteRequest = z.infer<typeof ChannelUninviteRequestSchema>

export const ChannelUninviteResponseSchema = z.object({
  member: ChannelMemberSchema,
})
export type ChannelUninviteResponse = z.infer<typeof ChannelUninviteResponseSchema>

// channel:mention ------------------------------------------------------------

export const ChannelMentionRequestSchema = z.object({
  channelId: z.string(),
  idempotencyKey: z.string().optional(),
  lookback: z
    .object({
      facts: z.number().int().nonnegative().optional(),
      recentTurns: z.number().int().nonnegative().optional(),
    })
    .optional(),
  // Both prompt fields are optional at the schema layer — §8.4 emptiness
  // is enforced after normalisation by the prompt normaliser so the wire
  // error surfaces as CHANNEL_PROMPT_EMPTY.
  mentions: z.array(HandleSchema).optional(),
  // ─── Slice 8.0 — sync mode + suppressThoughts ────────────────────────────
  // mode: 'sync' makes the daemon buffer agent_message_chunks per member
  // until the turn reaches a terminal state, then ack with the assembled
  // ChannelMentionSyncResponse. Default 'stream' preserves Phase-1..7
  // behaviour. suppressThoughts drops agent_thought_chunk events at the
  // orchestrator's persist/broadcast boundary; timeout caps the sync
  // wait (ms). Plan: plan/channel-protocol/IMPLEMENTATION_PHASE_8.md §8.0.
  mode: z.enum(['stream', 'sync']).optional(),
  prompt: z.string().optional(),

  promptBlocks: z.array(ContentBlockSchema).optional(),
  suppressThoughts: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
})
export type ChannelMentionRequest = z.infer<typeof ChannelMentionRequestSchema>

/**
 * §8.4 — Sync-mode response shape returned by `channel:mention` when
 * `mode === 'sync'`. The daemon blocks the ack until the turn reaches a
 * terminal state, then assembles `finalAnswer` from `agent_message_chunk`
 * events (per-member when fan-out; joined with `\n\n[@<member>]\n`
 * separator).
 *
 * Error paths surface via the `{success: false, code}` ack envelope
 * (`CHANNEL_SYNC_TIMEOUT`, `CHANNEL_SYNC_OVERFLOW`,
 * `CHANNEL_TURN_CANCELLED`, `CHANNEL_DAEMON_SHUTDOWN`), not via
 * `endedState` — which mirrors `TurnStateSchema`'s terminal subset.
 */
export const ChannelMentionSyncResponseSchema = z.object({
  channelId: z.string(),
  durationMs: z.number().int().nonnegative(),
  // Mirrors TurnStateSchema (src/shared/types/channel.ts) terminal states.
  endedState: z.enum(['completed', 'cancelled']),
  finalAnswer: z.string(),
  // Tool-call status is an open string per src/shared/types/channel.ts §300
  // (Slice 4.−1 loosening — real agents emit values like 'pending',
  // 'in_progress' that a closed enum would drop).
  toolCalls: z.array(
    z.object({
      callId: z.string(),
      name: z.string(),
      status: z.string().optional(),
    }),
  ),
  turnId: z.string(),
})
export type ChannelMentionSyncResponse = z.infer<typeof ChannelMentionSyncResponseSchema>

/**
 * `channel:mention` and `channel:cancel` both return the §8.4
 * `ChannelTurnAcceptedResponse` shape `{turn, deliveries}`.
 */
export const ChannelTurnAcceptedResponseSchema = z.object({
  deliveries: z.array(TurnDeliverySchema),
  turn: TurnSchema,
})
export type ChannelTurnAcceptedResponse = z.infer<typeof ChannelTurnAcceptedResponseSchema>

// channel:mention-quorum (Phase 10 Slice 10.2) ──────────────────────────────
//
// Daemon-side K-way quorum dispatch. The CLI sends a single request with the
// `quorumThreshold` + `mentions` + optional `mergePolicy` name; the daemon
// fan-outs via `QuorumDispatcher` and returns a serialised `MergedQuorum`.
//
// Tier 1 only accepts `mergePolicy: 'union'` (CrdtUnionMergePolicy). The
// `majority` + `adversarial-filter` policies are Tier 2/3 scaffolds and
// reject with CHANNEL_INVALID_REQUEST.

const EvidenceSpanSchema = z.object({
  endLine: z.number().int().optional(),
  excerpt: z.string(),
  source: z.string(),
  startLine: z.number().int().optional(),
})

const FindingSchema = z.object({
  agent: HandleSchema,
  canonicalClaim: z.string(),
  claim: z.string(),
  claimHash: z.string(),
  confidence: z.number().optional(),
  emittedAt: z.string(),
  evidence: z.array(EvidenceSpanSchema),
  partitionKey: z.string().optional(),
  role: z.string().optional(),
  schemaVersion: z.string(),
  sourceDeliveryId: z.string(),
  sourceTurnId: z.string(),
})

const MergedQuorumSchema = z.object({
  agreed: z.array(FindingSchema),
  contradicted: z.array(z.object({
    positions: z.array(FindingSchema),
    summary: z.string(),
  })),
  coveredAgents: z.array(z.string()),
  mergedAt: z.string(),
  missingAgents: z.array(z.string()),
  partial: z.boolean(),
  pending: z.array(FindingSchema),
})

export const ChannelMentionQuorumRequestSchema = z.object({
  channelId: z.string(),
  // Phase 10 Slice 10.3 — escalation policy. Default `empty-or-contradiction`
  // (escalate to remote pool when local consensus is empty OR contradicted).
  // `never` keeps execution local-only regardless of result.
  // Ignored when poolMode === 'parallel' (parallel dispatches both pools
  // unconditionally, modulo localOnly/remoteOnly).
  escalateOn: z.enum(['empty', 'empty-or-contradiction', 'low-confidence', 'never']).optional(),
  // Phase 10 Slice 10.3 — pool overrides. `localOnly` skips remote agents
  // entirely; `remoteOnly` skips local. Mutually exclusive with each other,
  // and with the default local-first escalation.
  localOnly: z.boolean().optional(),
  // Phase 10 Slice 10.5 — per-pool timeout budgets (parallel mode only).
  // Defaults: local 5_000ms, remote 30_000ms (server side).
  localTimeoutMs: z.number().int().positive().optional(),
  // Phase 10 Slice 10.3 — confidence threshold for `--escalate-on low-confidence`.
  // Default 0.6 (server side).
  lowConfidenceThreshold: z.number().min(0).max(1).optional(),
  mentions: z.array(HandleSchema).min(1),
  // Kimi F2: `taskSchemaHash` is hardcoded on the server in Tier 1 (no caller
  // semantics yet); F3: `idempotencyKey` is omitted from the wire surface
  // until orchestrator-side dedupe lands. Both will return when there is a
  // real consumer.
  mergePolicy: z.enum(['union']).optional(),
  // Phase 10 Slice 10.6 — tag-based matchmaking. When provided, the
  // handler filters channel members against the matchmaker (default
  // `LocalMatchmaker`) before applying stake sizing, picking the
  // highest-scoring agents per their strength profile.
  needs: z.array(z.string()).optional(),
  // Phase 10 Slice 10.5 — pool dispatch strategy.
  //   'local-first' (default) — Slice 10.3 sequential: local pool first;
  //     escalate to remote per `escalateOn`. Cost-optimal (don't pay remote
  //     latency unless local consensus fails).
  //   'parallel'           — Slice 10.5: local + remote concurrent with
  //     per-pool timeouts. Latency-optimal (wall clock = max(local, remote)).
  poolMode: z.enum(['local-first', 'parallel']).optional(),
  prompt: z.string(),
  quorumThreshold: z.number().int().min(1),
  remoteOnly: z.boolean().optional(),
  // Phase 10 Slice 10.5 — per-pool timeout budget (parallel mode only).
  remoteTimeoutMs: z.number().int().positive().optional(),
  // Phase 10 Slice 10.4 — stake grade controls local/remote dispatch count
  // via the `STAKE_GROUP_SIZE` matrix. Defaults to `medium`. Operators tune
  // per-grade sizing via `BRV_QUORUM_STAKE_<STAKE>_<LOCAL|REMOTE>` env.
  stake: z.enum(['critical', 'high', 'low', 'medium']).optional(),
  suppressThoughts: z.boolean().optional(),
  timeout: z.number().int().positive().optional(),
  treatMissingConfidenceAsHigh: z.boolean().optional(),
})
export type ChannelMentionQuorumRequest = z.infer<typeof ChannelMentionQuorumRequestSchema>

const PoolOutcomeSchema = z.enum(['completed', 'errored', 'skipped', 'timed-out'])

// channel:show-quorum (Phase 10 Slice 10.7) ────────────────────────────────
// Read a persisted quorum result by (channelId, dispatchId). The daemon
// looks up `.brv/channel-history/<channelId>/quorum/<dispatchId>.ndjson`
// and returns the LAST snapshot.

export const ChannelShowQuorumRequestSchema = z.object({
  channelId: z.string(),
  dispatchId: z.string(),
})
export type ChannelShowQuorumRequest = z.infer<typeof ChannelShowQuorumRequestSchema>

export const ChannelShowQuorumResponseSchema = z.object({
  found: z.boolean(),
  // Present when found === true. Same shape as `ChannelMentionQuorumResponse`
  // (modulo per-pool fields that are only populated under parallel mode).
  snapshot: z.unknown().optional(),
  snapshottedAt: z.string().optional(),
})
export type ChannelShowQuorumResponse = z.infer<typeof ChannelShowQuorumResponseSchema>

export const ChannelMentionQuorumResponseSchema = z.object({
  channelId: z.string(),
  dispatchId: z.string(),
  // Phase 10 Slice 10.3 — escalation metadata (present when local-first
  // escalated to remote pool, or attempted to and the remote leg failed).
  escalated: z.boolean(),
  escalationError: z.string().optional(),
  escalationReason: z.enum(['contradicted', 'empty', 'low-confidence']).optional(),
  // Phase 10 Slice 10.5 — per-pool outcome echoed only when poolMode === 'parallel'.
  localPoolOutcome: PoolOutcomeSchema.optional(),
  localTimeoutMs: z.number().int().nonnegative().optional(),
  merged: MergedQuorumSchema,
  // Phase 10 Slice 10.5 — `local-first` (Slice 10.3) or `parallel` (Slice 10.5).
  // Echoed back so the caller knows which strategy actually ran.
  poolMode: z.enum(['local-first', 'parallel']),
  // Phase 10 Slice 10.4 — pool grouping resolved from the stake matrix at
  // dispatch time. Echoed back so the caller knows what was actually used.
  poolSizes: z.object({local: z.number().int().nonnegative(), remote: z.number().int().nonnegative()}),
  remotePoolOutcome: PoolOutcomeSchema.optional(),
  remoteTimeoutMs: z.number().int().nonnegative().optional(),
})
export type ChannelMentionQuorumResponse = z.infer<typeof ChannelMentionQuorumResponseSchema>

// channel:cancel -------------------------------------------------------------

export const ChannelCancelRequestSchema = z.object({
  channelId: z.string(),
  deliveryId: z.string().optional(),
  turnId: z.string(),
})
export type ChannelCancelRequest = z.infer<typeof ChannelCancelRequestSchema>

export const ChannelCancelResponseSchema = ChannelTurnAcceptedResponseSchema
export type ChannelCancelResponse = z.infer<typeof ChannelCancelResponseSchema>

// channel:permission-decision ------------------------------------------------

export const ChannelPermissionDecisionRequestSchema = z.object({
  channelId: z.string(),
  outcome: RequestPermissionOutcomeSchema,
  permissionRequestId: z.string(),
  turnId: z.string(),
})
export type ChannelPermissionDecisionRequest = z.infer<typeof ChannelPermissionDecisionRequestSchema>

export const ChannelPermissionDecisionResponseSchema = z.object({
  event: TurnEventSchema,
})
export type ChannelPermissionDecisionResponse = z.infer<typeof ChannelPermissionDecisionResponseSchema>

// ─── Phase-3 request schemas ────────────────────────────────────────────────

// channel:onboard + channel:doctor (CHANNEL_PROTOCOL.md §8.3) ---------------

export const DoctorDiagnosticSchema = z.object({
  code: z.string(),
  details: z.unknown().optional(),
  message: z.string(),
  severity: z.enum(['error', 'info', 'warning']),
})
export type DoctorDiagnostic = z.infer<typeof DoctorDiagnosticSchema>

export const ChannelOnboardRequestSchema = z.object({
  displayName: z.string(),
  invocation: z.object({
    args: z.array(z.string()),
    command: z.string(),
    cwd: z.string(),
    env: z.record(z.string()).optional(),
  }),
  profileName: z.string().min(1),
})
export type ChannelOnboardRequest = z.infer<typeof ChannelOnboardRequestSchema>

export const ChannelOnboardResponseSchema = z.object({
  diagnostics: z.array(DoctorDiagnosticSchema),
  profile: AgentDriverProfileSchema,
})
export type ChannelOnboardResponse = z.infer<typeof ChannelOnboardResponseSchema>

export const ChannelDoctorRequestSchema = z.object({
  channelId: z.string().optional(),
  memberHandle: z.string().optional(),
  profileName: z.string().optional(),
})
export type ChannelDoctorRequest = z.infer<typeof ChannelDoctorRequestSchema>

export const ChannelDoctorResponseSchema = z.object({
  diagnostics: z.array(DoctorDiagnosticSchema),
})
export type ChannelDoctorResponse = z.infer<typeof ChannelDoctorResponseSchema>

// channel:rotate-token -------------------------------------------------------

/**
 * `confirm: true` is a literal — `false` and `undefined` are rejected so a
 * client cannot accidentally rotate the daemon-auth token. The CLI surface
 * (`brv channel rotate-token --yes`) is the user-visible guard; this schema
 * is the wire-side belt-and-suspenders.
 */
export const ChannelRotateTokenRequestSchema = z.object({
  confirm: z.literal(true),
})
export type ChannelRotateTokenRequest = z.infer<typeof ChannelRotateTokenRequestSchema>

export const ChannelRotateTokenResponseSchema = z.object({
  disconnectedClients: z.number().int().nonnegative(),
  tokenFingerprint: z.string(),
})
export type ChannelRotateTokenResponse = z.infer<typeof ChannelRotateTokenResponseSchema>

// channel:profile-list -------------------------------------------------------

export const ChannelProfileListRequestSchema = z.object({}).strict()
export type ChannelProfileListRequest = z.infer<typeof ChannelProfileListRequestSchema>

export const ChannelProfileListResponseSchema = z.object({
  profiles: z.array(AgentDriverProfileSchema),
})
export type ChannelProfileListResponse = z.infer<typeof ChannelProfileListResponseSchema>

// channel:profile-show -------------------------------------------------------

export const ChannelProfileShowRequestSchema = z.object({
  name: z.string().min(1),
})
export type ChannelProfileShowRequest = z.infer<typeof ChannelProfileShowRequestSchema>

// Phase 10 Tier B3 — drift observations on the wire. Mirrors the
// `DriftObservation` shape in profile-metadata-store. Kept as a small
// inline schema to avoid pulling server-side types into the shared
// transport layer.
const DriftObservationSchema = z.object({
  description: z.string(),
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  observedAt: z.string(),
})

// Phase 10 Tier C #4 — per-agent wall-clock variance entries. Mirrors
// `TurnDurationEntry` in profile-metadata-store.
const TurnDurationEntrySchema = z.object({
  completedAt: z.string(),
  durationMs: z.number().int().nonnegative(),
  endedState: z.enum(['cancelled', 'completed', 'errored']),
})

export const ChannelProfileShowResponseSchema = z.object({
  // Phase 10 Tier B3 — recorded drift observations for this profile.
  // Empty/omitted means none recorded. Surfaced in `profile show`.
  driftObservations: z.array(DriftObservationSchema).optional(),
  profile: AgentDriverProfileSchema,
  // Phase 10 Tier C #4 — recent completed-turn wall-clock durations,
  // bounded ring buffer (most recent last). Omitted when no data
  // recorded.
  recentTurnDurations: z.array(TurnDurationEntrySchema).optional(),
})
export type ChannelProfileShowResponse = z.infer<typeof ChannelProfileShowResponseSchema>

// channel:profile-remove -----------------------------------------------------

export const ChannelProfileRemoveRequestSchema = z.object({
  name: z.string().min(1),
})
export type ChannelProfileRemoveRequest = z.infer<typeof ChannelProfileRemoveRequestSchema>

export const ChannelProfileRemoveResponseSchema = z.object({
  removed: z.boolean(),
})
export type ChannelProfileRemoveResponse = z.infer<typeof ChannelProfileRemoveResponseSchema>

// channel:profile-record-drift (Phase 10 Tier B3) ----------------------------

export const ChannelProfileRecordDriftRequestSchema = z.object({
  description: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().nonnegative().optional(),
  name: z.string().min(1),
})
export type ChannelProfileRecordDriftRequest = z.infer<typeof ChannelProfileRecordDriftRequestSchema>

export const ChannelProfileRecordDriftResponseSchema = z.object({
  observationCount: z.number().int().nonnegative(),
})
export type ChannelProfileRecordDriftResponse = z.infer<typeof ChannelProfileRecordDriftResponseSchema>

// channel:profile-clear-drift (Phase 10 Tier B3) -----------------------------

export const ChannelProfileClearDriftRequestSchema = z.object({
  name: z.string().min(1),
})
export type ChannelProfileClearDriftRequest = z.infer<typeof ChannelProfileClearDriftRequestSchema>

export const ChannelProfileClearDriftResponseSchema = z.object({
  cleared: z.boolean(),
})
export type ChannelProfileClearDriftResponse = z.infer<typeof ChannelProfileClearDriftResponseSchema>

// Re-export the invocation sub-schema so Slice 3.2's onboard service and
// downstream tests can import a single canonical source.


export {AgentDriverProfileInvocationSchema} from '../../types/channel.js'