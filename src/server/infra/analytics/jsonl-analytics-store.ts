import {randomUUID} from 'node:crypto'
import {mkdir, open, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

import type {StoredAnalyticsRecord} from '../../../shared/analytics/stored-record.js'
import type {
  IJsonlAnalyticsStore,
  JsonlAnalyticsStoreListOptions,
  JsonlAnalyticsStoreListResult,
  JsonlAnalyticsStoreUpdateStatus,
} from '../../core/interfaces/analytics/i-jsonl-analytics-store.js'

import {MAX_ATTEMPTS, StoredAnalyticsRecordSchema} from '../../../shared/analytics/stored-record.js'

const DEFAULT_FILE_NAME = 'analytics-queue.jsonl'
const DEFAULT_MAX_ROWS = 5000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024

/**
 * Thrown by `append` when the file-size cap cannot accommodate the new
 * record even after dropping every available `'sent'` row. The store has
 * already persisted any partial compaction and incremented
 * `droppedFullCount()`; the throw signals to the caller that THIS specific
 * record did NOT land on disk so it can skip mirror writes (e.g. queue
 * push) and keep the JSONL=truth invariant intact.
 *
 * Callers that don't care still MUST catch — analytics MUST NOT crash the
 * consumer.
 */
export class JsonlCapFullError extends Error {
  public readonly recordId: string

  public constructor(recordId: string) {
    super(`JSONL cap full: record ${recordId} dropped (no sent rows left to evict)`)
    this.name = 'JsonlCapFullError'
    this.recordId = recordId
  }
}

/**
 * Constructor options. `baseDir` is required (caller injects
 * `getGlobalDataDir()` in production; tests pass a `tmpdir()`-derived
 * path). The other fields default to plan-locked values.
 */
export type JsonlAnalyticsStoreOptions = {
  baseDir: string
  fileName?: string
  maxBytes?: number
  maxRows?: number
}

/**
 * File-backed JSONL store implementation. See `IJsonlAnalyticsStore` for
 * the consumer contract.
 *
 * Design notes:
 * - Atomic rewrite for `updateStatus` and compaction: write to
 *   `${path}.${randomUUID()}.tmp` then `rename`. Mirrors
 *   `FileQueryLogStore.writeAtomic`.
 * - All mutating calls (`append`, `updateStatus`) flow through a single
 *   `writeChain` Promise. This eliminates the `appendFile` vs
 *   `readFile/rename` race where a `track()`-time append could land
 *   between `updateStatus`'s read snapshot and rename and be silently
 *   overwritten.
 * - Read methods (`list`, `loadPending`) do NOT enter the write chain —
 *   reads do not corrupt and a caller that needs strict consistency
 *   should sequence its own reads after its writes.
 * - Retry-cap policy lives inside `updateStatus(_, 'failed')` (NOT in
 *   the caller). Plan-locked: increment attempts; row stays
 *   `'pending'` while `attempts < MAX_ATTEMPTS`; flips to terminal
 *   `'failed'` at the cap; no-op on rows already terminal.
 */
export class JsonlAnalyticsStore implements IJsonlAnalyticsStore {
  private droppedFullCounter = 0
  private droppedSentCounter = 0
  private readonly filePath: string
  private readonly maxBytes: number
  private readonly maxRows: number
  private writeChain: Promise<void> = Promise.resolve()

  public constructor(opts: JsonlAnalyticsStoreOptions) {
    this.filePath = join(opts.baseDir, opts.fileName ?? DEFAULT_FILE_NAME)
    this.maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  }

  public async append(record: StoredAnalyticsRecord): Promise<void> {
    return this.enqueue(async () => this.doAppend(record))
  }

  public async clear(): Promise<void> {
    return this.enqueue(async () => this.atomicRewrite([]))
  }

  public droppedFullCount(): number {
    return this.droppedFullCounter
  }

  public droppedSentCount(): number {
    return this.droppedSentCounter
  }

  public async list(opts: JsonlAnalyticsStoreListOptions): Promise<JsonlAnalyticsStoreListResult> {
    const all = await this.readAllRecords()
    const filtered = all.filter((row) => {
      if (opts.eventName !== undefined && row.name !== opts.eventName) return false
      if (opts.status !== undefined && row.status !== opts.status) return false
      return true
    })
    // Sort by (timestamp DESC, id DESC). Same-timestamp tie broken by id DESC for stable ordering.
    filtered.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp
      if (a.id < b.id) return 1
      if (a.id > b.id) return -1
      return 0
    })
    const rows = filtered.slice(opts.offset, opts.offset + opts.limit)
    return {rows, total: filtered.length}
  }

  public async loadPending(): Promise<StoredAnalyticsRecord[]> {
    const all = await this.readAllRecords()
    return all.filter((r) => r.status === 'pending')
  }

  public async updateStatus(ids: readonly string[], status: JsonlAnalyticsStoreUpdateStatus): Promise<void> {
    if (ids.length === 0) return
    const idSet = new Set(ids)
    return this.enqueue(async () => this.doUpdateStatus(idSet, status))
  }

  /**
   * Atomic file rewrite via `tmp + rename`. Mirrors `FileQueryLogStore`.
   * On failure, removes the tmp file and re-throws.
   */
  private async atomicRewrite(rows: readonly StoredAnalyticsRecord[]): Promise<void> {
    await this.ensureDir()
    const content = rows.length === 0 ? '' : rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, content, 'utf8')
      await rename(tmpPath, this.filePath)
    } catch (error) {
      await rm(tmpPath, {force: true}).catch(() => {})
      throw error
    }
  }

  /**
   * Drop oldest `'sent'` rows (insertion order = file order = oldest-first)
   * until under cap or out of `'sent'` rows. Pending and failed are never
   * dropped. Returns the kept rows + count of sent rows actually removed.
   *
   * Single-pass: precompute each row's serialized size once, then walk
   * once decrementing running totals on each drop. The earlier
   * `while exceedsCap` + `findIndex` + `splice` loop was O(n²) — each
   * iteration re-stringified every row and reshuffled the array.
   */
  private compactRows(rows: readonly StoredAnalyticsRecord[]): {kept: StoredAnalyticsRecord[]; sentDropped: number} {
    const sizes: number[] = []
    let bytes = 0
    for (const r of rows) {
      const size = Buffer.byteLength(JSON.stringify(r) + '\n', 'utf8')
      sizes.push(size)
      bytes += size
    }

    let count = rows.length
    const isOver = (): boolean => bytes > this.maxBytes || count > this.maxRows

    const kept: StoredAnalyticsRecord[] = []
    let sentDropped = 0
    for (const [i, r] of rows.entries()) {
      if (isOver() && r.status === 'sent') {
        bytes -= sizes[i]
        count -= 1
        sentDropped++
        continue
      }

      kept.push(r)
    }

    return {kept, sentDropped}
  }

  private async doAppend(record: StoredAnalyticsRecord): Promise<void> {
    await this.ensureDir()
    const all = await this.readAllRecords()
    const simulated = [...all, record]

    if (this.exceedsCap(simulated)) {
      const {kept, sentDropped} = this.compactRows(simulated)
      if (this.exceedsCap(kept)) {
        // Even after dropping all sent rows, still over cap. Drop the new record and signal the
        // caller so it can skip any mirror write (queue push). A silent return here would let
        // AnalyticsClient.trackAsync diverge from disk: queue would carry an event that JSONL
        // never persisted, breaking the JSONL=truth invariant.
        if (sentDropped > 0) {
          this.droppedSentCounter += sentDropped
          // Persist whatever sent rows we did manage to drop, but exclude the new record.
          await this.atomicRewrite(kept.filter((r) => r.id !== record.id))
        }

        this.droppedFullCounter++
        throw new JsonlCapFullError(record.id)
      }

      // Compaction succeeded: write the compacted set (which already includes the new record).
      this.droppedSentCounter += sentDropped
      await this.atomicRewrite(kept)
      return
    }

    // Normal path: explicit fsync via FileHandle.sync() so the row survives daemon kill.
    const line = JSON.stringify(record) + '\n'
    const handle = await open(this.filePath, 'a')
    try {
      await handle.appendFile(line, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private async doUpdateStatus(idSet: Set<string>, status: JsonlAnalyticsStoreUpdateStatus): Promise<void> {
    const all = await this.readAllRecords()
    let mutated = false
    const next = all.map((row): StoredAnalyticsRecord => {
      if (!idSet.has(row.id)) return row

      if (status === 'sent') {
        if (row.status === 'sent') return row
        mutated = true
        return {...row, status: 'sent'}
      }

      // status === 'failed' — retry-cap gate. Skip rows already at terminal failed (no overshoot).
      if (row.status === 'failed') return row
      const nextAttempts = row.attempts + 1
      mutated = true
      if (nextAttempts >= MAX_ATTEMPTS) {
        return {...row, attempts: nextAttempts, status: 'failed'}
      }

      return {...row, attempts: nextAttempts, status: 'pending'}
    })

    if (!mutated) return
    await this.atomicRewrite(next)
  }

  /**
   * Serialize `work` against any in-flight write. Caller awaits `next`
   * to observe errors from this specific call. The chain itself swallows
   * errors so a failure in one `enqueue` does NOT reject all subsequent
   * calls.
   */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(async () => work())
    this.writeChain = next.then(
      () => {},
      () => {},
    )
    return next
  }

  private async ensureDir(): Promise<void> {
    await mkdir(dirname(this.filePath), {recursive: true})
  }

  private exceedsCap(rows: readonly StoredAnalyticsRecord[]): boolean {
    if (rows.length > this.maxRows) return true
    let bytes = 0
    for (const r of rows) {
      bytes += Buffer.byteLength(JSON.stringify(r) + '\n', 'utf8')
      if (bytes > this.maxBytes) return true
    }

    return false
  }

  private async readAllRecords(): Promise<StoredAnalyticsRecord[]> {
    let content: string
    try {
      content = await readFile(this.filePath, 'utf8')
    } catch {
      return []
    }

    const records: StoredAnalyticsRecord[] = []
    for (const line of content.split('\n')) {
      if (line.length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(line)
      } catch {
        // Skip unparseable line (corrupt write or partial flush).
        continue
      }

      const parsed = StoredAnalyticsRecordSchema.safeParse(raw)
      if (parsed.success) {
        records.push(parsed.data)
      }
    }

    return records
  }
}
