import {promises as fs} from 'node:fs'
import {dirname, join} from 'node:path'

import type {Channel, ChannelMeta, TurnDelivery} from '../../../shared/types/channel.js'
import type {
  ChannelStoreAppendEventArgs,
  ChannelStoreCloseTranscriptArgs,
  ChannelStoreCreateArgs,
  ChannelStoreListArgs,
  ChannelStoreListTurnsArgs,
  ChannelStoreListTurnsResult,
  ChannelStoreReadArgs,
  ChannelStoreReadDeliveriesArgs,
  ChannelStoreReadTurnArgs,
  ChannelStoreReadTurnResult,
  ChannelStoreSnapshotArgs,
  ChannelStoreUpdateMetaArgs,
  ChannelStoreWriteDeliveryArgs,
  ChannelStoreWriteMessageArgs,
  IChannelStore,
} from '../../core/interfaces/channel/i-channel-store.js'

import {ChannelMetaSchema, TurnDeliverySchema} from '../../../shared/types/channel.js'
import {ChannelEventsWriter} from './storage/events-writer.js'
import {
  type ChannelTurnIndexEntry,
  ChannelTurnIndexStore,
} from './storage/index-store.js'
import {channelPaths} from './storage/paths.js'
import {ChannelSnapshotWriter} from './storage/snapshot-writer.js'
import {ChannelTranscriptGc} from './storage/transcript-gc.js'
import {ChannelTreeReader} from './storage/tree-reader.js'
import {ChannelWriteSerializer} from './storage/write-serializer.js'

/**
 * Phase-1 concrete IChannelStore.
 *
 * Composes the storage primitives from Slice 1.3 (events writer, snapshot
 * writer, tree reader, per-key write lock) and adds two things on top:
 *
 *  - meta.json read/write (atomic-rename writes serialised per channel via
 *    the shared {@link ChannelWriteSerializer} so concurrent updates from
 *    different turns don't tear the file).
 *  - List operations (listChannels scans channelsRoot/; listTurns scans
 *    `turns/<turnId>/turn.json`).
 *
 * The store knows the on-disk shape; the orchestrator (Slice 1.4 sibling)
 * owns state-machine policy, broadcasts, and id generation.
 */
export type ChannelStoreDeps = {
  readonly eventsWriter: ChannelEventsWriter
  /**
   * Slice 9.3 — per-channel materialised view that powers fast list-turns
   * and lookback. Optional during the read-from-both migration window;
   * when omitted, list-turns falls back to the per-turn NDJSON scan.
   */
  readonly indexStore?: ChannelTurnIndexStore
  /**
   * Phase 9.5.9 §2.4 — optional logger for `listChannels` skip-not-fail.
   * When supplied, malformed metas are logged and skipped rather than
   * causing the whole list to fail. Defaults to a silent no-op.
   */
  readonly log?: (msg: string) => void
  readonly snapshotWriter: ChannelSnapshotWriter
  /**
   * Slice 9.4 — periodic transcript GC. Optional; when omitted,
   * `sweepTranscripts` is a no-op (tests that don't care about
   * retention skip it; production daemon wires it from
   * `BRV_CHANNEL_TRANSCRIPT_RETENTION_DAYS`).
   */
  readonly transcriptGc?: ChannelTranscriptGc
  readonly treeReader: ChannelTreeReader
  readonly writeSerializer: ChannelWriteSerializer
}

const metaLockKey = (channelId: string): string => `meta:${channelId}`

