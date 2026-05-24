/* eslint-disable perfectionist/sort-objects */
import {z} from 'zod'

/**
 * Channel-protocol shared wire types and zod schemas.
 *
 * This module is the canonical home for the on-the-wire and on-disk shapes
 * defined in `plan/channel-protocol/CHANNEL_PROTOCOL.md` §4 and §10. Both the
 * shared transport layer (`src/shared/transport/events/channel-events.ts`)
 * and the server-side domain layer (`src/server/core/domain/channel/`, added
 * in Slice 1.3) import from here so the channel format is defined exactly
 * once.
 *
 * ACP type alignment: `ContentBlock`-typed fields (e.g. `Turn.promptBlocks`)
 * are validated at runtime via {@link ContentBlockSchema} below, which mirrors
 * the discriminator + required fields of the `ContentBlock` union exported by
 * `@agentclientprotocol/sdk`. The local zod schema uses `passthrough()` so
 * additional ACP fields (annotations, mime types, etc.) round-trip unchanged
 * even if we don't model them yet. Type bridging to the ACP TS types is
 * deliberately lightweight in Phase 1 — orchestrator code that needs strict
 * ACP alignment imports from `@agentclientprotocol/sdk` directly.
 */

// ─── ACP ContentBlock ───────────────────────────────────────────────────────

const TextContentBlockSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough()

const ImageContentBlockSchema = z
  .object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
  })
  .passthrough()

const AudioContentBlockSchema = z
  .object({
    type: z.literal('audio'),
    data: z.string(),
    mimeType: z.string(),
  })
  .passthrough()

const ResourceLinkContentBlockSchema = z
  .object({
    type: z.literal('resource_link'),
    uri: z.string(),
  })
  .passthrough()

const EmbeddedResourceContentBlockSchema = z
  .object({
    type: z.literal('resource'),
    resource: z.object({}).passthrough(),
  })
  .passthrough()

/**
 * ACP `ContentBlock` discriminated union (`type` field). Aligned with the
 * shape exported by `@agentclientprotocol/sdk`. `passthrough()` preserves
 * ACP-specified fields we don't yet model.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextContentBlockSchema,
  ImageContentBlockSchema,
  AudioContentBlockSchema,
  ResourceLinkContentBlockSchema,
  EmbeddedResourceContentBlockSchema,
])

export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ─── TurnAuthor ─────────────────────────────────────────────────────────────

export const TurnAuthorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('acp-agent'),
    handle: z.string(),
  }),
  z.object({
    kind: z.literal('local-agent'),
    handle: z.literal('@brv'),
  }),
  z.object({
    kind: z.literal('local-user'),
    handle: z.literal('you'),
    sessionId: z.string().optional(),
  }),
  z.object({
    kind: z.literal('human-messaging'),
    transport: z.literal('whatsapp'),
    handle: z.string(),
    accountId: z.string(),
    peerId: z.string(),
    displayName: z.string().optional(),
  }),
  // Phase 9 / Slice 9.4e — Bob materialises a Turn snapshot for an
  // inbound Parley envelope whose author lives on another brv
  // install. `handle` is Bob's local mirror of the sender (derived
  // deterministically from libp2p peerId; see
  // BridgeTranscriptService.mirrorHandleForPeer).
  z.object({
    kind: z.literal('remote-peer'),
    // Inlined the `^@` constraint here rather than reusing
    // HandleSchema because HandleSchema is declared below this
    // section and `const` bindings are not hoisted.
    handle: z.string().regex(/^@/, 'channel member handle must start with "@"'),
    peerId: z.string().min(1),
    displayName: z.string().optional(),
  }),
])
export type TurnAuthor = z.infer<typeof TurnAuthorSchema>

// ─── ChannelMember ──────────────────────────────────────────────────────────

/**
 * Canonical Phase-2 handle: must start with `@`. Phase 1 shipped passive
 * channels with no members, so no migration is required; this refinement
 * is enforced at the schema layer from Phase 2 onward.
 */
export const HandleSchema = z.string().regex(/^@/, 'channel member handle must start with "@"')

const ChannelMemberBaseShape = {
  joinedAt: z.string().datetime(),
  lastTurnAt: z.string().datetime().optional(),
} as const

const AcpAgentStatusSchema = z.enum([
  'idle',
  'thinking',
  'awaiting_permission',
  'errored',
  'muted',
  'left',
  'acp_incompatible',
])

