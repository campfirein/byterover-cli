import {createWriteStream, promises as fs, type WriteStream} from 'node:fs'
import {dirname} from 'node:path'

import type {TurnEvent} from '../../../../shared/types/channel.js'

import {channelPaths} from './paths.js'
import {ChannelWriteSerializer} from './write-serializer.js'

/**
 * Append-only writer for the per-turn NDJSON transcript file
 * (CHANNEL_PROTOCOL.md §4.2; Phase 9 layout). Invariants:
 *
 *  - Writes go to `<projectRoot>/.brv/channel-history/<channelId>/turns/<turnId>.ndjson`
 *    (Slice 9.1). The legacy `.brv/context-tree/channel/.../events.jsonl`
 *    location is read-only fallback served by the tree-reader.
 *
 *  - Each call appends exactly one event encoded as a single-line JSON object
 *    followed by `\n`. Embedded newlines in payload strings are escaped by
 *    `JSON.stringify`, so each physical line is a complete event. Wire
 *    events carry no `_recordType` envelope; the snapshot-writer is the
 *    sole producer of structural lines on the same file (Slice 9.1) and
 *    routes through {@link ChannelEventsWriter.appendRawLine} so both
 *    writers share the same held stream + per-turn lock (Slice 9.2).
 *
 *  - `event.seq` MUST be monotonically increasing per `(channelId, turnId)`.
 *    The writer tracks the last seq per turn in-process and rejects
 *    regressions; on cold start the orchestrator MUST seed the writer from
 *    the on-disk file (or fall back to scanning).
 *
 *  - Concurrent appends to the same `(channelId, turnId)` are serialised by
 *    the shared {@link ChannelWriteSerializer}. Appends to different turns
 *    may proceed in parallel.
 *
 *  - Slice 9.2 — per-turn `fs.createWriteStream` is held open across all
 *    appends to the same turn and closed by the orchestrator at terminal
 *    state via {@link ChannelEventsWriter.closeStreamForTurn}. Eliminates
 *    the per-event open/close syscalls that made streaming-token writes
 *    the hot path under multi-agent fan-out. Graceful shutdown calls
 *    {@link ChannelEventsWriter.closeAll}.
 *
 *  - The NDJSON file's parent directory is created lazily; callers do not
 *    need to mkdir.
 */

export type ChannelEventsWriterOptions = {
  readonly serializer: ChannelWriteSerializer
}

export type AppendArgs = {
  readonly channelId: string
  readonly event: TurnEvent
  readonly projectRoot: string
  readonly turnId: string
}

export type AppendRawLineArgs = {
  readonly channelId: string
  readonly line: string
  readonly projectRoot: string
  readonly turnId: string
}

export type CloseStreamArgs = {
  readonly channelId: string
  readonly turnId: string
}

const streamKey = (channelId: string, turnId: string): string => `${channelId}:${turnId}`

const writeLine = (stream: WriteStream, physical: string): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    stream.write(physical, (error) => {
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
  })

const endStream = (stream: WriteStream): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    stream.once('finish', () => resolve())
    stream.once('error', (error) => reject(error))
    stream.end()
  })

export class ChannelEventsWriter {
  private readonly lastSeqByTurn = new Map<string, number>()
  private readonly openStreams = new Map<string, WriteStream>()
  private readonly serializer: ChannelWriteSerializer

  public constructor(options: ChannelEventsWriterOptions) {
    this.serializer = options.serializer
  }

  /**
   * Append one event to the per-turn NDJSON. Returns when the data has been
   * accepted by the held write stream. Rejects with an Error if `event.seq`
   * is not strictly greater than the last observed seq for this turn.
   */
  async append(args: AppendArgs): Promise<void> {
    const {channelId, event, projectRoot, turnId} = args
    const key = streamKey(channelId, turnId)

    await this.serializer.withLock(`${channelId}:${turnId}`, async () => {
      const lastSeq = this.lastSeqByTurn.get(key)
      if (lastSeq !== undefined && event.seq <= lastSeq) {
        throw new Error(
          `Non-monotonic seq for ${channelId}/${turnId}: got ${event.seq}, last persisted ${lastSeq}`,
        )
      }

      const stream = await this.ensureStream({channelId, projectRoot, turnId})
      const physical = `${JSON.stringify(event)}\n`
      await writeLine(stream, physical)

      this.lastSeqByTurn.set(key, event.seq)
    })
  }

  /**
   * Slice 9.2 — append a pre-serialised JSON line to the per-turn NDJSON
   * without consulting the seq cursor. Used by the snapshot writer to
   * emit `_recordType`-tagged structural lines through the same held
   * stream + per-turn lock as wire events, so terminal snapshots cannot
   * tear concurrent in-flight event appends.
   */
  async appendRawLine(args: AppendRawLineArgs): Promise<void> {
    const {channelId, line, projectRoot, turnId} = args

    await this.serializer.withLock(`${channelId}:${turnId}`, async () => {
      const stream = await this.ensureStream({channelId, projectRoot, turnId})
      const physical = line.endsWith('\n') ? line : `${line}\n`
      await writeLine(stream, physical)
    })
  }

  /**
   * Slice 9.2 — drain and close every open per-turn stream. Daemon shutdown
   * hook should `await` this so buffered transcript bytes flush before the
   * process exits.
   */
  async closeAll(): Promise<void> {
    const entries = [...this.openStreams.entries()]
    this.openStreams.clear()
    await Promise.all(entries.map(([, stream]) => endStream(stream)))
  }

  /**
   * Slice 9.2 — drain and close the held stream for a single turn. Call
   * this at terminal state (after the final snapshot lines have been
   * written) to release the file descriptor. Idempotent: a no-op if no
   * stream is open for the turn.
   */
  async closeStreamForTurn(args: CloseStreamArgs): Promise<void> {
    const {channelId, turnId} = args
    const key = streamKey(channelId, turnId)
    await this.serializer.withLock(`${channelId}:${turnId}`, async () => {
      const stream = this.openStreams.get(key)
      if (stream === undefined) return
      this.openStreams.delete(key)
      await endStream(stream)
    })
  }

  /** Slice 9.2 — number of held-open per-turn streams (test introspection). */
  openStreamCount(): number {
    return this.openStreams.size
  }

  /**
   * Tells the writer the highest seq currently on disk for a given turn.
   * The orchestrator's cold-start recovery calls this so non-monotonic
   * rejection works correctly after a restart.
   */
  public seedLastSeq(channelId: string, turnId: string, lastSeq: number): void {
    this.lastSeqByTurn.set(streamKey(channelId, turnId), lastSeq)
  }

  private async ensureStream(args: {
    readonly channelId: string
    readonly projectRoot: string
    readonly turnId: string
  }): Promise<WriteStream> {
    const {channelId, projectRoot, turnId} = args
    const key = streamKey(channelId, turnId)
    const existing = this.openStreams.get(key)
    if (existing !== undefined) return existing

    const file = channelPaths.turnNdjsonFile(projectRoot, channelId, turnId)
    await fs.mkdir(dirname(file), {recursive: true})
    const stream = createWriteStream(file, {encoding: 'utf8', flags: 'a'})
    this.openStreams.set(key, stream)
    return stream
  }
}
