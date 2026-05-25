import type {Turn, TurnEvent} from '../../../shared/types/channel.js'
import type {IChannelBroadcaster} from '../../core/interfaces/channel/i-channel-broadcaster.js'
import type {IChannelStore} from '../../core/interfaces/channel/i-channel-store.js'
import type {ITurnSequenceAllocator} from '../../core/interfaces/channel/i-turn-sequence-allocator.js'
import type {IBrokerPersistence, TrackRecord} from './drivers/broker-persistence.js'
import type {ChannelEventsWriter} from './storage/events-writer.js'
import type {ChannelTreeReader} from './storage/tree-reader.js'

import {ChannelEvents} from '../../../shared/transport/events/channel-events.js'
import {computeLivePending} from './drivers/broker-persistence.js'

/**
 * Phase-3 daemon-bootstrap recovery (Slice 3.5c).
 *
 * On a fresh daemon process, the in-memory `TurnSequenceAllocator` and
 * `ChannelEventsWriter.lastSeqByTurn` both start empty. If we emit a
 * `delivery_state_change → errored` event for a pending permission
 * without first seeding the allocator, the new event lands at seq=0 over
 * the top of existing events on disk — corrupting replay.
 *
 * `runChannelRecovery` performs the full bootstrap sequence:
 *   1. Read the broker-persistence file, fold tracks/resolves into a
 *      live set.
 *   2. For each live `(channelId, turnId, projectRoot)` tuple, walk
 *      events.jsonl ONCE — derive lastSeq, seed the allocator + writer.
 *   3. Emit `delivery_state_change awaiting_permission → errored` for
 *      every live permission (broadcast + persist).
 *   4. If every delivery on that turn is now in a terminal state, emit
 *      `turn_state_change dispatched → completed` and finalise the
 *      `turn.json` / `deliveries/*.json` snapshots.
 *   5. Truncate the broker-persistence file (atomic-rename empty).
 */

export type ChannelRecoveryDeps = {
  readonly broadcaster: IChannelBroadcaster
  readonly brokerPersistence: IBrokerPersistence
  readonly clock: () => Date
  readonly eventsWriter: ChannelEventsWriter
  readonly seqAllocator: ITurnSequenceAllocator
  readonly store: IChannelStore
  readonly treeReader: ChannelTreeReader
}

// Slice 8.10 — every orphaned permission produces one of these records so the
// orchestrator can seed an in-memory registry; `permissionDecision()` then
// surfaces `CHANNEL_PERMISSION_LOST_ON_RESTART` (with a Slice-8.9 cursor)
// instead of the misleading `CHANNEL_TURN_NOT_FOUND`. erroredSeq is the seq
// of the `delivery_state_change → errored` event on disk (newly written or
// pre-existing per the idempotency guard).
export type RestartLossRecord = {
  channelId: string
  erroredSeq: number
  permissionRequestId: string
  turnId: string
}

export type ChannelRecoverySummary = {
  finalisedTurns: number
  recoveredDeliveries: number
  restartLosses: RestartLossRecord[]
}

// Used by the idempotency guard (codex Q1): if a delivery already has a
// restart-loss errored event on disk, skip the duplicate write but still
// emit the corresponding RestartLossRecord from the existing event's seq.
const RESTART_LOSS_ERROR_TEXT = 'permission state lost on daemon restart'

