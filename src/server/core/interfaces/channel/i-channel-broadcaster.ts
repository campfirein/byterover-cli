/**
 * Broadcast facade used by the channel orchestrator.
 *
 * The orchestrator MUST NOT depend on the transport server directly — it
 * lives in the domain layer and Phase 3+ may swap the transport (e.g. for
 * cross-machine relays). The handler wires a concrete implementation that
 * delegates to `ITransportServer.broadcastTo('channel:<id>', event, data)`.
 *
 * Phase 1 emits two broadcast events per CHANNEL_PROTOCOL.md §9:
 *  - `channel:turn-event` — one per TurnEvent appended to events.jsonl
 *  - `channel:state-change` — when a channel's metadata (members, archivedAt) changes
 *
 * `channel:member-update` (the third broadcast in the spec) lands with Phase 2
 * when members can be added/removed at runtime.
 */
export interface IChannelBroadcaster {
  /**
   * Emit `event` (with payload `data`) to all clients subscribed to
   * `channel:<channelId>`. Fire-and-forget; no awaitable delivery guarantee.
   */
  broadcastToChannel<T>(channelId: string, event: string, data: T): void
}
