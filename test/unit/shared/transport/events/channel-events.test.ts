import {expect} from 'chai'

import {
  ChannelArchiveRequestSchema,
  ChannelCreateRequestSchema,
  ChannelEvents,
  ChannelGetRequestSchema,
  ChannelGetTurnRequestSchema,
  ChannelListRequestSchema,
  ChannelListTurnsRequestSchema,
  ChannelPostRequestSchema,
} from '../../../../../src/shared/transport/events/channel-events.js'
import {AllEventGroups} from '../../../../../src/shared/transport/events/index.js'
import {ContentBlockSchema} from '../../../../../src/shared/types/channel.js'

// Slice 1.2 — ChannelEvents + Phase-1 zod schemas
// Goals (Phase-1 plan §1.2 + DoD §6):
//  - Full ChannelEvents constants are exported from day one (no name churn
//    between phases) and reachable through AllEventGroups.
//  - Phase-1 request schemas validate examples derived from
//    CHANNEL_PROTOCOL.md §8.1 + §8.4.
//  - Phase-2 event constants exist, but no request schema is exported for them.
describe('ChannelEvents (Slice 1.2)', () => {
  describe('constants', () => {
    it('exports the full set of channel:* event names per CHANNEL_PROTOCOL.md §3', () => {
      // Set comparison is order-insensitive; the canonical grouping
      // (lifecycle / membership / phase-3 ops / turns / broadcasts) is
      // preserved in the source file via
      // /* eslint-disable perfectionist/sort-objects */.
      // Alphabetical to satisfy `perfectionist/sort-sets`. Groupings
      // (Phase 1 + 2 lifecycle / membership / turns / broadcasts vs
      // Phase 3 ops surface vs Phase 10 quorum fan-out) live in
      // `channel-events.ts` source ordering — the Set here just
      // mirrors the wire-name surface.
      const expected = new Set([
        'channel:archive',
        'channel:cancel',
        'channel:create',
        'channel:doctor',
        'channel:get',
        'channel:get-turn',
        'channel:invite',
        'channel:leave',
        'channel:list',
        'channel:list-turns',
        'channel:member-update',
        'channel:members',
        'channel:mention',
        'channel:mention-quorum',
        'channel:onboard',
        'channel:permission-decision',
        'channel:post',
        'channel:profile-clear-drift',
        'channel:profile-list',
        'channel:profile-record-drift',
        'channel:profile-remove',
        'channel:profile-show',
        'channel:rotate-token',
        'channel:show-quorum',
        'channel:state-change',
        'channel:turn-event',
        'channel:uninvite',
      ])
      const actual = new Set(Object.values(ChannelEvents))
      expect(actual).to.deep.equal(expected)
    })

    it('registers ChannelEvents in the AllEventGroups index so cross-group iteration works', () => {
      expect(AllEventGroups).to.include(ChannelEvents)
    })

    it('exports Phase-2 event constants (mention, cancel, invite, etc.) as string literals', () => {
      // Names are locked from day one so phase migrations don't churn the wire.
      expect(ChannelEvents.MENTION).to.equal('channel:mention')
      expect(ChannelEvents.CANCEL).to.equal('channel:cancel')
      expect(ChannelEvents.INVITE).to.equal('channel:invite')
      expect(ChannelEvents.PERMISSION_DECISION).to.equal('channel:permission-decision')
    })
  })

  describe('ContentBlock schema (ACP-shaped)', () => {
    it('accepts a text block', () => {
      const parsed = ContentBlockSchema.safeParse({text: 'hello', type: 'text'})
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.format())).to.equal(true)
    })

    it('accepts a resource_link block', () => {
      const parsed = ContentBlockSchema.safeParse({type: 'resource_link', uri: 'file:///a.md'})
      expect(parsed.success).to.equal(true)
    })

    it('accepts a resource block', () => {
      const parsed = ContentBlockSchema.safeParse({
        resource: {mimeType: 'text/markdown', text: '...', uri: 'brv-channel://x/lookback'},
        type: 'resource',
      })
      expect(parsed.success).to.equal(true)
    })

    it('accepts image and audio blocks', () => {
      expect(ContentBlockSchema.safeParse({data: 'b64', mimeType: 'image/png', type: 'image'}).success).to.equal(true)
      expect(ContentBlockSchema.safeParse({data: 'b64', mimeType: 'audio/wav', type: 'audio'}).success).to.equal(true)
    })

    it('rejects an unknown discriminator value', () => {
      const parsed = ContentBlockSchema.safeParse({data: 'x', type: 'video'})
      expect(parsed.success).to.equal(false)
    })

    it('rejects a text block missing the text field', () => {
      const parsed = ContentBlockSchema.safeParse({type: 'text'})
      expect(parsed.success).to.equal(false)
    })
  })

  describe('Phase-1 request schemas', () => {
    it('ChannelCreateRequest: requires channelId or accepts the auto-id form per §8.1', () => {
      expect(ChannelCreateRequestSchema.safeParse({channelId: 'pi-test'}).success).to.equal(true)
      expect(ChannelCreateRequestSchema.safeParse({channelId: 'pi-test', title: 'Pi work'}).success).to.equal(true)
      expect(ChannelCreateRequestSchema.safeParse({}).success).to.equal(true) // optional channelId per spec
    })

    it('ChannelListRequest: accepts the empty payload and the optional archived flag', () => {
      expect(ChannelListRequestSchema.safeParse({}).success).to.equal(true)
      expect(ChannelListRequestSchema.safeParse({archived: true}).success).to.equal(true)
    })

    it('ChannelGetRequest: requires channelId', () => {
      expect(ChannelGetRequestSchema.safeParse({channelId: 'pi-test'}).success).to.equal(true)
      expect(ChannelGetRequestSchema.safeParse({}).success).to.equal(false)
    })

    it('ChannelArchiveRequest: requires channelId', () => {
      expect(ChannelArchiveRequestSchema.safeParse({channelId: 'pi-test'}).success).to.equal(true)
      expect(ChannelArchiveRequestSchema.safeParse({}).success).to.equal(false)
    })

    it('ChannelPostRequest: accepts prompt-only, promptBlocks-only, and both', () => {
      expect(
        ChannelPostRequestSchema.safeParse({channelId: 'pi-test', prompt: 'hello'}).success,
      ).to.equal(true)

      expect(
        ChannelPostRequestSchema.safeParse({
          channelId: 'pi-test',
          promptBlocks: [{text: 'hi', type: 'text'}],
        }).success,
      ).to.equal(true)

      expect(
        ChannelPostRequestSchema.safeParse({
          channelId: 'pi-test',
          prompt: 'tail',
          promptBlocks: [{type: 'resource_link', uri: 'file:///a.md'}],
        }).success,
      ).to.equal(true)
    })

    it('ChannelPostRequest: rejects malformed promptBlocks', () => {
      const parsed = ChannelPostRequestSchema.safeParse({
        channelId: 'pi-test',
        promptBlocks: [{type: 'text'}], // missing text field
      })
      expect(parsed.success).to.equal(false)
    })

    it('ChannelListTurnsRequest: requires channelId, optional cursor/limit', () => {
      expect(
        ChannelListTurnsRequestSchema.safeParse({channelId: 'pi-test'}).success,
      ).to.equal(true)
      expect(
        ChannelListTurnsRequestSchema.safeParse({channelId: 'pi-test', cursor: 'abc', limit: 10}).success,
      ).to.equal(true)
      expect(ChannelListTurnsRequestSchema.safeParse({}).success).to.equal(false)
    })

    it('ChannelGetTurnRequest: requires channelId and turnId', () => {
      expect(
        ChannelGetTurnRequestSchema.safeParse({channelId: 'pi-test', turnId: '01HX'}).success,
      ).to.equal(true)
      expect(ChannelGetTurnRequestSchema.safeParse({channelId: 'pi-test'}).success).to.equal(false)
      expect(ChannelGetTurnRequestSchema.safeParse({turnId: '01HX'}).success).to.equal(false)
    })
  })
})
