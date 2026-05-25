import {randomUUID} from 'node:crypto'
import {mkdir, readdir, readFile, rename, rm, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {z} from 'zod'

import type {QueryLogEntry} from '../../core/domain/entities/query-log-entry.js'
import type {IQueryLogStore, QueryLogStatus, QueryLogTier} from '../../core/interfaces/storage/i-query-log-store.js'

import {QUERY_LOG_DIR, QUERY_LOG_ID_PREFIX} from '../../constants.js'
import {QUERY_LOG_TIERS} from '../../core/domain/entities/query-log-entry.js'

const QueryLogMatchedDocFileSchema = z.object({
  path: z.string(),
  score: z.number(),
  title: z.string(),
})

const QueryLogSearchMetadataFileSchema = z.object({
  cacheFingerprint: z.string().optional(),
  resultCount: z.number(),
  topScore: z.number(),
  totalFound: z.number(),
})

const QueryLogTimingFileSchema = z.object({
  durationMs: z.number().optional(),
  llmMs: z.number().optional(),
  searchMs: z.number().optional(),
  totalMs: z.number().optional(),
})

// Single source of truth: tier validation is derived from QUERY_LOG_TIERS at runtime.
// Adding/removing a tier in the entity automatically updates schema validation.
const QUERY_LOG_TIER_SET: ReadonlySet<unknown> = new Set<unknown>(QUERY_LOG_TIERS)
const QueryLogTierSchema = z.custom<QueryLogTier>(
  (val) => QUERY_LOG_TIER_SET.has(val),
  {message: 'Invalid query log tier'},
)

const QueryLogEntryBaseSchema = z.object({
  cacheCreationTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  format: z.enum(['html', 'markdown']).optional(),
  id: z.string(),
  inputTokens: z.number().optional(),
  matchedDocs: z.array(QueryLogMatchedDocFileSchema),
  outputTokens: z.number().optional(),
  query: z.string(),
  searchMetadata: QueryLogSearchMetadataFileSchema.optional(),
  startedAt: z.number(),
  taskId: z.string(),
  tier: QueryLogTierSchema.optional(),
  timing: QueryLogTimingFileSchema.optional(),
})

const QueryLogEntryFileSchema = z.discriminatedUnion('status', [
  QueryLogEntryBaseSchema.extend({status: z.literal('processing')}),
  QueryLogEntryBaseSchema.extend({
    completedAt: z.number(),
    response: z.string().optional(),
    status: z.literal('completed'),
  }),
  QueryLogEntryBaseSchema.extend({
    completedAt: z.number(),
    error: z.string(),
    status: z.literal('error'),
  }),
  QueryLogEntryBaseSchema.extend({
    completedAt: z.number(),
    status: z.literal('cancelled'),
  }),
])

const ID_PATTERN = new RegExp(`^${QUERY_LOG_ID_PREFIX}-\\d+$`)
const DEFAULT_MAX_ENTRIES = 1000
const DEFAULT_MAX_AGE_DAYS = 30
/** Entries stuck in "processing" longer than this are considered interrupted (daemon was killed). */
const STALE_PROCESSING_THRESHOLD_MS = 10 * 60 * 1000 // 10 minutes

type FileQueryLogStoreOptions = {
  baseDir: string
  maxAgeDays?: number
  maxEntries?: number
}

/**
 * File-based implementation of IQueryLogStore.
 *
 * Each log entry is stored as a JSON file:
 *   {baseDir}/query-log/qry-{timestamp_ms}.json
 *
 * Writes are atomic (tmp → rename). Reads validate with Zod and return undefined
 * for corrupt/missing files. Prunes by age (default 30 days) then by count (default 1000).
 */
export class FileQueryLogStore implements IQueryLogStore {
  private lastTimestamp = 0
  private readonly logDir: string
  private readonly maxAgeDays: number
  private readonly maxEntries: number
  private pruneInFlight = false

  constructor(opts: FileQueryLogStoreOptions) {
    this.logDir = join(opts.baseDir, QUERY_LOG_DIR)
    this.maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  }

  /**
   * Retrieve an entry by ID. Returns undefined if:
   * - ID format is invalid (security: prevents path traversal)
   * - File does not exist
   * - File content fails Zod validation (corrupted)
   */
  async getById(id: string): Promise<QueryLogEntry | undefined> {
    if (!ID_PATTERN.test(id)) return undefined

    try {
      const raw = await readFile(this.entryPath(id), 'utf8')
      const parsed = QueryLogEntryFileSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return undefined
      return await this.resolveStale(parsed.data)
    } catch {
      return undefined
    }
  }

  /**
   * Generate the next monotonic log entry ID in the format `qry-{timestamp_ms}`.
   * Guaranteed to increase even if called multiple times in the same millisecond.
   *
   * Note: monotonicity is instance-local. A new instance resets `lastTimestamp` to 0
   * and relies on wall-clock time. Two instances pointing at the same baseDir could
   * theoretically collide in the same millisecond, but this is practically impossible
   * given the sequential task queue (max concurrency = 1 per project).
   */
  async getNextId(): Promise<string> {
    const now = Date.now()
    this.lastTimestamp = now <= this.lastTimestamp ? this.lastTimestamp + 1 : now
    return `${QUERY_LOG_ID_PREFIX}-${this.lastTimestamp}`
  }

  /**
   * List entries sorted newest-first (by timestamp embedded in filename).
   * Filters (status, tier, after, before) are applied before limit.
   * Reads stop early once `limit` matches are found, so filtered queries with small limits
   * are O(matches) rather than O(total entries). Skips corrupt entries silently.
   */
  async list({
    after,
    before,
    limit,
    status,
    tier,
  }: {after?: number; before?: number; limit?: number; status?: QueryLogStatus[]; tier?: QueryLogTier[]} = {}): Promise<
    QueryLogEntry[]
  > {
    let files: string[]
    try {
      const entries = await readdir(this.logDir, {withFileTypes: true})
      files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json') && ID_PATTERN.test(e.name.slice(0, -5)))
        .map((e) => e.name)
        .sort()
        .reverse() // newest-first (lexicographic descending)
    } catch {
      return []
    }

    // Sequential read with early termination once limit matches are found.
    // Avoids scanning all files for queries like list({status: ['error'], limit: 1}).
    const results: QueryLogEntry[] = []
    const targetCount = limit ?? Number.POSITIVE_INFINITY
    for (const filename of files) {
      if (results.length >= targetCount) break

      const id = filename.slice(0, -5)
      // eslint-disable-next-line no-await-in-loop -- early termination requires sequential reads
      const entry = await this.getById(id)
      if (!entry) continue

      if (status?.length && !status.includes(entry.status)) continue
      if (tier?.length && (entry.tier === undefined || !tier.includes(entry.tier))) continue
      if (after !== undefined && entry.startedAt < after) continue
      if (before !== undefined && entry.startedAt > before) continue

      results.push(entry)
    }

    return results
  }

  /**
   * Persist a log entry atomically (write to tmp, then rename).
   * On rename failure, cleans up the tmp file. After saving, prunes by age then by count (best-effort).
   */
  async save(entry: QueryLogEntry): Promise<void> {
    await mkdir(this.logDir, {recursive: true})
    await this.writeAtomic(this.entryPath(entry.id), JSON.stringify(entry, null, 2))
    this.firePrune()
  }

  private entryPath(id: string): string {
    return join(this.logDir, `${id}.json`)
  }

  /**
   * Schedule a prune pass without blocking the caller.
   * Deduplicates concurrent calls — only one prune runs at a time.
   */
  private firePrune(): void {
    if (this.pruneInFlight) return
    this.pruneInFlight = true
    this.pruneOldest()
      .catch(() => {})
      .finally(() => {
        this.pruneInFlight = false
      })
  }

  private async pruneOldest(): Promise<void> {
    const dirEntries = await readdir(this.logDir, {withFileTypes: true})
    const files = dirEntries
      .filter((e) => e.isFile() && e.name.endsWith('.json') && ID_PATTERN.test(e.name.slice(0, -5)))
      .map((e) => e.name)
      .sort() // oldest-first

    // Phase 1: Age-based pruning (skip if maxAgeDays === 0)
    let remaining = files
    if (this.maxAgeDays > 0) {
      const cutoff = Date.now() - this.maxAgeDays * 86_400_000
      const expired: string[] = []
      const kept: string[] = []

      for (const f of files) {
        const ts = Number(f.slice(QUERY_LOG_ID_PREFIX.length + 1, -5)) // extract timestamp from "qry-{ts}.json"
        if (ts < cutoff) {
          expired.push(f)
        } else {
          kept.push(f)
        }
      }

      if (expired.length > 0) {
        await Promise.all(expired.map((f) => rm(join(this.logDir, f), {force: true}).catch(() => {})))
      }

      remaining = kept
    }

    // Phase 2: Count-based pruning
    if (remaining.length <= this.maxEntries) return

    const toDelete = remaining.slice(0, remaining.length - this.maxEntries)
    await Promise.all(toDelete.map((f) => rm(join(this.logDir, f), {force: true}).catch(() => {})))
  }

  /**
   * If a "processing" entry is older than STALE_PROCESSING_THRESHOLD_MS, the daemon
   * was killed before it could finalize it. Rewrite it as "error" on disk (best-effort)
   * and return the corrected entry so the display shows "interrupted" instead of processing.
   *
   * Uses writeAtomic directly (not save) to skip the prune cascade — list() with N stale
   * entries would otherwise trigger N concurrent prune passes.
   */
  private async resolveStale(entry: QueryLogEntry): Promise<QueryLogEntry> {
    if (entry.status !== 'processing') return entry
    if (Date.now() - entry.startedAt <= STALE_PROCESSING_THRESHOLD_MS) return entry

    const recovered: QueryLogEntry = {
      ...entry,
      completedAt: Date.now(),
      error: 'Interrupted (daemon terminated)',
      status: 'error',
    }

    this.writeAtomic(this.entryPath(recovered.id), JSON.stringify(recovered, null, 2)).catch(() => {})
    return recovered
  }

  /**
   * Atomic write: write to a tmp file with random UUID suffix, then rename.
   * On failure, cleans up the tmp file and re-throws the original error.
   */
  private async writeAtomic(filePath: string, content: string): Promise<void> {
    const tmpPath = `${filePath}.${randomUUID()}.tmp`
    try {
      await writeFile(tmpPath, content, 'utf8')
      await rename(tmpPath, filePath)
    } catch (error) {
      await rm(tmpPath, {force: true}).catch(() => {})
      throw error
    }
  }
}
