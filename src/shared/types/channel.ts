/* eslint-disable perfectionist/sort-objects */
import {z} from 'zod'

/**
 * Channel shared types + zod schemas — the canonical home for the on-the-wire
 * and on-disk shapes of the `brv channel` multi-agent subsystem (M0-1).
 *
 * Both the shared transport layer and the server-side domain layer
 * (`src/server/core/domain/channel/`) import from here so the channel format
 * is defined exactly once. Persisted/serialized shapes (`Turn`, `TurnEvent`,
 * `Channel`) are declared `.strict()` so a drifting producer cannot smuggle
 * untyped fields into the transcript store.
 *
 * Driver-agnostic by design (open question Q2): the domain MUST NOT leak
 * ACP-only field names, so a hand-rolled ACP client, the official lib, or a
 * headless adapter can all project into the same shapes. libp2p/cross-machine
 * shapes (remote-peer members, signed-seal integrity fields) are intentionally
 * absent here and re-introduced in M5+.
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
 * ACP `ContentBlock` discriminated union (`type` field). `passthrough()`
 * preserves ACP-specified fields (annotations, mime types, …) we don't yet
 * model, so prompt blocks round-trip unchanged.
 */
export const ContentBlockSchema = z.discriminatedUnion('type', [
  TextContentBlockSchema,
  ImageContentBlockSchema,
  AudioContentBlockSchema,
  ResourceLinkContentBlockSchema,
  EmbeddedResourceContentBlockSchema,
])

export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ─── Handle ─────────────────────────────────────────────────────────────────

/** Canonical channel-member handle: must start with `@`. */
export const HandleSchema = z.string().regex(/^@/, 'channel member handle must start with "@"')

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
])

export type TurnAuthor = z.infer<typeof TurnAuthorSchema>

// ─── ChannelMember ──────────────────────────────────────────────────────────

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

export const ChannelMemberLocalAgentSchema = z.object({
  ...ChannelMemberBaseShape,
  memberKind: z.literal('local-agent'),
  handle: HandleSchema,
  agentName: z.string(),
  status: LocalAgentStatusSchema,
})

export type ChannelMemberLocalAgent = z.infer<typeof ChannelMemberLocalAgentSchema>

export const ChannelMemberSchema = z.discriminatedUnion('memberKind', [
  ChannelMemberAcpAgentSchema,
  ChannelMemberLocalAgentSchema,
])

export type ChannelMember = z.infer<typeof ChannelMemberSchema>

/**
 * Lightweight summary used in `Channel.members[]` for list/get responses.
 * Callers needing full member records use the dedicated members query.
 */
export const ChannelMemberSummarySchema = z.object({
  memberKind: z.enum(['acp-agent', 'local-agent']),
  handle: z.string(),
  displayName: z.string().optional(),
  status: z.string().optional(),
  capabilities: z.array(z.string()).optional(),
})

export type ChannelMemberSummary = z.infer<typeof ChannelMemberSummarySchema>

// ─── Turn + TurnDelivery ────────────────────────────────────────────────────

export const TurnStateSchema = z.enum(['pending', 'dispatched', 'completed', 'cancelled'])

export type TurnState = z.infer<typeof TurnStateSchema>

export const TurnSchema = z
  .object({
    channelId: z.string(),
    turnId: z.string(),
    author: TurnAuthorSchema,
    promptBlocks: z.array(ContentBlockSchema),
    mentions: z.array(z.string()),
    promptedBy: z.enum(['user', 'agent']),
    state: TurnStateSchema,
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    idempotencyKey: z.string().optional(),
  })
  .strict()

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

