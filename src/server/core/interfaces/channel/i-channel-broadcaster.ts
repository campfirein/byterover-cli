/**
 * Outbound fan-out port used by the channel orchestrator.
 *
 * The orchestrator lives in the core layer and MUST NOT depend on the transport
 * server directly — the transport may later be swapped for a cross-machine
 * relay. The infra adapter binds this port to the real transport
 * server, delegating to `broadcastTo('channel:<channelId>', event, data)`.
 *
 * Fire-and-forget: there is no awaitable delivery guarantee. Subscribers are the
 * clients (TUI / webui / cli) joined to the `channel:<channelId>` room.
 */
export interface IChannelBroadcaster {
  /**
   * Emits `event` (with payload `data`) to every client subscribed to
   * `channel:<channelId>`.
   *
   * @param channelId - Channel whose subscribers receive the event.
   * @param event - Transport event name (e.g. `channel:turn-event`).
   * @param data - Event payload; shape is event-specific.
   */
  broadcastToChannel<T>(channelId: string, event: string, data: T): void
}
