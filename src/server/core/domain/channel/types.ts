/**
 * Server-side channel domain types.
 *
 * The canonical wire + on-disk shapes live in `src/shared/types/channel.ts`
 * so they can be imported by both the transport layer (which is in `shared/`)
 * and the server-only orchestrator/storage modules. This module re-exports
 * the shared schemas so server code has a single import surface
 * (`server/core/domain/channel/types.js`) without the layering noise.
 *
 * Slice 1.3 ships only the re-exports. Phase 2 may add server-only domain
 * extensions (e.g. orchestrator-internal projections) alongside these.
 */

export {
  ChannelMemberSchema,
  ChannelMemberSummarySchema,
  ChannelMetaSchema,
  ChannelSchema,
  ChannelSettingsSchema,
  ContentBlockSchema,
  TurnAuthorSchema,
  TurnDeliverySchema,
  TurnDeliveryStateSchema,
  TurnEventSchema,
  TurnSchema,
  TurnStateSchema,
} from '../../../../shared/types/channel.js'

export type {
  Channel,
  ChannelMember,
  ChannelMemberSummary,
  ChannelMeta,
  ChannelSettings,
  ContentBlock,
  Turn,
  TurnAuthor,
  TurnDelivery,
  TurnDeliveryState,
  TurnEvent,
  TurnState,
} from '../../../../shared/types/channel.js'
