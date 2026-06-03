import {z} from 'zod'

import {
  AgentDriverProfileInvocationSchema,
  AgentDriverProfileSchema,
  ChannelMemberSchema,
  ChannelMentionSyncResultSchema,
  ChannelSchema,
  ContentBlockSchema,
  HandleSchema,
  TurnEventSchema,
  TurnSchema,
} from '../../types/index.js'

/* eslint-disable perfectionist/sort-objects */
export const ChannelEvents = {
  // Lifecycle
  CREATE: 'channel:create',
  LIST: 'channel:list',
  GET: 'channel:get',

  // Membership
  INVITE: 'channel:invite',
  ONBOARD: 'channel:onboard',

  // Turns
  MENTION: 'channel:mention',
  SHOW: 'channel:show',
  LIST_TURNS: 'channel:list-turns',
  SUBSCRIBE: 'channel:subscribe',
  CANCEL: 'channel:cancel',

  // Broadcasts (server to client on the channel room; not registered via onRequest)
  TURN_EVENT: 'channel:turn-event',
  STATE_CHANGE: 'channel:state-change',
  MEMBER_UPDATE: 'channel:member-update',
} as const
/* eslint-enable perfectionist/sort-objects */

export type ChannelEvent = (typeof ChannelEvents)[keyof typeof ChannelEvents]

/** channel:create */
export const ChannelCreateRequestSchema = z.object({
  channelId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  title: z.string().optional(),
})

export type ChannelCreateRequest = z.infer<typeof ChannelCreateRequestSchema>

export const ChannelCreateResponseSchema = z.object({
  channel: ChannelSchema
})

export type ChannelCreateResponse = z.infer<typeof ChannelCreateResponseSchema>

/** channel:list */
export const ChannelListRequestSchema = z.object({
  archived: z.boolean().optional(),
})

export type ChannelListRequest = z.infer<typeof ChannelListRequestSchema>

export const ChannelListResponseSchema = z.object({
  channels: z.array(ChannelSchema),
})

export type ChannelListResponse = z.infer<typeof ChannelListResponseSchema>

/** channel:get */
export const ChannelGetRequestSchema = z.object({
  channelId: z.string(),
})

export type ChannelGetRequest = z.infer<typeof ChannelGetRequestSchema>

export const ChannelGetResponseSchema = z.object({
  channel: ChannelSchema,
})

export type ChannelGetResponse = z.infer<typeof ChannelGetResponseSchema>

/**
 * channel:invite — either references a saved profile by name (`profileName`)
 * or carries an inline launch spec (`invocation`).
 */
export const ChannelInviteRequestSchema = z.object({
  channelId: z.string(),
  handle: HandleSchema,
  invocation: AgentDriverProfileInvocationSchema.optional(),
  profileName: z.string().optional(),
})

export type ChannelInviteRequest = z.infer<typeof ChannelInviteRequestSchema>

export const ChannelInviteResponseSchema = z.object({
  member: ChannelMemberSchema,
})

export type ChannelInviteResponse = z.infer<typeof ChannelInviteResponseSchema>

/** A single advisory emitted while probing/onboarding an agent. */
export const DoctorDiagnosticSchema = z.object({
  code: z.string(),
  details: z.unknown().optional(),
  message: z.string(),
  severity: z.enum(['error', 'info', 'warning']),
})

export type DoctorDiagnostic = z.infer<typeof DoctorDiagnosticSchema>

/** channel:onboard — probe a candidate agent and persist a reusable profile. */
export const ChannelOnboardRequestSchema = z.object({
  displayName: z.string(),
  invocation: AgentDriverProfileInvocationSchema,
  profileName: z.string().min(1),
})

export type ChannelOnboardRequest = z.infer<typeof ChannelOnboardRequestSchema>

export const ChannelOnboardResponseSchema = z.object({
  diagnostics: z.array(DoctorDiagnosticSchema),
  profile: AgentDriverProfileSchema,
})

export type ChannelOnboardResponse = z.infer<typeof ChannelOnboardResponseSchema>

/**
 * channel:mention — `mode: 'sync'` blocks until the turn settles and returns
 * the assembled answer; `mode: 'async'` (later milestone) accepts the turn and
 * returns its snapshot. `suppressThoughts` drops `agent_thought_chunk` events
 * from both the wire and the transcript.
 */
export const ChannelMentionRequestSchema = z.object({
  channelId: z.string(),
  idempotencyKey: z.string().optional(),
  mentions: z.array(HandleSchema).optional(),
  mode: z.enum(['async', 'sync']).optional(),
  prompt: z.string().optional(),
  promptBlocks: z.array(ContentBlockSchema).optional(),
  suppressThoughts: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
})

export type ChannelMentionRequest = z.infer<typeof ChannelMentionRequestSchema>

export const ChannelMentionResponseSchema = z.union([
  z.object({kind: z.literal('sync'), result: ChannelMentionSyncResultSchema}),
  z.object({kind: z.literal('accepted'), turn: TurnSchema}),
])

export type ChannelMentionResponse = z.infer<typeof ChannelMentionResponseSchema>

/** channel:show — carries the M0-1 Turn/TurnEvent shapes unchanged. */
export const ChannelShowRequestSchema = z.object({
  channelId: z.string(),
  turnId: z.string(),
})

export type ChannelShowRequest = z.infer<typeof ChannelShowRequestSchema>

export const ChannelShowResponseSchema = z.object({
  events: z.array(TurnEventSchema),
  turn: TurnSchema,
})

export type ChannelShowResponse = z.infer<typeof ChannelShowResponseSchema>

/** channel:list-turns */
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

/** channel:subscribe */
export const ChannelSubscribeRequestSchema = z.object({
  channelId: z.string(),
})

export type ChannelSubscribeRequest = z.infer<typeof ChannelSubscribeRequestSchema>

export const ChannelSubscribeResponseSchema = z.object({
  channelId: z.string(),
  subscribed: z.literal(true),
})

export type ChannelSubscribeResponse = z.infer<typeof ChannelSubscribeResponseSchema>

/** channel:cancel */
export const ChannelCancelRequestSchema = z.object({
  channelId: z.string(),
  turnId: z.string(),
})

export type ChannelCancelRequest = z.infer<typeof ChannelCancelRequestSchema>

export const ChannelCancelResponseSchema = z.object({
  cancelled: z.boolean(),
})

export type ChannelCancelResponse = z.infer<typeof ChannelCancelResponseSchema>

// ─── Broadcast payloads (server → client on the channel room) ────────────────

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
  op: z.enum(['added', 'removed', 'updated']),
})

export type ChannelMemberUpdateBroadcast = z.infer<typeof ChannelMemberUpdateBroadcastSchema>