const LocalAgentStatusSchema = z.enum([
  'idle',
  'thinking',
  'awaiting_permission',
  'errored',
  'muted',
  'left',
])

const HumanMessagingStatusSchema = z.enum(['active', 'paired', 'muted', 'left'])

const RemotePeerStatusSchema = z.enum(['idle', 'thinking', 'errored', 'muted', 'left', 'unreachable'])

export const ChannelMemberAcpAgentSchema = z.object({
  ...ChannelMemberBaseShape,
  memberKind: z.literal('acp-agent'),
  handle: HandleSchema,
  agentName: z.string(),
  invocation: z.object({
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    env: z.record(z.string()).optional(),
  }),
  driverClass: z.enum(['A', 'B', 'C-prime']),
  acpVersion: z.string().optional(),
  capabilities: z.array(z.string()),
  status: AcpAgentStatusSchema,
})
export type ChannelMemberAcpAgent = z.infer<typeof ChannelMemberAcpAgentSchema>

const ChannelMemberLocalAgentSchema = z.object({
  ...ChannelMemberBaseShape,
  memberKind: z.literal('local-agent'),
  handle: HandleSchema,
  agentName: z.string(),
  status: LocalAgentStatusSchema,
})

const ChannelMemberHumanMessagingSchema = z.object({
  ...ChannelMemberBaseShape,
  memberKind: z.literal('human-messaging'),
  transport: z.literal('whatsapp'),
  accountId: z.string(),
  peerId: z.string(),
  handle: HandleSchema,
  displayName: z.string().optional(),
  status: HumanMessagingStatusSchema,
})

/**
 * Phase 9 / Slice 9.4 — a channel member that lives on a different brv
 * install reachable over libp2p Parley. The local daemon routes
 * `@<handle>` mentions for this member through a `RemoteMemberDriver`
 * that opens a `/brv/parley/query/v1` stream to `multiaddr` and verifies
 * response frames against `remoteL2PubKey`.
 *
 * The `multiaddr` MUST carry a `/p2p/<peerId>` suffix that matches the
 * `peerId` field; the orchestrator double-checks this at invite time.
 * `remoteL2PubKey` is base64 of the remote's L2 tree pubkey — a 9.3
 * out-of-band seam. 9.4 follow-up replaces it with in-band cert discovery.
 */
export const ChannelMemberRemotePeerSchema = z.object({
  ...ChannelMemberBaseShape,
  memberKind: z.literal('remote-peer'),
  handle: HandleSchema,
  peerId: z.string().min(1),
  // Phase 9 / Slice 9.4e (kimi round-1 MED-5) — both `multiaddr` and
  // `remoteL2PubKey` are optional for `auto-provisioned` mirror
  // members written from Bob's side: Bob only knows the sender's
  // peer_id (via the libp2p remote address) and the L1 install
  // pubkey (via the cert chain). He hasn't observed Alice's listen
  // multiaddr and hasn't fetched her L2 tree pubkey yet. The
  // orchestrator's `warmRemotePeerDriver` skips members where either
  // field is missing; operators must `brv channel invite` with real
  // values to enable reverse parley.
  multiaddr: z.string().min(1).optional(),
  remoteL2PubKey: z.string().min(1).optional(),
  displayName: z.string().optional(),
  status: RemotePeerStatusSchema,
  // Phase 9.5.4 — addressability flag for auto-provisioned members.
  // `bootstrap-only` signals that the multiaddr came from a one-time
  // inbound dial and may be stale. `pinned` means the multiaddr was
  // set via `brv channel invite` and is operator-verified.
  addressability: z.enum(['bootstrap-only', 'pinned']).optional(),
})
export type ChannelMemberRemotePeer = z.infer<typeof ChannelMemberRemotePeerSchema>

export const ChannelMemberSchema = z.discriminatedUnion('memberKind', [
  ChannelMemberAcpAgentSchema,
  ChannelMemberLocalAgentSchema,
  ChannelMemberHumanMessagingSchema,
  ChannelMemberRemotePeerSchema,
])
export type ChannelMember = z.infer<typeof ChannelMemberSchema>

/**
 * Lightweight summary shape used in `Channel.members[]` for `channel:list` and
 * `channel:get` responses (per CHANNEL_PROTOCOL.md §5.1 + §10). Callers that
 * need full member records (with invocation specs, joinedAt, etc.) use
 * `channel:members`.
 */
