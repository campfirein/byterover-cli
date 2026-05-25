import {promises as fs} from 'node:fs'
import {join} from 'node:path'

import {ChannelTurnIndexStore} from './index-store.js'
import {channelPaths} from './paths.js'
import {ChannelWriteSerializer} from './write-serializer.js'

/**
 * Slice 9.4 + 9.5 — periodic GC sweep over both per-channel transcript
 * mounts (new + legacy).
 *
 * New mount (.brv/channel-history/<ch>/turns/<turnId>.ndjson): removes
 * NDJSON files whose materialised index entry shows the turn reached
 * terminal state more than `retentionDays` ago, then compacts the
 * per-channel index.jsonl.
 *
 * Legacy mount (.brv/context-tree/channel/<ch>/turns/<turnId>/): scans
 * each subdir for `turn.json` and parses `endedAt`; recursively removes
 * the subdir when older than retention. Subdirs without a `turn.json`
 * are conservatively kept (treated as in-flight — pre-Phase-9 turns
 * only wrote `turn.json` at terminal state). This is the mechanism that
 * lets the `isChannelTurnArtifact` cogit exclusion eventually retire
 * once legacy subdirs naturally vacate.
 *
 * Locked design decisions from the codex + kimi parallel review:
 *   Q5 — 30-day default, configurable via env var. `retentionDays = 0`
 *        disables the sweep entirely (no destructive delete-now mode
 *        in this slice; that's an explicit `brv channel history prune`
 *        follow-up).
 *   Q8 (kimi) — GC MUST exclude active turns. The predicate requires
 *        `turn.endedAt != null && endedAt < now - retention`. An
 *        in-flight turn (no endedAt) is never reaped, regardless of
 *        how long it has been alive — Slice 9.2's held-open write
 *        streams can keep a single turn alive for hours, so the
 *        wall-clock-only predicate from typical TTL stores would
 *        corrupt streaming agent runs.
 *   Q8 (codex) — GC coordinates with active readers/writers via the
 *        per-turn write-lock. Acquiring the lock before unlink gives
 *        any in-flight `appendRawLine` (snapshot writes) or
 *        `closeStreamForTurn` calls a chance to complete first.
 *   2PC-gap (kimi) — index compaction is via temp+rename, atomic at
 *        the filesystem layer; a crash mid-rewrite leaves the original
 *        index intact.
 */

export type ChannelTranscriptGcOptions = {
  readonly clock?: () => Date
  readonly indexStore: ChannelTurnIndexStore
  readonly retentionDays: number
  readonly serializer: ChannelWriteSerializer
}

export type SweepChannelArgs = {
  readonly channelId: string
  readonly projectRoot: string
}