export const TurnDeliverySchema = z
  .object({
    channelId: z.string(),
    turnId: z.string(),
    deliveryId: z.string(),
    memberHandle: z.string(),
    state: TurnDeliveryStateSchema,
    // Driver-agnostic (Q2): the session id assigned by whichever driver runs
    // this delivery — local ACP subprocess or (M5+) a remote A2A peer.
    driverSessionId: z.string().optional(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime().optional(),
    toolCallCount: z.number().int().nonnegative(),
    tokensUsed: z.number().int().nonnegative().optional(),
    artifactsTouched: z.array(z.string()),
    errorCode: z.string().optional(),
    errorMessage: z.string().optional(),
    // When a delivery reaches a terminal state, the orchestrator populates
    // this from concatenated `agent_message_chunk` content if the driver
    // didn't expose a final answer directly, so callers can recover the full
    // reply without replaying the chunk stream.
    finalAnswer: z.string().optional(),
  })
  .strict()

export type TurnDelivery = z.infer<typeof TurnDeliverySchema>

// ─── TurnEvent ──────────────────────────────────────────────────────────────

// Base shape every TurnEvent variant extends.
const TurnEventBaseShape = {
  channelId: z.string(),
  turnId: z.string(),
  deliveryId: z.string().nullable(),
  memberHandle: z.string().nullable(),
  emittedAt: z.string().datetime(),
  seq: z.number().int().nonnegative(),
} as const

export const PermissionOptionSchema = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always']),
})

export type PermissionOption = z.infer<typeof PermissionOptionSchema>

export const TurnEventSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('message'),
      role: z.enum(['acp-agent', 'local-agent', 'user']),
      content: z.string(),
      summary: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('agent_message_chunk'),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('agent_thought_chunk'),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('tool_call'),
      toolCallId: z.string(),
      name: z.string(),
      input: z.unknown(),
    })
    .strict(),
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('tool_call_update'),
      toolCallId: z.string(),
      // `status` is any agent-emitted progress string (e.g. 'pending',
      // 'completed') — not a closed enum, since real ACP agents vary.
      status: z.string().optional(),
      output: z.unknown().optional(),
      error: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('permission_request'),
      permissionRequestId: z.string(),
      // Flattened + driver-agnostic (Q2): no ACP `sessionId` here — the
      // delivery carries `driverSessionId`. `toolCall` is the opaque
      // driver-reported call the user is being asked to approve.
      toolCall: z.unknown(),
      options: z.array(PermissionOptionSchema),
    })
    .strict(),
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('delivery_state_change'),
      from: TurnDeliveryStateSchema,
      to: TurnDeliveryStateSchema,
      error: z.string().optional(),
      errorCode: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...TurnEventBaseShape,
      kind: z.literal('turn_state_change'),
      from: TurnStateSchema,
      to: TurnStateSchema,
    })
    .strict(),
])

export type TurnEvent = z.infer<typeof TurnEventSchema>

// ─── Channel ────────────────────────────────────────────────────────────────

export const ChannelSettingsSchema = z.object({
  maxParallelAgents: z.number().int().positive().optional(),
  defaultLookbackTurns: z.number().int().nonnegative().optional(),
})

export type ChannelSettings = z.infer<typeof ChannelSettingsSchema>

export const ChannelSchema = z
  .object({
    channelId: z.string(),
    title: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    archivedAt: z.string().datetime().optional(),
    members: z.array(ChannelMemberSummarySchema),
    memberCount: z.number().int().nonnegative(),
    settings: ChannelSettingsSchema.optional(),
  })
  .strict()

export type Channel = z.infer<typeof ChannelSchema>

// ─── Agent driver profile ─────────────────────────────────────────────────

/**
 * How to launch an agent subprocess. Shared by a saved profile and a channel
 * member, so a probed profile maps onto an invite invocation unchanged.
 */
export const AgentDriverProfileInvocationSchema = z.object({
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  env: z.record(z.string()).optional(),
})

export type AgentDriverProfileInvocation = z.infer<typeof AgentDriverProfileInvocationSchema>

/**
 * A reusable, probed launch spec for an agent. `onboard` writes one after
 * probing a candidate; `invite --profile <name>` resolves it instead of
 * re-passing the inline invocation.
 */
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

// ─── Synchronous mention result ───────────────────────────────────────────

/**
 * The settled result of a `mode: 'sync'` mention: the assembled answer plus
 * the terminal turn state. A turn only ever ends `completed` or `cancelled`.
 */
export const ChannelMentionSyncResultSchema = z.object({
  turnId: z.string(),
  endedState: z.enum(['cancelled', 'completed']),
  finalAnswer: z.string(),
  durationMs: z.number().int().nonnegative(),
})

export type ChannelMentionSyncResult = z.infer<typeof ChannelMentionSyncResultSchema>
