import {z} from 'zod'

import {
  ChannelMemberSchema,
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
 * channel:invite — `invocation` is intentionally loose at the skeleton layer;
 * the launch-spec shape is tightened when the driver/profile machinery lands.
 */
export const ChannelInviteRequestSchema = z.object({
  channelId: z.string(),
  handle: HandleSchema,
  invocation: z.unknown().optional(),
  profileName: z.string().optional(),
})

export type ChannelInviteRequest = z.infer<typeof ChannelInviteRequestSchema>

export const ChannelInviteResponseSchema = z.object({
  member: ChannelMemberSchema,
})

export type ChannelInviteResponse = z.infer<typeof ChannelInviteResponseSchema>

/** channel:onboard */
export const ChannelOnboardRequestSchema = z.object({
  channelId: z.string(),
  handle: HandleSchema,
  invocation: z.unknown().optional(),
})

export type ChannelOnboardRequest = z.infer<typeof ChannelOnboardRequestSchema>

export const ChannelOnboardResponseSchema = z.object({
  member: ChannelMemberSchema,
})

export type ChannelOnboardResponse = z.infer<typeof ChannelOnboardResponseSchema>

/** channel:mention — carries the M0-1 ContentBlock/Handle shapes unchanged. */
export const ChannelMentionRequestSchema = z.object({
  channelId: z.string(),
  idempotencyKey: z.string().optional(),
  mentions: z.array(HandleSchema).optional(),
  prompt: z.string().optional(),
  promptBlocks: z.array(ContentBlockSchema).optional(),
})

export type ChannelMentionRequest = z.infer<typeof ChannelMentionRequestSchema>

export const ChannelMentionResponseSchema = z.object({
  turn: TurnSchema,
})

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