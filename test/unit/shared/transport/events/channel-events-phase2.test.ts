import {expect} from 'chai'

import {
  ChannelCancelRequestSchema,
  ChannelCancelResponseSchema,
  ChannelInviteRequestSchema,
  ChannelInviteResponseSchema,
  ChannelMemberUpdateBroadcastSchema,
  ChannelMentionRequestSchema,
  ChannelPermissionDecisionRequestSchema,
  ChannelPermissionDecisionResponseSchema,
  ChannelTurnAcceptedResponseSchema,
  ChannelUninviteRequestSchema,
  ChannelUninviteResponseSchema,
} from '../../../../../src/shared/transport/events/channel-events.js'

// Slice 2.0 — Phase-2 wire schemas (CHANNEL_PROTOCOL.md §8.2 + §8.4 + §8.5).
//
// Each schema mirrors the §8 shape verbatim, plus two Phase-2 refinements on
// ChannelInviteRequestSchema:
//   (a) `handle` must start with `@`  (canonical-handle convention)
//   (b) `profileName` XOR `invocation`  (no driver-profile registry until Phase 3)

const isoNow = (): string => new Date().toISOString()

const validTurn = {
  author: {handle: 'you', kind: 'local-user'},
  channelId: 'ch-1',
  mentions: [],
  promptBlocks: [{text: 'hi', type: 'text'}],
  promptedBy: 'user',
  startedAt: isoNow(),
  state: 'dispatched',
  turnId: 't-1',
} as const

const validDelivery = {
  artifactsTouched: [],
  channelId: 'ch-1',
  deliveryId: 'd-1',
  memberHandle: '@mock',
  startedAt: isoNow(),
  state: 'dispatched',
  toolCallCount: 0,
  turnId: 't-1',
} as const

const validAcpMember = {
  acpVersion: '1',
  agentName: '@mock',
  capabilities: [],
  driverClass: 'C-prime',
  handle: '@mock',
  invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
  joinedAt: isoNow(),
  memberKind: 'acp-agent',
  status: 'idle',
} as const

