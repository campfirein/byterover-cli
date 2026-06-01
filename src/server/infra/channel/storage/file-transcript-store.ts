import {appendFile, mkdir, readFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'

import type {TurnEvent} from '../../../../shared/types/channel.js'
import type {
  AppendTurnEventArgs,
  ITranscriptStore,
  ReadTurnEventsArgs,
} from '../../../core/interfaces/channel/i-transcript-store.js'

import {AsyncMutex} from '../../../../agent/infra/llm/context/async-mutex.js'
import {TurnEventSchema} from '../../../../shared/types/channel.js'
import {channelPaths} from './channel-paths.js'

/** Watermark meaning "no events persisted yet", so the first event (`seq: 0`) is accepted. */
const NO_EVENTS = -1

/**
 * Reads and validates every event line of a turn's NDJSON file. Missing file →
 * `[]`; blank or non-parseable lines are skipped so a single corrupt line never
 * fails the whole read. Returns events in file order (callers sort by `seq`).
 */
const readEventsFromFile = async (file: string): Promise<TurnEvent[]> => {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }

  const events: TurnEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue

    let json: unknown
    try {
      json = JSON.parse(trimmed)
    } catch {
      continue
    }

    const parsed = TurnEventSchema.safeParse(json)
    if (parsed.success) events.push(parsed.data)
  }

  return events
}

/**
 * File-backed {@link ITranscriptStore}: one append-only NDJSON file per turn at
 * `.brv/channel-history/<channelId>/turns/<turnId>.ndjson`. Each event is one
 * `JSON.stringify(event)\n` line written with `appendFile`, so a completed line
 * is durable and a reader never observes a torn write (no held stream — the
 * contract exposes no close hook).
 *
 * The orchestrator stamps the gap-free `seq`; this store defensively enforces
 * monotonicity (rejects `seq <= lastSeq`) as a persistence invariant. The
 * read-modify-write per turn (seed → check → append → bump) is serialized by a
 * per-turn-file lock so concurrent appends to one turn can't interleave.
 */
export class FileTranscriptStore implements ITranscriptStore {
  // Last persisted seq per resolved turn-file path; seeded from disk on first
  // touch so a fresh store instance still rejects a regressing seq.
  private readonly lastSeqByPath = new Map<string, number>()
  // One mutex per resolved turn-file path, guarding that turn's read-modify-write.
  private readonly locksByPath = new Map<string, AsyncMutex>()

  public async appendTurnEvent(args: AppendTurnEventArgs): Promise<void> {
    const {channelId, event, projectRoot, turnId} = args
    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    const key = resolve(file)

    await this.lockFor(key).withLock(async () => {
      const lastSeq = await this.lastSeqFor(key, file)
      if (event.seq <= lastSeq) {
        throw new Error(
          `non-monotonic transcript seq for ${channelId}/${turnId}: got ${event.seq}, last persisted ${lastSeq}`,
        )
      }

      await mkdir(dirname(file), {recursive: true})
      await appendFile(file, `${JSON.stringify(event)}\n`, 'utf8')
      this.lastSeqByPath.set(key, event.seq)
    })
  }

  public async readTurnEvents(args: ReadTurnEventsArgs): Promise<TurnEvent[]> {
    const {channelId, projectRoot, turnId} = args
    const events = await readEventsFromFile(channelPaths.turnNdjsonFile(projectRoot, channelId, turnId))
    return events.sort((a, b) => a.seq - b.seq)
  }

  private async lastSeqFor(key: string, file: string): Promise<number> {
    const cached = this.lastSeqByPath.get(key)
    if (cached !== undefined) return cached

    // First touch this process: seed from the max seq already on disk so a
    // restarted/re-instantiated store still rejects a regression. Using max (not
    // last) means a corrupt or out-of-order tail can't lower the watermark.
    const existing = await readEventsFromFile(file)
    const seeded = existing.length === 0 ? NO_EVENTS : Math.max(...existing.map((event) => event.seq))
    this.lastSeqByPath.set(key, seeded)
    return seeded
  }

  private lockFor(key: string): AsyncMutex {
    let mutex = this.locksByPath.get(key)
    if (mutex === undefined) {
      mutex = new AsyncMutex()
      this.locksByPath.set(key, mutex)
    }

    return mutex
  }
}
