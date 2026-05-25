import type {Turn, TurnDelivery} from '../../../../shared/types/channel.js'

import {ChannelEventsWriter} from './events-writer.js'

/**
 * Terminal-state structural-line writer for the per-turn NDJSON
 * (CHANNEL_PROTOCOL.md §4.2; Phase 9 layout).
 *
 * At turn-terminal the orchestrator emits three classes of structural
 * record that summarise the turn for fast `brv channel show` reads:
 *
 *  - `_recordType: 'turn_snapshot'`     — the full Turn record
 *  - `_recordType: 'delivery_snapshot'` — one per delivery
 *  - `_recordType: 'message'`           — rendered final message body per delivery
 *
 * The envelope key (`_recordType`) is intentionally separate from the
 * wire-event `kind` field so replay scanners (subscribe/watch/--after-seq)
 * can filter structural lines cleanly without false-positive event
 * emission. Both codex and kimi flagged the collision risk in the Phase 9
 * design review; this enforces their consensus shape.
 *
 * Slice 9.2 — structural lines are appended through the
 * {@link ChannelEventsWriter}'s `appendRawLine` so both writers share
 * the held per-turn write stream AND the per-turn lock. This prevents
 * concurrent fan-out terminal writes from tearing NDJSON line ordering
 * (kimi Q8) and avoids a redundant open/close pair per terminal record.
 *
 * Callers (orchestrator's finaliseTurn / finaliseDelivery) MUST only
 * invoke these methods on terminal-state transitions; the writer does
 * not enforce write-once, but the underlying append is idempotent on
 * downstream readers (last writer wins for the materialised snapshot
 * — the index entry, Slice 9.3, records the latest one).
 */

export type ChannelSnapshotWriterOptions = {
  readonly eventsWriter: ChannelEventsWriter
}

export type WriteTurnSnapshotArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turn: Turn
  readonly turnId: string
}

export type WriteDeliverySnapshotArgs = {
  readonly channelId: string
  readonly delivery: TurnDelivery
  readonly deliveryId: string
  readonly projectRoot: string
  readonly turnId: string
}

export type WriteMessageArgs = {
  readonly body: string
  readonly channelId: string
  readonly deliveryId: string
  readonly projectRoot: string
  readonly turnId: string
}

type StructuralLine =
  | {readonly _recordType: 'delivery_snapshot'; readonly delivery: TurnDelivery; readonly deliveryId: string}
  | {readonly _recordType: 'message'; readonly body: string; readonly deliveryId: string}
  | {readonly _recordType: 'turn_snapshot'; readonly turn: Turn}

export class ChannelSnapshotWriter {
  private readonly eventsWriter: ChannelEventsWriter

  public constructor(options: ChannelSnapshotWriterOptions) {
    this.eventsWriter = options.eventsWriter
  }

  async writeDeliverySnapshot(args: WriteDeliverySnapshotArgs): Promise<void> {
    const {channelId, delivery, deliveryId, projectRoot, turnId} = args
    await this.appendStructuralLine({
      channelId,
      line: {_recordType: 'delivery_snapshot', delivery, deliveryId},
      projectRoot,
      turnId,
    })
  }

  async writeMessage(args: WriteMessageArgs): Promise<void> {
    const {body, channelId, deliveryId, projectRoot, turnId} = args
    await this.appendStructuralLine({
      channelId,
      line: {_recordType: 'message', body, deliveryId},
      projectRoot,
      turnId,
    })
  }

  async writeTurnSnapshot(args: WriteTurnSnapshotArgs): Promise<void> {
    const {channelId, projectRoot, turn, turnId} = args
    await this.appendStructuralLine({
      channelId,
      line: {_recordType: 'turn_snapshot', turn},
      projectRoot,
      turnId,
    })
  }

  private async appendStructuralLine(args: {
    readonly channelId: string
    readonly line: StructuralLine
    readonly projectRoot: string
    readonly turnId: string
  }): Promise<void> {
    const {channelId, line, projectRoot, turnId} = args
    await this.eventsWriter.appendRawLine({
      channelId,
      line: JSON.stringify(line),
      projectRoot,
      turnId,
    })
  }
}