export type SweepChannelResult = {
  readonly deletedLegacyMount: number
  readonly deletedNewMount: number
  readonly remaining: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

const tryUnlink = async (path: string): Promise<boolean> => {
  try {
    await fs.unlink(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const tryReadJson = async (path: string): Promise<unknown> => {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

const tryListDir = async (path: string): Promise<string[]> => {
  try {
    return await fs.readdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export class ChannelTranscriptGc {
  private readonly clock: () => Date
  private readonly indexStore: ChannelTurnIndexStore
  private readonly retentionDays: number
  private readonly serializer: ChannelWriteSerializer

  public constructor(options: ChannelTranscriptGcOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.indexStore = options.indexStore
    this.retentionDays = options.retentionDays
    this.serializer = options.serializer
  }

  async sweepChannel(args: SweepChannelArgs): Promise<SweepChannelResult> {
    if (this.retentionDays <= 0) {
      // Sweep disabled — return current index size so callers can still
      // log the no-op cycle with useful counts.
      const entries = await this.indexStore.getEntries(args)
      return {deletedLegacyMount: 0, deletedNewMount: 0, remaining: entries.size}
    }

    const now = this.clock()
    const cutoff = now.getTime() - this.retentionDays * MS_PER_DAY
    const entries = await this.indexStore.getEntries(args)

    const toDelete: string[] = []
    for (const [turnId, entry] of entries) {
      const {endedAt} = entry.turn
      if (endedAt === undefined) continue
      const endedMs = Date.parse(endedAt)
      if (Number.isNaN(endedMs)) continue
      // Inclusive boundary: a turn that ended exactly `retentionDays`
      // ago is NOT swept; only entries strictly older.
      if (endedMs >= cutoff) continue
      toDelete.push(turnId)
    }

    let deletedNewMount = 0
    for (const turnId of toDelete) {
      // Serialize with any in-flight writer or replay reader on the
      // same turn. The lock is released the moment the unlink syscall
      // returns, so this is at most a brief wait per turn.
      // eslint-disable-next-line no-await-in-loop
      await this.serializer.withLock(`${args.channelId}:${turnId}`, async () => {
        const file = channelPaths.turnNdjsonFile(args.projectRoot, args.channelId, turnId)
        await tryUnlink(file)
        deletedNewMount++
      })
    }

    if (toDelete.length > 0) {
      await this.indexStore.compactIndex({
        channelId: args.channelId,
        projectRoot: args.projectRoot,
        removedTurnIds: toDelete,
      })
    }

    const deletedLegacyMount = await this.sweepLegacyMount({...args, cutoff})

    const remaining = entries.size - deletedNewMount
    return {deletedLegacyMount, deletedNewMount, remaining}
  }

  /**
   * Slice 9.5 — sweep pre-Phase-9 `<channelDir>/turns/<turnId>/` subdirs.
   * Reads `turn.json` to determine `endedAt`; conservatively keeps any
   * subdir lacking a snapshot (treated as in-flight). Removes the entire
   * subdir recursively when eligible, under the per-turn write-lock.
   *
   * Slice 9.6 (codex D4): the per-turn lock is held by GC but NOT by
   * `ChannelTreeReader.readTurn` or `ChannelStore.listTurns` — readers
   * are intentionally lock-free for throughput. Consequence: in the
   * narrow window where GC has unlinked an old (>retentionDays) legacy
   * subdir but a concurrent `brv channel show <oldTurnId>` is mid-read,
   * the reader observes `undefined` (i.e. the same shape it returns for
   * a turnId that never existed). This is intentional: anyone reading a
   * 30+ day old turn is reading historical data, and the race surface
   * is identical to a user manually deleting the directory between
   * `listTurns` and `show`. Callers already handle the `undefined`
   * shape. If a future consumer needs lock-consistency, take the
   * serializer in the read path too — accept the throughput hit.
   */
  private async sweepLegacyMount(
    args: SweepChannelArgs & {readonly cutoff: number},
  ): Promise<number> {
    const {channelId, cutoff, projectRoot} = args
    const turnsRoot = join(channelPaths.channelDir(projectRoot, channelId), 'turns')
    const entries = await tryListDir(turnsRoot)

    let deleted = 0
    for (const turnId of entries) {
      const snapshotFile = channelPaths.turnSnapshotFile(projectRoot, channelId, turnId)
      // eslint-disable-next-line no-await-in-loop
      const parsed = await tryReadJson(snapshotFile)
      // No snapshot → conservative: keep (pre-Phase-9 turns only wrote
      // turn.json at terminal state, so absence implies in-flight).
      if (typeof parsed !== 'object' || parsed === null) continue
      const {endedAt} = (parsed as {endedAt?: unknown})
      if (typeof endedAt !== 'string') continue
      const endedMs = Date.parse(endedAt)
      if (Number.isNaN(endedMs)) continue
      if (endedMs >= cutoff) continue

      const subdir = channelPaths.turnDir(projectRoot, channelId, turnId)
      // eslint-disable-next-line no-await-in-loop
      await this.serializer.withLock(`${channelId}:${turnId}`, async () => {
        await fs.rm(subdir, {force: true, recursive: true})
      })
      deleted++
    }

    return deleted
  }
}
