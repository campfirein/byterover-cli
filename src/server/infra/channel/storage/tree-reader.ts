import {promises as fs} from 'node:fs'

import type {Turn, TurnDelivery, TurnEvent} from '../../../../shared/types/channel.js'

import {TurnDeliverySchema, TurnSchema} from '../../../../shared/types/channel.js'
import {channelPaths} from './paths.js'

/**
 * Read side of the channel storage layer (CHANNEL_PROTOCOL.md §4.2;
 * Phase 9 layout).
 *
 * Two read APIs, each with a "new mount first, legacy fallback" shape:
 *
 *  - `readEvents`: returns the wire-event sequence for a turn.
 *    Reads the new per-turn NDJSON at
 *    `<projectRoot>/.brv/channel-history/<channelId>/turns/<turnId>.ndjson`
 *    first; structural lines tagged with `_recordType` are filtered out
 *    so subscribers/watchers/--after-seq replay only see wire events
 *    (codex + kimi Q7 consensus). If the new NDJSON is absent, falls
 *    back to the legacy `events.jsonl` under the context tree.
 *
 *  - `readTurn`: returns the persisted `Turn` record. Tries to
 *    find the latest `_recordType: 'turn_snapshot'` line in the new
 *    NDJSON; on miss or corrupt-snapshot-line, falls through to
 *    replaying wire events from the same NDJSON. If the new NDJSON is
 *    absent entirely, falls back to the legacy `turn.json` snapshot,
 *    and finally to legacy event-replay.
 *
 * Replay synthesis is intentionally minimal: it reconstructs `turnId`,
 * `channelId`, and the final `state` (last `turn_state_change` event).
 * Author / promptBlocks / startedAt come from the first message event
 * when the snapshot is gone; if events lack the data, fields are filled
 * with safe defaults so the orchestrator can still surface the turn to
 * readers (`brv channel show`) and resume from the NDJSON truth.
 */

const FALLBACK_EMPTY_AUTHOR: Turn['author'] = {handle: 'you', kind: 'local-user'}

export type ReadEventsArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turnId: string
}

export type ReadTurnArgs = {
  readonly channelId: string
  readonly projectRoot: string
  readonly turnId: string
}

