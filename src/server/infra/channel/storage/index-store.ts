import {promises as fs} from 'node:fs'
import {dirname} from 'node:path'

import type {Turn, TurnDelivery} from '../../../../shared/types/channel.js'
import type {
  ChannelTurnIndexDeliverySummary,
  ChannelTurnIndexEntry,
} from '../../../core/interfaces/channel/i-channel-store.js'

import {channelPaths} from './paths.js'
import {ChannelWriteSerializer} from './write-serializer.js'

/**
 * Slice 9.3 — per-channel index of finished turns. The index is a
 * materialised view over the per-turn NDJSON files that the
 * `_recordType: 'turn_snapshot'` line produces at terminal state, plus
 * a per-delivery summary (handle, state, finalAnswer). It lets the hot
 * read paths skip every per-turn open:
 *
 *  - `brv channel list-turns` reads the index map directly — O(1) per
 *    channel instead of `readdir` + per-turn `readTurn`.
 *  - `lookback-builder` reads the last K entries' `turn.promptBlocks`
 *    for the lookback transcript — no events replay needed.
 *  - Slice 9.4 GC consults `turn.endedAt` to pick deletion candidates.
 *
 * Locked design decisions from the codex + kimi parallel review:
 *   Q3: flat JSONL on disk (no SQLite native dep). The in-memory map
 *       is loaded lazily on first read per channel, rebuilt from the
 *       file scan.
 *   Q4: full `finalAnswer` materialised in the per-delivery summary
 *       (kimi's call — replaces 20 file opens per dispatch with 1
 *       sequential read).
 *   Q5 (kimi 2PC defect): a crash between writing the terminal
 *       NDJSON line and appending to index.jsonl leaves the index
 *       stale. `recoverFromNdjson` rebuilds missing entries at
 *       daemon startup by scanning the per-channel turns/ directory
 *       for `_recordType: 'turn_snapshot'` lines and re-appending
 *       any that the index lacks.
 *
 * On-disk format:
 *   <projectRoot>/.brv/channel-history/<channelId>/index.jsonl
 *
 *   One line per `ChannelTurnIndexEntry`. Append-only. Last-writer-wins
 *   semantics on duplicate turnId — the in-memory map preserves the
 *   most recent entry, future GC compaction (Slice 9.4) rewrites the
 *   file dropping superseded entries.
 */



export type ChannelTurnIndexStoreOptions = {
  readonly serializer: ChannelWriteSerializer
}

export type AppendEntryArgs = {
  readonly channelId: string
  readonly entry: ChannelTurnIndexEntry
  readonly projectRoot: string
}

export type LoadIndexArgs = {
  readonly channelId: string
  readonly projectRoot: string
}

export type RecoverArgs = {
  readonly channelId: string
  readonly projectRoot: string
}

const indexLockKey = (channelId: string): string => `index:${channelId}`

const tryReadFile = async (path: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const parseEntryLine = (line: string): ChannelTurnIndexEntry | undefined => {
  if (line.trim() === '') return undefined
  try {
    return JSON.parse(line) as ChannelTurnIndexEntry
  } catch {
    return undefined
  }
}

const findLatestTurnSnapshotInNdjson = (raw: string): Turn | undefined => {
  let latest: Turn | undefined
  for (const physical of raw.split('\n')) {
    if (physical.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(physical)
    } catch {
      continue
    }

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      (parsed as {_recordType?: unknown})._recordType !== 'turn_snapshot'
    ) {
      continue
    }

    const turnField = (parsed as {turn?: Turn}).turn
    if (turnField !== undefined) latest = turnField
  }

  return latest
}

const collectDeliverySnapshotsFromNdjson = (raw: string): ChannelTurnIndexDeliverySummary[] => {
  const byDelivery = new Map<string, ChannelTurnIndexDeliverySummary>()
  const messageByDelivery = new Map<string, string>()

  for (const physical of raw.split('\n')) {
    if (physical.trim() === '') continue
    let parsed: {_recordType?: unknown; body?: unknown; delivery?: TurnDelivery; deliveryId?: unknown}
    try {
      parsed = JSON.parse(physical) as typeof parsed
    } catch {
      continue
    }

    if (parsed._recordType === 'delivery_snapshot' && parsed.delivery !== undefined) {
      const d = parsed.delivery
      byDelivery.set(d.deliveryId, {
        deliveryId: d.deliveryId,
        memberHandle: d.memberHandle,
        state: d.state,
      })
    } else if (
      parsed._recordType === 'message' &&
      typeof parsed.deliveryId === 'string' &&
      typeof parsed.body === 'string'
    ) {
      messageByDelivery.set(parsed.deliveryId, parsed.body)
    }
  }

  return [...byDelivery.values()].map((d) => {
    const finalAnswer = messageByDelivery.get(d.deliveryId)
    return finalAnswer === undefined ? d : {...d, finalAnswer}
  })
}

export class ChannelTurnIndexStore {
  private readonly inMemoryByChannel = new Map<string, Map<string, ChannelTurnIndexEntry>>()
  private readonly loadedChannels = new Set<string>()
  /**
   * Slice 9.7 (codex D5): per-daemon-lifetime guard against re-running the
   * `recoverFromNdjson` sweep on every read. The lazy hook in
   * `ChannelStore.listTurns` would otherwise pay an O(N) `readdir` of
   * the per-channel `turns/` dir on every call, undercutting Slice 9.3's
   * "index hot path" claim. Set holds `${channelId}:${projectRoot}`
   * once recovery has run; subsequent invocations short-circuit at O(1).
   * Lives for the daemon's lifetime (recovery is a startup/2PC-gap
   * concern; a still-running daemon's in-memory map is authoritative).
   */
  private readonly recoveredChannels = new Set<string>()
  private readonly serializer: ChannelWriteSerializer

