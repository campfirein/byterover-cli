import type {
  Channel,
  ChannelMeta,
  Turn,
  TurnDelivery,
  TurnEvent,
} from '../../../../shared/types/channel.js'

/**
 * Phase-1 channel persistence contract.
 *
 * The store is a thin facade over the storage layer
 * (`src/server/infra/channel/storage/`): it knows how to read and write
 * `meta.json` for channels and to durably append turn events. It does NOT
 * implement orchestrator policy (state-machine transitions, mention parsing,
 * snapshot lifecycle) — that lives in the orchestrator (Slice 1.4).
 *
 * Slice 1.4 wires a concrete implementation that composes
 * {@link ChannelEventsWriter}, {@link ChannelSnapshotWriter}, and
 * {@link ChannelTreeReader}.
 */

export type ChannelStoreCreateArgs = {
  readonly meta: ChannelMeta
  readonly projectRoot: string
}

export type ChannelStoreUpdateMetaArgs = {
  readonly channelId: string
  readonly mutate: (meta: ChannelMeta) => ChannelMeta
  readonly projectRoot: string
}

export type ChannelStoreReadArgs = {
  readonly channelId: string
  readonly projectRoot: string
}

export type ChannelStoreListArgs = {
  readonly includeArchived?: boolean
  readonly projectRoot: string
}

export type ChannelStoreAppendEventArgs = {
  readonly channelId: string
  readonly event: TurnEvent
  readonly projectRoot: string
  readonly turnId: string
}

export type ChannelStoreSnapshotArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turn: Turn
  readonly turnId: string
}

export type ChannelStoreListTurnsArgs = {
  readonly channelId: string
  readonly cursor?: string
  readonly limit?: number
  readonly projectRoot: string
}

export type ChannelStoreListTurnsResult = {
  readonly nextCursor?: string
  readonly turns: Turn[]
}

export type ChannelStoreReadTurnArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turnId: string
}

export type ChannelStoreReadTurnResult = {
  readonly deliveries?: TurnDelivery[]
  readonly events: TurnEvent[]
  readonly turn: Turn
}

// ─── Phase-2 delivery + message snapshot args ───────────────────────────────

export type ChannelStoreWriteDeliveryArgs = {
  readonly channelId: string
  readonly delivery: TurnDelivery
  readonly deliveryId: string
  readonly projectRoot: string
  readonly turnId: string
}

export type ChannelStoreWriteMessageArgs = {
  readonly body: string
  readonly channelId: string
  readonly deliveryId: string
  readonly projectRoot: string
  readonly turnId: string
}

export type ChannelStoreReadDeliveriesArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turnId: string
}

export type ChannelStoreCloseTranscriptArgs = {
  readonly channelId: string
  readonly turnId: string
}

export type ChannelTurnIndexDeliverySummary = {
  readonly deliveryId: string
  readonly finalAnswer?: string
  readonly memberHandle: string
  readonly state: TurnDelivery['state']
}

export type ChannelTurnIndexEntry = {
  readonly deliveries: ChannelTurnIndexDeliverySummary[]
  readonly turn: Turn
}

export type ChannelStoreAppendTurnIndexArgs = {
  readonly channelId: string
  readonly entry: ChannelTurnIndexEntry
  readonly projectRoot: string
}

export interface IChannelStore {
  appendTurnEvent(args: ChannelStoreAppendEventArgs): Promise<void>
  /**
   * Slice 9.3 — append a terminal-state materialised entry to the
   * per-channel index. No-op when the index store is not wired (read-
   * from-both migration window). The orchestrator calls this after
   * writeTurnSnapshot / writeDeliverySnapshot at every terminal state
   * so the next mention's list-turns + lookback paths skip per-turn
   * NDJSON opens.
   */
  appendTurnIndexEntry(args: ChannelStoreAppendTurnIndexArgs): Promise<void>
  /**
   * Slice 9.2 — close the per-turn held-open write stream. Called by the
   * orchestrator at terminal state after writeTurnSnapshot and any
   * writeDeliverySnapshot calls, so the underlying file descriptor is
   * released. Idempotent: a no-op if no stream is open for the turn.
   */
  closeTranscriptStream(args: ChannelStoreCloseTranscriptArgs): Promise<void>
  createChannel(args: ChannelStoreCreateArgs): Promise<Channel>
  listChannels(args: ChannelStoreListArgs): Promise<Channel[]>
  listTurns(args: ChannelStoreListTurnsArgs): Promise<ChannelStoreListTurnsResult>
  readChannel(args: ChannelStoreReadArgs): Promise<Channel | undefined>
  /**
   * Phase-2 read path that returns the full `ChannelMeta` (discriminated-union
   * member records with `invocation`, `capabilities`, etc.). The summarised
   * wire `Channel` projection is still served by {@link readChannel}.
   */
  readChannelMeta(args: ChannelStoreReadArgs): Promise<ChannelMeta | undefined>
  /**
   * Phase-2 delivery read path. Returns the persisted `deliveries/<id>.json`
   * snapshots when present, otherwise replays them from `events.jsonl` via
   * the tree-reader. Returns `[]` when no events and no snapshots exist.
   */
  readDeliveries(args: ChannelStoreReadDeliveriesArgs): Promise<TurnDelivery[]>
  readTurn(args: ChannelStoreReadTurnArgs): Promise<ChannelStoreReadTurnResult | undefined>
  /**
   * Phase 9.5.10 — defensive recovery for the "channel meta vanished but
   * channel-history survived" case. Writes `meta` under the same per-channel
   * lock as `createChannel` so the kimi-flagged overwrite race is closed:
   * if a concurrent createChannel wrote first, this returns 'already-exists'
   * and leaves the existing meta untouched. Returns 'wrote' on success.
   */
  reconstructIfMissing(args: ChannelStoreCreateArgs): Promise<'already-exists' | 'wrote'>
  /**
   * Slice 9.4 — best-effort GC sweep for a single channel. Removes
   * per-turn NDJSON files whose materialised index entry shows the turn
   * ended more than `retentionDays` ago, then compacts the index.
   * No-op when the transcript GC has not been wired (e.g. tests that
   * don't care about retention). The orchestrator fires this async
   * from terminal-state finalisation so old transcripts cap.
   */
  sweepTranscripts(args: {readonly channelId: string; readonly projectRoot: string}): Promise<void>
  updateChannelMeta(args: ChannelStoreUpdateMetaArgs): Promise<Channel>
  /** Phase-2: persist a `deliveries/<id>.json` snapshot at terminal state. */
  writeDeliverySnapshot(args: ChannelStoreWriteDeliveryArgs): Promise<void>
  /** Phase-2: persist the rendered final message body for a delivery. */
  writeMessage(args: ChannelStoreWriteMessageArgs): Promise<void>
  writeTurnSnapshot(args: ChannelStoreSnapshotArgs): Promise<void>
}
