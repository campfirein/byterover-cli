/**
 * Per-project FileTaskHistoryStore cache + lazy startup audit.
 *
 * Module-scoped so M2.09's wire handlers can reuse the same store instances
 * the M2.06 lifecycle hook writes to. Audit fires once per project on first
 * access, comparing `_index.jsonl` ↔ `data/` files to flag orphans without
 * auto-fixing (M2.03 compaction owns the cleanup pass).
 */

import {readdir} from 'node:fs/promises'
import {join} from 'node:path'

import {TASK_HISTORY_DIR} from '../../constants.js'
import {getProjectDataDir} from '../../utils/path-utils.js'
import {processLog} from '../../utils/process-logger.js'
import {FileTaskHistoryStore} from '../storage/file-task-history-store.js'

const FILENAME_PATTERN = /^tsk-(.+)\.json$/
const MAX_LISTED_ORPHANS = 5

const stores = new Map<string, FileTaskHistoryStore>()
const auditedProjects = new Set<string>()

/**
 * Daemon boot wall-clock timestamp. Captured at module load so EVERY per-project
 * store shares the same boot reference. The C0 daemon-startup gate inside
 * `FileTaskHistoryStore.isStaleAndRecoverable` uses this to skip stale-recovery
 * for entries written post-boot — those belong to live in-memory tasks whose
 * lifecycle hooks are still firing throttled saves and must not be tombstoned
 * to `INTERRUPTED`.
 *
 * `resetTaskHistoryStoreCache()` re-captures it so tests see fresh boot
 * semantics per `beforeEach`.
 */
let daemonStartedAt = Date.now()

/** Optional logger override for tests — when set, audit triggered inside getStore uses this. */
let testLoggerForGetStore: ((msg: string) => void) | undefined

/**
 * Daemon-startup-configured cap on per-project task history entries.
 * `undefined` means "use FileTaskHistoryStore's own default". Set once by
 * the daemon bootstrap before any task lookups; applies only to stores
 * created after the call.
 */
let configuredMaxEntries: number | undefined

/**
 * Daemon bootstrap entry point. Sets the `maxEntries` used by every
 * per-project store the cache creates afterwards. Stores already cached
 * are left untouched so existing tasks observe stable retention.
 */
export function configureTaskHistoryStoreCache(options: {readonly maxEntries: number}): void {
  configuredMaxEntries = options.maxEntries
}

/**
 * Resolve (or lazily create) the per-project store. The first call for a
 * given `projectPath` schedules a best-effort audit; subsequent calls reuse
 * the cached store and skip re-auditing.
 */
export function getStore(projectPath: string): FileTaskHistoryStore {
  let store = stores.get(projectPath)
  if (!store) {
    store = new FileTaskHistoryStore({
      baseDir: getProjectDataDir(projectPath),
      daemonStartedAt,
      maxEntries: configuredMaxEntries,
    })
    stores.set(projectPath, store)
  }

  if (!auditedProjects.has(projectPath)) {
    auditedProjects.add(projectPath)
    auditTaskHistory(projectPath, store, testLoggerForGetStore).catch((error: unknown) => {
      processLog(
        `[task-history] audit failed for ${projectPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
    })
  }

  return store
}

/**
 * Compare `_index.jsonl` (live entries) against the `data/` directory and log
 * orphans. Best-effort: never throws to caller. The `log` parameter defaults
 * to `processLog` for production; tests inject a stub.
 */
export async function auditTaskHistory(
  projectPath: string,
  store: FileTaskHistoryStore,
  log: ((msg: string) => void) | undefined = undefined,
): Promise<void> {
  const effectiveLog = log ?? processLog

  const liveEntries = await store.list()
  const liveTaskIds = new Set(liveEntries.map((e) => e.taskId))

  const dataDir = join(getProjectDataDir(projectPath), TASK_HISTORY_DIR, 'data')
  let dataFiles: string[]
  try {
    dataFiles = await readdir(dataDir)
  } catch {
    dataFiles = []
  }

  const dataTaskIds = new Set<string>()
  for (const filename of dataFiles) {
    const match = FILENAME_PATTERN.exec(filename)
    if (match) dataTaskIds.add(match[1])
  }

  const orphanIndex = [...liveTaskIds].filter((id) => !dataTaskIds.has(id))
  const orphanData = [...dataTaskIds].filter((id) => !liveTaskIds.has(id))

  const head = `[task-history] audit ${projectPath} — ${liveTaskIds.size} live entries, ${dataTaskIds.size} data files.`
  if (orphanIndex.length === 0 && orphanData.length === 0) {
    effectiveLog(`${head} ok.`)
    return
  }

  const parts: string[] = []
  if (orphanIndex.length > 0) parts.push(formatOrphans('orphan-index', orphanIndex))
  if (orphanData.length > 0) parts.push(formatOrphans('orphan-data', orphanData))
  effectiveLog(`${head} WARN: ${parts.join('; ')}.`)
}

/** Test-only: clear module-scope state so each test sees a fresh cache. */
export function resetTaskHistoryStoreCache(): void {
  stores.clear()
  auditedProjects.clear()
  testLoggerForGetStore = undefined
  configuredMaxEntries = undefined
  // Re-capture boot time so tests see fresh "this daemon just started" semantics
  // for the C0 stale-recovery gate.
  daemonStartedAt = Date.now()
}

/** Test-only: inject a logger into the audit path triggered by `getStore`. Pass no arg to clear. */
export function _setTestLoggerForGetStore(log?: (msg: string) => void): void {
  testLoggerForGetStore = log
}

function formatOrphans(label: string, ids: string[]): string {
  const listed = ids.slice(0, MAX_LISTED_ORPHANS).map((id) => `tsk-${id}`).join(', ')
  const remainder = ids.length > MAX_LISTED_ORPHANS ? ` (+${ids.length - MAX_LISTED_ORPHANS} more)` : ''
  return `${ids.length} ${label} ${listed}${remainder}`
}