  public constructor(options: ChannelTurnIndexStoreOptions) {
    this.serializer = options.serializer
  }

  async appendEntry(args: AppendEntryArgs): Promise<void> {
    const {channelId, entry, projectRoot} = args
    await this.serializer.withLock(indexLockKey(channelId), async () => {
      const file = channelPaths.indexJsonlFile(projectRoot, channelId)
      await fs.mkdir(dirname(file), {recursive: true})
      const physical = `${JSON.stringify(entry)}\n`
      await fs.appendFile(file, physical, {encoding: 'utf8', flag: 'a'})

      const map = await this.ensureChannelMap(projectRoot, channelId)
      map.set(entry.turn.turnId, entry)
    })
  }

  /**
   * Slice 9.4 — rewrite the per-channel index.jsonl dropping the supplied
   * `removedTurnIds`. Used by the GC sweep after it unlinks the per-turn
   * NDJSON files for retentioned turns. Writes via temp+rename so a crash
   * mid-compact leaves the original file intact. Updates the in-memory
   * map under the same per-channel lock to keep readers consistent.
   */
  async compactIndex(args: {
    readonly channelId: string
    readonly projectRoot: string
    readonly removedTurnIds: Iterable<string>
  }): Promise<void> {
    const {channelId, projectRoot, removedTurnIds} = args
    const removed = new Set(removedTurnIds)
    if (removed.size === 0) return

    await this.serializer.withLock(indexLockKey(channelId), async () => {
      const map = await this.ensureChannelMap(projectRoot, channelId)
      for (const id of removed) map.delete(id)

      const file = channelPaths.indexJsonlFile(projectRoot, channelId)
      await fs.mkdir(dirname(file), {recursive: true})
      const tmp = `${file}.tmp.${process.pid}.${Date.now()}`
      const physical =
        map.size === 0 ? '' : `${[...map.values()].map((e) => JSON.stringify(e)).join('\n')}\n`
      await fs.writeFile(tmp, physical, {encoding: 'utf8'})
      await fs.rename(tmp, file)
    })
  }

  async getEntries(args: LoadIndexArgs): Promise<Map<string, ChannelTurnIndexEntry>> {
    const {channelId, projectRoot} = args
    const map = await this.ensureChannelMap(projectRoot, channelId)
    return new Map(map)
  }

  /**
   * Slice 9.3 — rebuild index entries for any per-turn NDJSON whose
   * terminal `_recordType: 'turn_snapshot'` is on disk but absent from
   * the index. Returns the number of entries newly appended.
   *
   * Called at daemon startup for every known channel so a crash between
   * the NDJSON snapshot write and the index append converges to a
   * consistent index on next boot. Idempotent: re-running over an
   * already-consistent state is a no-op.
   */
  async recoverFromNdjson(args: RecoverArgs): Promise<number> {
    const {channelId, projectRoot} = args
    // Slice 9.7 (codex D5): per-daemon-lifetime gate. Once recovery has
    // run for this (channelId, projectRoot), subsequent invocations are
    // O(1) no-ops — the in-memory map is authoritative while the daemon
    // is alive; new turns flow through `appendEntry` not `recoverFromNdjson`.
    const recoveryKey = `${channelId}:${projectRoot}`
    if (this.recoveredChannels.has(recoveryKey)) return 0

    const turnsDir = channelPaths.historyTurnsDir(projectRoot, channelId)
    let entries: string[] = []
    try {
      entries = await fs.readdir(turnsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Mark recovered so future no-op calls don't readdir again.
        this.recoveredChannels.add(recoveryKey)
        return 0
      }

      throw error
    }

    // Make sure the in-memory map reflects the on-disk index before we
    // decide what to rebuild.
    const existing = await this.ensureChannelMap(projectRoot, channelId)

    let recovered = 0
    for (const fileName of entries) {
      if (!fileName.endsWith('.ndjson')) continue
      const turnId = fileName.slice(0, -'.ndjson'.length)
      if (existing.has(turnId)) continue

      const ndjsonPath = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
      // eslint-disable-next-line no-await-in-loop
      const raw = await tryReadFile(ndjsonPath)
      if (raw === undefined) continue

      const turn = findLatestTurnSnapshotInNdjson(raw)
      if (turn === undefined) continue

      const deliveries = collectDeliverySnapshotsFromNdjson(raw)
      // eslint-disable-next-line no-await-in-loop
      await this.appendEntry({channelId, entry: {deliveries, turn}, projectRoot})
      recovered++
    }

    this.recoveredChannels.add(recoveryKey)
    return recovered
  }

  private async ensureChannelMap(
    projectRoot: string,
    channelId: string,
  ): Promise<Map<string, ChannelTurnIndexEntry>> {
    const cacheKey = `${channelId}:${projectRoot}`
    let map = this.inMemoryByChannel.get(cacheKey)
    if (map === undefined) {
      map = new Map<string, ChannelTurnIndexEntry>()
      this.inMemoryByChannel.set(cacheKey, map)
    }

    if (this.loadedChannels.has(cacheKey)) return map

    const file = channelPaths.indexJsonlFile(projectRoot, channelId)
    const raw = await tryReadFile(file)
    if (raw !== undefined) {
      for (const line of raw.split('\n')) {
        const entry = parseEntryLine(line)
        if (entry === undefined) continue
        map.set(entry.turn.turnId, entry)
      }
    }

    this.loadedChannels.add(cacheKey)
    return map
  }
}

export {type ChannelTurnIndexDeliverySummary, type ChannelTurnIndexEntry} from '../../../core/interfaces/channel/i-channel-store.js'