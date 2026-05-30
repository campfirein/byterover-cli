import type {TurnEvent} from '../../../../shared/types/index.js'

/**
 * Append one fully-stamped transcript event. Location-agnostic by design: the
 * caller supplies `projectRoot` + `channelId` + `turnId`; the contract says
 * nothing about files, NDJSON, per-turn indexes, or whether storage is
 * per-project vs global. The path / retention policy is the adapter's concern.
 */
export type AppendTurnEventArgs = {
  readonly channelId: string
  /** Fully-stamped event — base fields already populated by the orchestrator. */
  readonly event: TurnEvent
  /** Project the channel lives under; the adapter resolves storage location from it. */
  readonly projectRoot: string
  readonly turnId: string
}

/** Read back every persisted event for one turn, in `seq` order. */
export type ReadTurnEventsArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turnId: string
}

/**
 * Append-and-read port for a turn's event log. Deliberately minimal: it does NOT
 * model turn / channel metadata (`IChannelStore` owns that), nor does it leak any
 * storage mechanism (no file handles, NDJSON, index, or GC in the contract).
 * Split out from the POC's combined store so transcript retention can evolve
 * without touching channel metadata.
 */
export interface ITranscriptStore {
  /** Appends one stamped `TurnEvent` to a turn's log. */
  appendTurnEvent(args: AppendTurnEventArgs): Promise<void>

  /** Reads all persisted events for a turn, ordered by `seq` ascending. */
  readTurnEvents(args: ReadTurnEventsArgs): Promise<TurnEvent[]>
}
