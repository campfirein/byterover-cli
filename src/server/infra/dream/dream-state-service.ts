import {randomUUID} from 'node:crypto'
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'

import {AsyncMutex} from '../../../agent/infra/llm/context/async-mutex.js'
import {type DreamState, DreamStateSchema, EMPTY_DREAM_STATE} from './dream-state-schema.js'

const STATE_FILENAME = 'dream-state.json'

// Module-level mutex registry keyed by absolute state file path.
// The agent process can hold up to AGENT_MAX_CONCURRENT_TASKS concurrent curate tasks
// and a dream-finalize task running concurrently, so read-modify-write on dream-state.json
// must be serialized across all writers via update().
// Independent DreamStateService instances pointing at the same file share a mutex.
//
// Note: this Map grows monotonically — one entry per unique absolute state-file
// path ever instantiated. In practice it is bounded by the number of registered
// projects in the agent process (typically single digits), so memory growth is
// negligible. If the daemon ever needs to support project unregister, evict
// entries here on unregister to keep the registry tight.
const stateMutexes = new Map<string, AsyncMutex>()

function getStateMutex(stateFilePath: string): AsyncMutex {
  const key = resolve(stateFilePath)
  let mutex = stateMutexes.get(key)
  if (!mutex) {
    mutex = new AsyncMutex()
    stateMutexes.set(key, mutex)
  }

  return mutex
}

type DreamStateServiceOptions = {
  baseDir: string
}

/**
 * File-based persistence for dream state.
 *
 * Reads return EMPTY_DREAM_STATE on missing/corrupt files (fail-open).
 * Writes are atomic (tmp → rename) and validate with Zod before persisting.
 */
export class DreamStateService {
  private readonly stateFilePath: string

  constructor(opts: DreamStateServiceOptions) {
    this.stateFilePath = join(opts.baseDir, STATE_FILENAME)
  }

  /**
   * Atomic drain — reads the current queue and clears it in a single RMW,
   * returning the deduped path list. The caller is responsible for retrying
   * (re-enqueueing the returned snapshot) if the downstream work fails.
   *
   * Atomicity is the load-bearing property: any enqueue that runs after the
   * drain returns sees an empty queue, so it always appends a fresh entry
   * that survives independently of whether the downstream propagation succeeds
   * or fails. Earlier "snapshot + clear-later" approaches lost same-path
   * enqueues: the dedup check on enqueue saw the still-present snapshot entry
   * and skipped, then `clear()` removed it.
   */
  async drainStaleSummaryPaths(): Promise<string[]> {
    let snapshot: string[] = []
    await this.update((state) => {
      snapshot = state.staleSummaryPaths.map((e) => e.path)
      if (snapshot.length === 0) return state
      return {...state, staleSummaryPaths: []}
    })
    return snapshot
  }

  /**
   * Append the given file paths to the stale-summary queue, deduping by path.
   * A path already in the queue keeps its original `enqueuedAt` timestamp so
   * "how long has this been waiting?" telemetry stays meaningful.
   *
   * Serialized through {@link update} so concurrent enqueues from parallel
   * curate tasks do not lose entries. Empty input is a no-op (no write).
   */
  async enqueueStaleSummaryPaths(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    // Dedup the input itself before checking against the queue — callers may
    // pass non-unique arrays (e.g. multiple changed paths within a single
    // curate that round-trip through the same parent dir).
    const incoming = [...new Set(paths)]
    const enqueuedAt = Date.now()
    await this.update((state) => {
      const existing = new Set(state.staleSummaryPaths.map((e) => e.path))
      const additions = incoming
        .filter((p) => !existing.has(p))
        .map((p) => ({enqueuedAt, path: p}))
      if (additions.length === 0) return state
      return {
        ...state,
        staleSummaryPaths: [...state.staleSummaryPaths, ...additions],
      }
    })
  }

  /**
   * Read-modify-write under a per-file mutex. Serializes concurrent increments
   * from parallel curate tasks within the same agent process so no updates are lost.
   */
  async incrementCurationCount(): Promise<void> {
    await this.update((state) => ({...state, curationsSinceDream: state.curationsSinceDream + 1}))
  }

  async read(): Promise<DreamState> {
    try {
      const raw = await readFile(this.stateFilePath, 'utf8')
      const parsed = DreamStateSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) return {...EMPTY_DREAM_STATE}
      return parsed.data
    } catch {
      return {...EMPTY_DREAM_STATE}
    }
  }

  /**
   * Generic read-modify-write under the same per-file mutex used by
   * incrementCurationCount. All writers that mutate dream-state.json based on
   * its current contents MUST go through this method, otherwise concurrent
   * increments can be silently overwritten.
   */
  async update(updater: (state: DreamState) => DreamState): Promise<DreamState> {
    const mutex = getStateMutex(this.stateFilePath)
    return mutex.withLock(async () => {
      const state = await this.read()
      const next = updater(state)
      // Skip the write when the updater returned the same state reference.
      // Existing call sites (drainStaleSummaryPaths on empty queue,
      // enqueueStaleSummaryPaths with all-duplicate input) already follow
      // this convention by returning `state` unchanged — making the no-op
      // contract observable at the disk level avoids a tmpfile + rename on
      // every empty drain.
      if (next !== state) {
        await this.write(next)
      }

      return next
    })
  }

  /**
   * Atomic write (tmp file → rename). Does NOT acquire the per-file mutex.
   *
   * Direct callers that perform a logical read-modify-write by pairing
   * {@link read} + write bypass serialization and may lose updates from
   * concurrent writers. Use {@link update} for any RMW that depends on the
   * current state.
   */
  async write(state: DreamState): Promise<void> {
    DreamStateSchema.parse(state)
    const dir = dirname(this.stateFilePath)
    await mkdir(dir, {recursive: true})
    const tmpPath = `${this.stateFilePath}.${randomUUID()}.tmp`
    await writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmpPath, this.stateFilePath)
  }
}