describe('ChannelEvents Phase-2 schemas', () => {
  describe('ChannelInviteRequestSchema', () => {
    it('accepts an inline invocation with an @-prefixed handle', () => {
      const parsed = ChannelInviteRequestSchema.safeParse({
        channelId: 'ch-1',
        handle: '@mock',
        invocation: {args: ['mock-acp.js'], command: 'node', cwd: '/tmp'},
      })
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).to.equal(true)
    })

    it('accepts a profileName reference (registry resolution is a Phase 3 handler concern)', () => {
      const parsed = ChannelInviteRequestSchema.safeParse({
        channelId: 'ch-1',
        handle: '@mock',
        profileName: 'mock-profile',
      })
      expect(parsed.success).to.equal(true)
    })

    it('rejects a handle that does not start with @', () => {
      const parsed = ChannelInviteRequestSchema.safeParse({
        channelId: 'ch-1',
        handle: 'mock',
        invocation: {args: [], command: 'node', cwd: '/tmp'},
      })
      expect(parsed.success).to.equal(false)
    })

    it('rejects when neither profileName nor invocation is present', () => {
      const parsed = ChannelInviteRequestSchema.safeParse({
        channelId: 'ch-1',
        handle: '@mock',
      })
      expect(parsed.success).to.equal(false)
    })

    it('rejects when BOTH profileName and invocation are present (XOR)', () => {
      const parsed = ChannelInviteRequestSchema.safeParse({
        channelId: 'ch-1',
        handle: '@mock',
        invocation: {args: [], command: 'node', cwd: '/tmp'},
        profileName: 'mock-profile',
      })
      expect(parsed.success).to.equal(false)
    })
  })

  describe('ChannelInviteResponseSchema', () => {
    it('accepts { member: ChannelMember }', () => {
      const parsed = ChannelInviteResponseSchema.safeParse({member: validAcpMember})
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).to.equal(true)
    })
  })

  describe('ChannelUninviteRequestSchema', () => {
    it('accepts { channelId, memberHandle }', () => {
      const parsed = ChannelUninviteRequestSchema.safeParse({channelId: 'ch-1', memberHandle: '@mock'})
      expect(parsed.success).to.equal(true)
    })
  })

  describe('ChannelUninviteResponseSchema', () => {
    it('accepts { member }', () => {
      const parsed = ChannelUninviteResponseSchema.safeParse({member: {...validAcpMember, status: 'left'}})
      expect(parsed.success).to.equal(true)
    })
  })

  describe('ChannelMentionRequestSchema', () => {
    it('accepts prompt-only', () => {
      const parsed = ChannelMentionRequestSchema.safeParse({channelId: 'ch-1', prompt: '@mock hi'})
      expect(parsed.success).to.equal(true)
    })

    it('accepts promptBlocks-only (structured-prompt clients)', () => {
      const parsed = ChannelMentionRequestSchema.safeParse({
        channelId: 'ch-1',
        promptBlocks: [{type: 'resource_link', uri: 'file:///a.md'}],
      })
      expect(parsed.success).to.equal(true)
    })

    it('accepts explicit mentions[] alongside or instead of inline @handles', () => {
      const parsed = ChannelMentionRequestSchema.safeParse({
        channelId: 'ch-1',
        mentions: ['@mock'],
        promptBlocks: [{text: 'hi', type: 'text'}],
      })
      expect(parsed.success).to.equal(true)
    })

    it('accepts optional lookback knobs', () => {
      const parsed = ChannelMentionRequestSchema.safeParse({
        channelId: 'ch-1',
        lookback: {facts: 5, recentTurns: 10},
        prompt: '@mock hi',
      })
      expect(parsed.success).to.equal(true)
    })

    it('does NOT enforce prompt-presence at the schema layer — domain validates after normalisation', () => {
      // §8.4 normalisation rules are applied by the prompt normaliser, not by zod;
      // the schema admits both fields absent so the domain can return the
      // canonical CHANNEL_PROMPT_EMPTY error rather than a zod validation error.
      const parsed = ChannelMentionRequestSchema.safeParse({channelId: 'ch-1'})
      expect(parsed.success).to.equal(true)
    })
  })

  describe('ChannelTurnAcceptedResponseSchema', () => {
    it('requires turn + deliveries', () => {
      const parsed = ChannelTurnAcceptedResponseSchema.safeParse({
        deliveries: [validDelivery],
        turn: validTurn,
      })
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).to.equal(true)
    })
  })

  describe('ChannelCancelRequestSchema', () => {
    it('accepts the full-turn shape (no deliveryId)', () => {
      const parsed = ChannelCancelRequestSchema.safeParse({channelId: 'ch-1', turnId: 't-1'})
      expect(parsed.success).to.equal(true)
    })

    it('accepts the per-delivery shape (with deliveryId)', () => {
      const parsed = ChannelCancelRequestSchema.safeParse({
        channelId: 'ch-1',
        deliveryId: 'd-1',
        turnId: 't-1',
      })
      expect(parsed.success).to.equal(true)
    })
  })

  describe('ChannelCancelResponseSchema', () => {
    it('requires turn + deliveries', () => {
      const parsed = ChannelCancelResponseSchema.safeParse({
        deliveries: [{...validDelivery, state: 'cancelled'}],
        turn: {...validTurn, state: 'cancelled'},
      })
      expect(parsed.success).to.equal(true)
    })
  })

  describe('ChannelPermissionDecisionRequestSchema', () => {
    it('accepts a selected outcome', () => {
      const parsed = ChannelPermissionDecisionRequestSchema.safeParse({
        channelId: 'ch-1',
        outcome: {optionId: 'opt-1', outcome: 'selected'},
        permissionRequestId: 'p-1',
        turnId: 't-1',
      })
      expect(parsed.success).to.equal(true)
    })

    it('accepts a cancelled outcome', () => {
      const parsed = ChannelPermissionDecisionRequestSchema.safeParse({
        channelId: 'ch-1',
        outcome: {outcome: 'cancelled'},
        permissionRequestId: 'p-1',
        turnId: 't-1',
      })
      expect(parsed.success).to.equal(true)
    })

    it('rejects a non-ACP "denied" outcome', () => {
      // ACP has no 'denied' variant; deny is implemented at the CLI by
      // resolving to a reject-flavoured `selected` outcome.
      const parsed = ChannelPermissionDecisionRequestSchema.safeParse({
        channelId: 'ch-1',
        outcome: {outcome: 'denied'},
        permissionRequestId: 'p-1',
        turnId: 't-1',
      })
      expect(parsed.success).to.equal(false)
    })
  })

  describe('ChannelPermissionDecisionResponseSchema', () => {
    it('returns the persisted permission_decision TurnEvent', () => {
      const parsed = ChannelPermissionDecisionResponseSchema.safeParse({
        event: {
          channelId: 'ch-1',
          deliveryId: 'd-1',
          emittedAt: isoNow(),
          kind: 'permission_decision',
          memberHandle: '@mock',
          outcome: {outcome: 'cancelled'},
          permissionRequestId: 'p-1',
          seq: 4,
          turnId: 't-1',
        },
      })
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).to.equal(true)
    })
  })

  describe('ChannelMemberUpdateBroadcastSchema', () => {
    it('accepts an added/updated/removed op', () => {
      for (const op of ['added', 'updated', 'removed'] as const) {
        const parsed = ChannelMemberUpdateBroadcastSchema.safeParse({
          channelId: 'ch-1',
          member: validAcpMember,
          op,
        })
        expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).to.equal(true)
      }
    })

    it('rejects an unknown op', () => {
      const parsed = ChannelMemberUpdateBroadcastSchema.safeParse({
        channelId: 'ch-1',
        member: validAcpMember,
        op: 'banished',
      })
      expect(parsed.success).to.equal(false)
    })
  })
})