const tryReadFile = async (path: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

type ParsedLine = Record<string, unknown> & {readonly _recordType?: string; readonly seq?: number}

const parseLine = (line: string): ParsedLine | undefined => {
  if (line.trim() === '') return undefined
  try {
    return JSON.parse(line) as ParsedLine
  } catch {
    return undefined
  }
}

const isWireEvent = (line: ParsedLine): line is ParsedLine & {readonly seq: number} =>
  line._recordType === undefined && typeof line.seq === 'number'

const parseEventsFromNdjson = (raw: string): TurnEvent[] => {
  const events: TurnEvent[] = []
  for (const physical of raw.split('\n')) {
    const parsed = parseLine(physical)
    if (parsed === undefined) continue
    if (!isWireEvent(parsed)) continue
    events.push(parsed as unknown as TurnEvent)
  }

  events.sort((a, b) => a.seq - b.seq)
  return events
}

const findLatestTurnSnapshot = (raw: string): Turn | undefined => {
  let latest: Turn | undefined
  for (const physical of raw.split('\n')) {
    const parsed = parseLine(physical)
    if (parsed === undefined) continue
    if (parsed._recordType !== 'turn_snapshot') continue
    const turnField = (parsed as {turn?: unknown}).turn
    if (turnField === undefined) continue
    try {
      latest = TurnSchema.parse(turnField)
    } catch {
      // Skip corrupt snapshot lines and keep scanning.
    }
  }

  return latest
}

export class ChannelTreeReader {
  /**
   * Slice 9.1 — read `_recordType: 'delivery_snapshot'` structural lines
   * from the new per-turn NDJSON, dedupe by `deliveryId` (last writer
   * wins), and return the parsed {@link TurnDelivery}s. Returns `[]` if
   * the new NDJSON is absent or contains no delivery snapshots.
   * Channel-store uses this BEFORE falling back to the legacy
   * `deliveries/<id>.json` directory or event-replay so post-Phase-9 turns
   * surface the same delivery shape their writer persisted.
   */
  async readDeliverySnapshotsFromNdjson(args: ReadEventsArgs): Promise<TurnDelivery[]> {
    const {channelId, projectRoot, turnId} = args
    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const raw = await tryReadFile(file)
    if (raw === undefined) return []

    const byDelivery = new Map<string, TurnDelivery>()
    for (const physical of raw.split('\n')) {
      const parsed = parseLine(physical)
      if (parsed === undefined) continue
      if (parsed._recordType !== 'delivery_snapshot') continue
      const deliveryField = (parsed as {delivery?: unknown}).delivery
      if (deliveryField === undefined) continue
      try {
        const delivery = TurnDeliverySchema.parse(deliveryField)
        byDelivery.set(delivery.deliveryId, delivery)
      } catch {
        // Skip corrupt structural lines.
      }
    }

    return [...byDelivery.values()]
  }

  async readEvents(args: ReadEventsArgs): Promise<TurnEvent[]> {
    const {channelId, projectRoot, turnId} = args

    const newFile = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const newRaw = await tryReadFile(newFile)
    if (newRaw !== undefined) {
      return parseEventsFromNdjson(newRaw)
    }

    // Legacy fallback (pre-Phase-9 turns).
    const legacyFile = channelPaths.eventsFile(projectRoot, channelId, turnId)
    const legacyRaw = await tryReadFile(legacyFile)
    if (legacyRaw === undefined) return []

    // Legacy events.jsonl never contained structural lines; pass through
    // the same parser anyway — the _recordType filter is a no-op there.
    return parseEventsFromNdjson(legacyRaw)
  }

  async readTurn(args: ReadTurnArgs): Promise<Turn | undefined> {
    const {channelId, projectRoot, turnId} = args

    const newFile = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const newRaw = await tryReadFile(newFile)
    if (newRaw !== undefined) {
      const snapshot = findLatestTurnSnapshot(newRaw)
      if (snapshot !== undefined) return snapshot

      const events = parseEventsFromNdjson(newRaw)
      if (events.length > 0) {
        return this.reconstructTurnFromEvents(channelId, turnId, events)
      }
    }

    // Legacy snapshot.
    const legacySnapshotFile = channelPaths.turnSnapshotFile(projectRoot, channelId, turnId)
    const legacySnapshotRaw = await tryReadFile(legacySnapshotFile)
    if (legacySnapshotRaw !== undefined) {
      try {
        return TurnSchema.parse(JSON.parse(legacySnapshotRaw))
      } catch {
        // Fall through to legacy event-replay.
      }
    }

    // Legacy event-replay (only fires when the new NDJSON is absent —
    // we already replayed from it above when it existed but had no
    // snapshot line).
    const legacyEventsRaw = await tryReadFile(channelPaths.eventsFile(projectRoot, channelId, turnId))
    if (legacyEventsRaw === undefined) return undefined
    const legacyEvents = parseEventsFromNdjson(legacyEventsRaw)
    if (legacyEvents.length === 0) return undefined
    return this.reconstructTurnFromEvents(channelId, turnId, legacyEvents)
  }

  /**
   * Phase-2 replay path: walks the event sequence (new mount first, legacy
   * fallback inside `readEvents`) and emits one {@link TurnDelivery}
   * per distinct `deliveryId` seen on `delivery_state_change` events, with
   * the latest-observed state as the current state. Returns `[]` when no
   * delivery events exist (passive Phase-1 turns).
   */
  async replayDeliveries(args: ReadEventsArgs): Promise<TurnDelivery[]> {
    const events = await this.readEvents(args)
    if (events.length === 0) return []

    type Accumulator = {
      firstEmittedAt: string
      lastEmittedAt: string
      memberHandle: string
      state: TurnDelivery['state']
    }
    const byDelivery = new Map<string, Accumulator>()

    for (const event of events) {
      if (event.kind !== 'delivery_state_change') continue
      const deliveryId = event.deliveryId ?? undefined
      if (deliveryId === undefined) continue
      const memberHandle = event.memberHandle ?? '@unknown'

      const existing = byDelivery.get(deliveryId)
      if (existing === undefined) {
        byDelivery.set(deliveryId, {
          firstEmittedAt: event.emittedAt,
          lastEmittedAt: event.emittedAt,
          memberHandle,
          state: event.to,
        })
      } else {
        existing.state = event.to
        existing.lastEmittedAt = event.emittedAt
      }
    }

    const TERMINAL_STATES = new Set<TurnDelivery['state']>(['cancelled', 'completed', 'errored'])
    const result: TurnDelivery[] = []
    for (const [deliveryId, acc] of byDelivery) {
      result.push({
        artifactsTouched: [],
        channelId: args.channelId,
        deliveryId,
        endedAt: TERMINAL_STATES.has(acc.state) ? acc.lastEmittedAt : undefined,
        memberHandle: acc.memberHandle,
        startedAt: acc.firstEmittedAt,
        state: acc.state,
        toolCallCount: 0,
        turnId: args.turnId,
      })
    }

    return result
  }

  private reconstructTurnFromEvents(
    channelId: string,
    turnId: string,
    events: TurnEvent[],
  ): Turn {
    const firstMessage = events.find((e): e is Extract<TurnEvent, {kind: 'message'}> => e.kind === 'message')
    const lastStateChange = [...events]
      .reverse()
      .find((e): e is Extract<TurnEvent, {kind: 'turn_state_change'}> => e.kind === 'turn_state_change')

    const startedAt = events[0]?.emittedAt ?? new Date(0).toISOString()
    // Only terminal states carry endedAt. `dispatched` is non-terminal
    // (see CHANNEL_PROTOCOL.md §4.5 table), so an in-flight turn surfaces with
    // `endedAt: undefined` after replay.
    const state = lastStateChange?.to ?? 'pending'
    const TERMINAL: Turn['state'][] = ['completed', 'cancelled']
    const endedAt = TERMINAL.includes(state) ? lastStateChange?.emittedAt : undefined

    return {
      author: FALLBACK_EMPTY_AUTHOR,
      channelId,
      endedAt,
      mentions: [],
      promptBlocks: firstMessage === undefined ? [] : [{text: firstMessage.content, type: 'text'}],
      promptedBy: 'user',
      startedAt,
      state,
      turnId,
    }
  }
}