export const ChannelMemberSummarySchema = z.object({
  memberKind: z.enum(['acp-agent', 'local-agent', 'human-messaging', 'remote-peer']),
  handle: z.string(),
  displayName: z.string().optional(),
  status: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
})
export type ChannelMemberSummary = z.infer<typeof ChannelMemberSummarySchema>

// ─── Turn + TurnDelivery ────────────────────────────────────────────────────

export const TurnStateSchema = z.enum(['pending', 'dispatched', 'completed', 'cancelled'])
export type TurnState = z.infer<typeof TurnStateSchema>

export const TurnSchema = z.object({
  channelId: z.string(),
  turnId: z.string(),
  author: TurnAuthorSchema,
  promptBlocks: z.array(ContentBlockSchema),
  mentions: z.array(z.string()),
  promptedBy: z.enum(['user', 'agent', 'human-messaging']),
  state: TurnStateSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  idempotencyKey: z.string().optional(),
})
export type Turn = z.infer<typeof TurnSchema>

export const TurnDeliveryStateSchema = z.enum([
  'queued',
  'dispatched',
  'streaming',
  'awaiting_permission',
  'completed',
  'cancelled',
  'errored',
])
export type TurnDeliveryState = z.infer<typeof TurnDeliveryStateSchema>

export const TurnDeliverySchema = z.object({
  channelId: z.string(),
  turnId: z.string(),
  deliveryId: z.string(),
  memberHandle: z.string(),
  state: TurnDeliveryStateSchema,
  acpSessionId: z.string().optional(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  toolCallCount: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative().optional(),
  artifactsTouched: z.array(z.string()),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  // Phase 10 follow-up A1 (V6 evaluation) — when a delivery reaches terminal
  // state, the orchestrator populates this from concatenated
  // `agent_message_chunk.content` events for the delivery if the underlying
  // driver didn't expose `finalAnswer` directly. Callers MAY rely on this
  // field to recover an agent's full reply without manually replaying the
  // chunk stream.
  finalAnswer: z.string().optional(),
  // Phase 9.5.7 §3.2 Layer A — degraded-completion tracking for remote-peer
  // deliveries. `sealOrigin='explicit'` is the normal path; `'implicit-from-
  // signed-terminal'` means the transcript_seal was missing and the turn was
  // reconstructed from a signed stream_end. `integrityDegraded=true` when
  // the fallback path was used. Both are absent on local-agent deliveries.
  sealOrigin: z.enum(['explicit', 'implicit-from-signed-terminal']).optional(),
  integrityDegraded: z.boolean().optional(),
})
export type TurnDelivery = z.infer<typeof TurnDeliverySchema>

// ─── TurnEvent (full union per CHANNEL_PROTOCOL.md §7.1) ────────────────────

// Base shape every TurnEvent variant extends.
const TurnEventBaseShape = {
  channelId: z.string(),
  turnId: z.string(),
  deliveryId: z.string().nullable(),
  memberHandle: z.string().nullable(),
  emittedAt: z.string().datetime(),
  seq: z.number().int().nonnegative(),
} as const

export const PermissionOptionSchema = z
  .object({
    optionId: z.string(),
    name: z.string(),
    kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
  })
  .passthrough()
export type PermissionOption = z.infer<typeof PermissionOptionSchema>

export const RequestPermissionOutcomeSchema = z.discriminatedUnion('outcome', [
  z.object({outcome: z.literal('cancelled')}),
  z.object({outcome: z.literal('selected'), optionId: z.string()}),
])
export type RequestPermissionOutcome = z.infer<typeof RequestPermissionOutcomeSchema>

export const TurnEventSchema = z.discriminatedUnion('kind', [
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('message'),
    role: z.enum(['acp-agent', 'local-agent', 'user', 'human-messaging']),
    content: z.string(),
    summary: z.string().optional(),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('agent_message_chunk'),
    content: z.string(),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('agent_thought_chunk'),
    content: z.string(),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('tool_call'),
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('tool_call_update'),
    toolCallId: z.string(),
    // Slice 4.−1: loosened from the Phase-3 closed enum to any string the
    // agent emits. Renderers fall back gracefully on unknown statuses.
    status: z.string().optional(),
    output: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({
    ...TurnEventBaseShape,
    // Slice 4.−1: forward-compat catch-all variant. Hosts MAY project
    // unrecognised ACP `session/update` notifications into this shape so
    // future updates flow through without dropping. Clients tolerate any
    // `subKind` and any `payload`.
    kind: z.literal('agent_meta'),
    subKind: z.string(),
    payload: z.record(z.unknown()),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('permission_request'),
    permissionRequestId: z.string(),
    request: z
      .object({
        sessionId: z.string(),
        toolCall: z.unknown(),
        options: z.array(PermissionOptionSchema),
      })
      .passthrough(),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('permission_decision'),
    permissionRequestId: z.string(),
    outcome: RequestPermissionOutcomeSchema,
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('plan'),
    entries: z.array(z.unknown()),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('artifact'),
    path: z.string(),
    op: z.enum(['created', 'modified', 'deleted']),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('delivery_state_change'),
    from: TurnDeliveryStateSchema,
    to: TurnDeliveryStateSchema,
    error: z.string().optional(),
    // Slice 8.11 Layer 1 (codex Q6): canonical wire code for a terminal
    // delivery transition, so hosts subscribed via subscribe/watch can
    // programmatically detect failures (e.g. CHANNEL_DRIVER_NOT_REGISTERED)
    // from the event itself, not just the `error` human-readable text.
    // Backward-compatible because optional.
    errorCode: z.string().optional(),
  }),
  z.object({
    ...TurnEventBaseShape,
    kind: z.literal('turn_state_change'),
    from: TurnStateSchema,
    to: TurnStateSchema,
  }),
])
export type TurnEvent = z.infer<typeof TurnEventSchema>

// ─── Channel + ChannelMeta ──────────────────────────────────────────────────

export const ChannelSettingsSchema = z.object({
  maxParallelAgents: z.number().int().positive().optional(),
  defaultLookbackTurns: z.number().int().nonnegative().optional(),
})
export type ChannelSettings = z.infer<typeof ChannelSettingsSchema>

export const ChannelSchema = z.object({
  channelId: z.string(),
  title: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
  members: z.array(ChannelMemberSummarySchema),
  memberCount: z.number().int().nonnegative(),
  settings: ChannelSettingsSchema.optional(),
  // Phase 9.5.4 — provenance fields for auto-provisioned channels (optional).
  autoProvisionedFrom: z.string().optional(),
  autoProvisionedAt: z.string().datetime().optional(),
})
export type Channel = z.infer<typeof ChannelSchema>

/**
 * On-disk `meta.json` shape. Per CHANNEL_PROTOCOL.md §4.2 `meta.json` is the
 * mutable source of truth for membership + settings; per-turn state lives in
 * `turns/<turn-id>/`. The wire `Channel` (above) is a projection of this plus
 * derived fields (`memberCount`, summarised `members[]`).
 */
export const ChannelMetaSchema = z.object({
  channelId: z.string(),
  title: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
  members: z.array(ChannelMemberSchema),
  settings: ChannelSettingsSchema.optional(),
  // Phase 9.5.4 — provenance fields for auto-provisioned channels.
  // Set by BridgeTranscriptService.ensureChannelMeta on auto-create.
  // Exposed via `brv channel list --json` for operator audit.
  autoProvisionedFrom: z.string().optional(),
  autoProvisionedAt: z.string().datetime().optional(),
})
export type ChannelMeta = z.infer<typeof ChannelMetaSchema>

// ─── AgentDriverProfile (Phase 3) ───────────────────────────────────────────

/**
 * Phase-3 driver profile (CHANNEL_PROTOCOL.md §8.3 + Phase-3 spec edit).
 *
 * Profiles are per-user runtime invocation recipes persisted under
 * `$BRV_DATA_DIR/state/agent-driver-profiles.json`. They are not connector
 * config — connectors are agent-side plugins; profiles are host-side
 * recipes for spawning a candidate ACP driver.
 *
 * `probedAt` is the ISO timestamp of the last successful onboard probe; the
 * doctor's freshness check compares against this. It is optional for
 * back-compat with profiles produced by pre-Phase-3 hosts; the doctor
 * surfaces an `unknown` freshness when absent.
 */
export const AgentDriverProfileInvocationSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string()).optional(),
})
export type AgentDriverProfileInvocation = z.infer<typeof AgentDriverProfileInvocationSchema>

export const AgentDriverProfileSchema = z.object({
  name: z.string().min(1),
  displayName: z.string(),
  driverClass: z.enum(['A', 'B', 'C-prime']),
  invocation: AgentDriverProfileInvocationSchema,
  detectedAcpVersion: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
  probedAt: z.string().datetime().optional(),
})
export type AgentDriverProfile = z.infer<typeof AgentDriverProfileSchema>