export const runChannelRecovery = async (deps: ChannelRecoveryDeps): Promise<ChannelRecoverySummary> => {
  const records = await deps.brokerPersistence.readAll()
  const live = computeLivePending(records)
  if (live.length === 0) {
    // Nothing to do; still truncate so a fresh start doesn't accumulate
    // stale resolve-tombstones over time.
    await deps.brokerPersistence.truncate()
    return {finalisedTurns: 0, recoveredDeliveries: 0, restartLosses: []}
  }

  // Group live entries by (channelId, turnId, projectRoot).
  const byTurn = new Map<string, {channelId: string; entries: TrackRecord[]; projectRoot: string; turnId: string}>()
  for (const entry of live) {
    const key = `${entry.channelId}\0${entry.turnId}\0${entry.projectRoot}`
    let bucket = byTurn.get(key)
    if (bucket === undefined) {
      bucket = {channelId: entry.channelId, entries: [], projectRoot: entry.projectRoot, turnId: entry.turnId}
      byTurn.set(key, bucket)
    }

    bucket.entries.push(entry)
  }

  let finalisedTurns = 0
  let recoveredDeliveries = 0
  const restartLosses: RestartLossRecord[] = []

  for (const {channelId, entries, projectRoot, turnId} of byTurn.values()) {
    // eslint-disable-next-line no-await-in-loop
    const events = await deps.treeReader.readEvents({channelId, projectRoot, turnId})
    if (events.length === 0) continue

    // Seed allocator + writer to the highest seq we observe so the next
    // emitted event lands at lastSeq + 1.
    let lastSeq = 0
    for (const e of events) {
      if (Number.isFinite(e.seq) && e.seq > lastSeq) lastSeq = e.seq
    }

    deps.seqAllocator.seed({channelId, lastSeq, turnId})
    deps.eventsWriter.seedLastSeq(channelId, turnId, lastSeq)

    // Codex Q1 idempotency guard: if a prior recovery already wrote the
    // restart-loss errored event for a deliveryId (e.g. the daemon crashed
    // between writing the event and truncating pending-permissions.jsonl),
    // re-running recovery should NOT write a second event. But the orphan
    // registry still needs an entry for `permissionDecision()` to surface
    // the loss code, so we emit a RestartLossRecord from the existing seq.
    const existingRestartLossByDelivery = new Map<string, number>()
    for (const e of events) {
      if (
        e.kind === 'delivery_state_change' &&
        e.to === 'errored' &&
        e.error === RESTART_LOSS_ERROR_TEXT &&
        e.deliveryId !== null
      ) {
        existingRestartLossByDelivery.set(e.deliveryId, e.seq)
      }
    }

    // Emit `delivery_state_change → errored` for each pending permission.
    // The orchestrator's recovery is responsible for `awaiting_permission`
    // → `errored` only (other in-flight states finalise via the normal
    // background-task path once the daemon's drivers are re-spawned by a
    // future invite).
    const erroredDeliveryIds = new Set<string>()
    for (const entry of entries) {
      const existingSeq = existingRestartLossByDelivery.get(entry.deliveryId)
      if (existingSeq !== undefined) {
        // Idempotency guard fired — record the existing seq, no append.
        restartLosses.push({
          channelId,
          erroredSeq: existingSeq,
          permissionRequestId: entry.permissionRequestId,
          turnId,
        })
        erroredDeliveryIds.add(entry.deliveryId)
        continue
      }

      const seq = deps.seqAllocator.next({channelId, turnId})
      const event: TurnEvent = {
        channelId,
        deliveryId: entry.deliveryId,
        emittedAt: deps.clock().toISOString(),
        error: RESTART_LOSS_ERROR_TEXT,
        from: 'awaiting_permission',
        kind: 'delivery_state_change',
        memberHandle: entry.memberHandle,
        seq,
        to: 'errored',
        turnId,
      }
      // eslint-disable-next-line no-await-in-loop
      await deps.store.appendTurnEvent({channelId, event, projectRoot, turnId})
      // Recovery runs during daemon bootstrap, BEFORE the Socket.IO server
      // is listening. broadcastToChannel will throw "Server not started"
      // here; that must not abort the loop — persistence is the source of
      // truth, and any clients that connect after bootstrap re-read events
      // from disk via `channel show` / `channel list-turns`.
      try {
        deps.broadcaster.broadcastToChannel(channelId, ChannelEvents.TURN_EVENT, {channelId, event})
      } catch {
        // Broadcast is best-effort during recovery — event is already
        // durably persisted on disk.
      }

      restartLosses.push({
        channelId,
        erroredSeq: seq,
        permissionRequestId: entry.permissionRequestId,
        turnId,
      })
      erroredDeliveryIds.add(entry.deliveryId)
      recoveredDeliveries += 1
    }

    // Finalise the turn if every delivery is now in a terminal state.
    // eslint-disable-next-line no-await-in-loop
    const turn = await deps.store.readTurn({channelId, projectRoot, turnId})
    if (turn === undefined) continue
    // eslint-disable-next-line no-await-in-loop
    const deliveries = await deps.store.readDeliveries({channelId, projectRoot, turnId})
    // Replay-based delivery reconstruction returns the latest state per
    // deliveryId. Our just-emitted `errored` events should be folded in.
    const allTerminal = deliveries.every((d) => d.state === 'completed' || d.state === 'cancelled' || d.state === 'errored')
    if (!allTerminal) continue
    if (turn.turn.state !== 'dispatched') continue

     
    const finaliseSeq = deps.seqAllocator.next({channelId, turnId})
    const finaliseEvent: TurnEvent = {
      channelId,
      deliveryId: null,
      emittedAt: deps.clock().toISOString(),
      from: 'dispatched',
      kind: 'turn_state_change',
      memberHandle: null,
      seq: finaliseSeq,
      to: 'completed',
      turnId,
    }
    // eslint-disable-next-line no-await-in-loop
    await deps.store.appendTurnEvent({channelId, event: finaliseEvent, projectRoot, turnId})
    try {
      deps.broadcaster.broadcastToChannel(channelId, ChannelEvents.TURN_EVENT, {channelId, event: finaliseEvent})
    } catch {
      // See above — broadcast is best-effort during bootstrap.
    }

    // Write the terminal turn.json snapshot — but only if it does not
    // already exist (the daemon may have finalised before crashing and
    // the broker file was stale).
    const finalTurn: Turn = {...turn.turn, endedAt: deps.clock().toISOString(), state: 'completed'}
    // eslint-disable-next-line no-await-in-loop
    await deps.store.writeTurnSnapshot({channelId, projectRoot, turn: finalTurn, turnId})
    for (const d of deliveries) {
      // eslint-disable-next-line no-await-in-loop
      await deps.store.writeDeliverySnapshot({channelId, delivery: d, deliveryId: d.deliveryId, projectRoot, turnId})
    }

    deps.seqAllocator.reset({channelId, turnId})
    finalisedTurns += 1
  }

  await deps.brokerPersistence.truncate()
  return {finalisedTurns, recoveredDeliveries, restartLosses}
}