const writeAtomically = async (target: string, contents: string): Promise<void> => {
  await fs.mkdir(dirname(target), {recursive: true})
  const tmp = `${target}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmp, contents, {encoding: 'utf8'})
  await fs.rename(tmp, target)
}

const toChannelProjection = (meta: ChannelMeta): Channel => ({
  archivedAt: meta.archivedAt,
  channelId: meta.channelId,
  createdAt: meta.createdAt,
  memberCount: meta.members.length,
  members: meta.members.map((m) => ({
    capabilities: m.memberKind === 'acp-agent' ? m.capabilities : undefined,
    displayName:
      m.memberKind === 'human-messaging' ? m.displayName : m.memberKind === 'acp-agent' ? m.agentName : undefined,
    handle: m.handle,
    memberKind: m.memberKind,
    status: m.status,
  })),
  settings: meta.settings,
  title: meta.title,
  updatedAt: meta.updatedAt,
})

const tryReadMeta = async (path: string): Promise<ChannelMeta | undefined> => {
  try {
    const raw = await fs.readFile(path, 'utf8')
    return ChannelMetaSchema.parse(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class ChannelStore implements IChannelStore {
  private readonly eventsWriter: ChannelEventsWriter
  private readonly indexStore?: ChannelTurnIndexStore
  private readonly log: (msg: string) => void
  private readonly snapshotWriter: ChannelSnapshotWriter
  private readonly transcriptGc?: ChannelTranscriptGc
  private readonly treeReader: ChannelTreeReader
  private readonly writeSerializer: ChannelWriteSerializer

  public constructor(deps: ChannelStoreDeps) {
    this.eventsWriter = deps.eventsWriter
    this.indexStore = deps.indexStore
    this.log = deps.log ?? (() => { /* no-op */ })
    this.snapshotWriter = deps.snapshotWriter
    this.transcriptGc = deps.transcriptGc
    this.treeReader = deps.treeReader
    this.writeSerializer = deps.writeSerializer
  }

  async appendTurnEvent(args: ChannelStoreAppendEventArgs): Promise<void> {
    await this.eventsWriter.append({
      channelId: args.channelId,
      event: args.event,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })
  }

  /**
   * Slice 9.3 — append a terminal-state entry to the per-channel
   * index.jsonl. No-op when the index store has not been wired (read-from-
   * both migration window).
   */
  async appendTurnIndexEntry(args: {
    readonly channelId: string
    readonly entry: ChannelTurnIndexEntry
    readonly projectRoot: string
  }): Promise<void> {
    if (this.indexStore === undefined) return
    await this.indexStore.appendEntry(args)
  }

  async closeTranscriptStream(args: ChannelStoreCloseTranscriptArgs): Promise<void> {
    await this.eventsWriter.closeStreamForTurn({
      channelId: args.channelId,
      turnId: args.turnId,
    })
  }

  async createChannel(args: ChannelStoreCreateArgs): Promise<Channel> {
    const {meta, projectRoot} = args
    return this.writeSerializer.withLock(metaLockKey(meta.channelId), async () => {
      const target = channelPaths.metaFile(projectRoot, meta.channelId)
      const existing = await tryReadMeta(target)
      if (existing !== undefined) {
        throw new Error(`Channel ${meta.channelId} already exists`)
      }

      await writeAtomically(target, JSON.stringify(meta, undefined, 2))
      return toChannelProjection(meta)
    })
  }

  async listChannels(args: ChannelStoreListArgs): Promise<Channel[]> {
    const root = channelPaths.channelsRoot(args.projectRoot)
    let entries: string[]
    try {
      entries = await fs.readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    // Phase 9.5.9 §2.4 — skip-not-fail: use Promise.allSettled so a single
    // malformed or schema-invalid meta.json does not cause the entire list
    // to fail. Rejected entries are logged and skipped; valid channels are
    // returned. Mirrors the runProjectWarm pattern in orchestrator.ts.
    const results = await Promise.allSettled(
      entries.map((id) => tryReadMeta(channelPaths.metaFile(args.projectRoot, id))),
    )
    const channels: Channel[] = []
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        this.log(
          `[channel-store] listChannels skipping malformed meta ${entries[i]}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        )
        continue
      }

      const meta = result.value
      if (meta === undefined) continue
      if (!args.includeArchived && meta.archivedAt !== undefined) continue
      channels.push(toChannelProjection(meta))
    }

    return channels.sort((a, b) => a.channelId.localeCompare(b.channelId))
  }

  async listTurns(args: ChannelStoreListTurnsArgs): Promise<ChannelStoreListTurnsResult> {
    // Slice 9.1 — union the new mount (.brv/channel-history/<ch>/turns/*.ndjson)
    // with the legacy mount (.brv/context-tree/channel/<ch>/turns/<turnId>/)
    // so existing pre-Phase-9 turns remain discoverable during the
    // migration window.
    // Slice 9.3 — for terminal turns already in the index, the entry's
    // materialised `turn` field is the projection (O(1) per turn, no
    // per-turn NDJSON open). Index miss → fall back to per-turn
    // `readTurn` (covers in-flight / recovery-pending turns + legacy).
    const turnIds = await this.enumerateTurnIds(args.projectRoot, args.channelId)
    // Slice 9.3 — lazy 2PC-gap recovery (kimi defect): rebuild any
    // index entries whose NDJSON is on disk but never made it into
    // index.jsonl before a crash. Idempotent + cheap when the index is
    // already complete.
    const indexMap =
      this.indexStore === undefined
        ? new Map<string, ChannelTurnIndexEntry>()
        : await (async () => {
            await this.indexStore!.recoverFromNdjson({
              channelId: args.channelId,
              projectRoot: args.projectRoot,
            })
            return this.indexStore!.getEntries({
              channelId: args.channelId,
              projectRoot: args.projectRoot,
            })
          })()

    const records = (
      await Promise.all(
        [...turnIds].map(async (turnId) => {
          const cached = indexMap.get(turnId)
          if (cached !== undefined) return cached.turn
          return this.treeReader.readTurn({
            channelId: args.channelId,
            projectRoot: args.projectRoot,
            turnId,
          })
        }),
      )
    ).filter((r): r is NonNullable<typeof r> => r !== undefined)

    // Phase 1: order by startedAt descending (most recent first). Phase 2's
    // cursor pagination will switch to a stable seq-based cursor.
    records.sort((a, b) => b.startedAt.localeCompare(a.startedAt))

    const limit = args.limit ?? records.length
    const limited = records.slice(0, limit)

    return {turns: limited}
  }

  async readChannel(args: ChannelStoreReadArgs): Promise<Channel | undefined> {
    const target = channelPaths.metaFile(args.projectRoot, args.channelId)
    const meta = await tryReadMeta(target)
    return meta === undefined ? undefined : toChannelProjection(meta)
  }

  async readChannelMeta(args: ChannelStoreReadArgs): Promise<ChannelMeta | undefined> {
    const target = channelPaths.metaFile(args.projectRoot, args.channelId)
    return tryReadMeta(target)
  }

  async readDeliveries(args: ChannelStoreReadDeliveriesArgs): Promise<TurnDelivery[]> {
    // Slice 9.1 — three-tier read:
    //   1) new mount NDJSON structural lines (`_recordType: 'delivery_snapshot'`)
    //   2) legacy `deliveries/<id>.json` files for pre-Phase-9 turns
    //   3) event-replay as a last resort
    const newSnapshots = await this.treeReader.readDeliverySnapshotsFromNdjson({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })
    if (newSnapshots.length > 0) return newSnapshots

    const deliveriesDir = join(
      channelPaths.turnDir(args.projectRoot, args.channelId, args.turnId),
      'deliveries',
    )

    let entries: string[] = []
    try {
      entries = await fs.readdir(deliveriesDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const snapshots: TurnDelivery[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        // eslint-disable-next-line no-await-in-loop
        const raw = await fs.readFile(join(deliveriesDir, entry), 'utf8')
        snapshots.push(TurnDeliverySchema.parse(JSON.parse(raw)))
      } catch {
        // Skip corrupt snapshots; replay will fill the gap.
      }
    }

    if (snapshots.length > 0) return snapshots

    // No snapshot files in either mount → replay from events.
    return this.treeReader.replayDeliveries({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })
  }

  async readTurn(args: ChannelStoreReadTurnArgs): Promise<ChannelStoreReadTurnResult | undefined> {
    const turn = await this.treeReader.readTurn({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })
    if (turn === undefined) return undefined

    const events = await this.treeReader.readEvents({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })

    // Phase-2 active turns include delivery records; passive Phase-1 turns
    // have none. Omit the field entirely when empty to preserve the
    // Phase-1 wire shape.
    const deliveries = await this.readDeliveries({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })

    return deliveries.length === 0 ? {events, turn} : {deliveries, events, turn}
  }

  /**
   * Slice 9.4 — fire a best-effort GC sweep for the channel. No-op when
   * the transcript GC has not been wired or `retentionDays` is 0.
   */
  async sweepTranscripts(args: {
    readonly channelId: string
    readonly projectRoot: string
  }): Promise<void> {
    if (this.transcriptGc === undefined) return
    await this.transcriptGc.sweepChannel(args)
  }

  async updateChannelMeta(args: ChannelStoreUpdateMetaArgs): Promise<Channel> {
    const {channelId, mutate, projectRoot} = args
    return this.writeSerializer.withLock(metaLockKey(channelId), async () => {
      const target = channelPaths.metaFile(projectRoot, channelId)
      const existing = await tryReadMeta(target)
      if (existing === undefined) {
        throw new Error(`Channel ${channelId} not found`)
      }

      const next = ChannelMetaSchema.parse(mutate(existing))
      await writeAtomically(target, JSON.stringify(next, undefined, 2))
      return toChannelProjection(next)
    })
  }

  async writeDeliverySnapshot(args: ChannelStoreWriteDeliveryArgs): Promise<void> {
    await this.snapshotWriter.writeDeliverySnapshot({
      channelId: args.channelId,
      delivery: args.delivery,
      deliveryId: args.deliveryId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })
  }

  async writeMessage(args: ChannelStoreWriteMessageArgs): Promise<void> {
    await this.snapshotWriter.writeMessage({
      body: args.body,
      channelId: args.channelId,
      deliveryId: args.deliveryId,
      projectRoot: args.projectRoot,
      turnId: args.turnId,
    })
  }

  async writeTurnSnapshot(args: ChannelStoreSnapshotArgs): Promise<void> {
    await this.snapshotWriter.writeTurnSnapshot({
      channelId: args.channelId,
      projectRoot: args.projectRoot,
      turn: args.turn,
      turnId: args.turnId,
    })
  }

  /**
   * Slice 9.1 — union the turn-id sets from both storage mounts so a
   * channel that contains a mix of pre-Phase-9 and post-Phase-9 turns
   * still surfaces all of them through `listTurns`. The new mount stores
   * one `.ndjson` file per turn; the legacy mount stores one directory
   * per turn. Returns a deduped Set keyed by turnId.
   */
  private async enumerateTurnIds(projectRoot: string, channelId: string): Promise<Set<string>> {
    const turnIds = new Set<string>()

    // New mount (.brv/channel-history/<ch>/turns/*.ndjson)
    const newRoot = channelPaths.historyTurnsDir(projectRoot, channelId)
    try {
      const entries = await fs.readdir(newRoot)
      for (const entry of entries) {
        if (!entry.endsWith('.ndjson')) continue
        turnIds.add(entry.slice(0, -'.ndjson'.length))
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    // Legacy mount (.brv/context-tree/channel/<ch>/turns/<turnId>/)
    const legacyRoot = join(channelPaths.channelDir(projectRoot, channelId), 'turns')
    try {
      const entries = await fs.readdir(legacyRoot)
      for (const entry of entries) turnIds.add(entry)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    return turnIds
  }
}
