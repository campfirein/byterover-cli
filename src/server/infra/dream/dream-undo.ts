/**
 * Dream Undo — reverts the last dream's file changes using previousTexts from the dream log.
 *
 * Runs directly from CLI (no daemon/agent needed). Pure file I/O.
 * Only undoes the LAST dream — not a history stack.
 */

import {mkdir, unlink, utimes, writeFile} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'

import type {CurateLogEntry, CurateLogOperation} from '../../core/domain/entities/curate-log-entry.js'
import type {ICurateLogStore} from '../../core/interfaces/storage/i-curate-log-store.js'
import type {IReviewBackupStore} from '../../core/interfaces/storage/i-review-backup-store.js'
import type {IRuntimeSignalStore} from '../../core/interfaces/storage/i-runtime-signal-store.js'
import type {DreamLogEntry, DreamOperation} from './dream-log-schema.js'
import type {DreamState} from './dream-state-schema.js'

import {isDescendantOf} from '../../utils/path-utils.js'

export type DreamUndoDeps = {
  archiveService?: {restoreEntry(stubPath: string, directory?: string): Promise<string>}
  contextTreeDir: string
  curateLogStore?: Pick<ICurateLogStore, 'batchUpdateOperationReviewStatus' | 'list'>
  dreamLogStore: {
    getById(id: string): Promise<DreamLogEntry | null>
    save(entry: DreamLogEntry): Promise<void>
  }
  dreamStateService: {
    read(): Promise<DreamState>
    write(state: DreamState): Promise<void>
  }
  manifestService: {buildManifest(dir?: string): Promise<unknown>}
  projectRoot?: string
  reviewBackupStore?: Pick<IReviewBackupStore, 'delete'>
  /**
   * Optional — when provided, undoPrune restores each archived topic's
   * runtime signals from the PRUNE op's `previousSignals` map. Without
   * this dep (or for older log entries lacking the field), the file
   * still gets restored but with default signals — surprising for
   * agents who expected pruned topics to re-surface on the next scan.
   */
  runtimeSignalStore?: Pick<IRuntimeSignalStore, 'set'>
}

export type DreamUndoResult = {
  deletedFiles: string[]
  dreamId: string
  errors: string[]
  restoredArchives: string[]
  restoredFiles: string[]
}

export async function undoLastDream(deps: DreamUndoDeps): Promise<DreamUndoResult> {
  const {contextTreeDir, dreamLogStore, dreamStateService, manifestService} = deps

  // ── Precondition checks ─────────────────────────────────────────────────
  const state = await dreamStateService.read()
  if (!state.lastDreamLogId) {
    throw new Error('No dream to undo')
  }

  const log = await dreamLogStore.getById(state.lastDreamLogId)
  if (!log) {
    throw new Error(`Dream log not found: ${state.lastDreamLogId}`)
  }

  if (log.status === 'undone') {
    throw new Error(`Dream already undone: ${state.lastDreamLogId}`)
  }

  if (log.status !== 'completed' && log.status !== 'partial') {
    throw new Error(`Cannot undo dream with status: ${log.status}`)
  }

  // ── Reverse operations ──────────────────────────────────────────────────
  const result: DreamUndoResult = {
    deletedFiles: [],
    dreamId: log.id,
    errors: [],
    restoredArchives: [],
    restoredFiles: [],
  }

  // Track pending merges to remove (for PRUNE/SUGGEST_MERGE)
  const mergesToRemove: Array<{mergeTarget: string; sourceFile: string}> = []

  const reversed = [...log.operations].reverse()
  for (const op of reversed) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await undoOperation(op, {contextTreeDir, deps, mergesToRemove, result})
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  // ── Post-undo: clean up review entries and backups ──────────────────────
  await cleanupReviewEntries(log, deps)

  // ── Post-undo: rebuild manifest ─────────────────────────────────────────
  try {
    await manifestService.buildManifest()
  } catch (error) {
    result.errors.push(`Manifest rebuild failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // ── Post-undo: mark log as undone ───────────────────────────────────────
  const undoneLog: DreamLogEntry = {
    completedAt: log.completedAt,
    id: log.id,
    operations: log.operations,
    startedAt: log.startedAt,
    status: 'undone',
    summary: log.summary,
    taskId: log.taskId,
    trigger: log.trigger,
    undoneAt: Date.now(),
  }
  await dreamLogStore.save(undoneLog)

  // ── Post-undo: rewind dream state ───────────────────────────────────────
  let {pendingMerges} = state
  if (mergesToRemove.length > 0) {
    pendingMerges = (pendingMerges ?? []).filter(
      (pm) => !mergesToRemove.some((rm) => rm.sourceFile === pm.sourceFile && rm.mergeTarget === pm.mergeTarget),
    )
  }

  // Undo runs in the CLI process. The in-process mutex guarding
  // update() lives in the daemon, so using update() here wouldn't
  // synchronize with a concurrent daemon-side incrementCurationCount anyway —
  // write() is acceptable. If daemon-side undo is ever added, switch to
  // update() to serialize with other writers in that process.
  await dreamStateService.write({
    ...state,
    lastDreamAt: null,
    pendingMerges,
    totalDreams: Math.max(0, state.totalDreams - 1),
  })

  return result
}

/** Unlink a file, ignoring ENOENT (already gone) but rethrowing other errors. */
async function unlinkSafe(filePath: string): Promise<void> {
  try {
    await unlink(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/** Resolve a relative path within contextTreeDir, rejecting traversal outside the tree. */
function safePath(contextTreeDir: string, relativePath: string): string {
  const full = resolve(contextTreeDir, relativePath)
  if (!isDescendantOf(full, contextTreeDir)) {
    throw new Error(`Path traversal blocked: ${relativePath}`)
  }

  return full
}

// ── Per-operation undo handlers ───────────────────────────────────────────────

type UndoContext = {
  contextTreeDir: string
  deps: DreamUndoDeps
  mergesToRemove: Array<{mergeTarget: string; sourceFile: string}>
  result: DreamUndoResult
}

async function undoOperation(op: DreamOperation, ctx: UndoContext): Promise<void> {
  switch (op.type) {
    case 'CONSOLIDATE': {
      await undoConsolidate(op, ctx.contextTreeDir, ctx.result)
      break
    }

    case 'PRUNE': {
      await undoPrune(op, ctx)
      break
    }

    case 'SYNTHESIZE': {
      await undoSynthesize(op, ctx.contextTreeDir, ctx.result)
      break
    }
  }
}

async function undoConsolidate(
  op: Extract<DreamOperation, {type: 'CONSOLIDATE'}>,
  contextTreeDir: string,
  result: DreamUndoResult,
): Promise<void> {
  switch (op.action) {
    case 'CROSS_REFERENCE': {
      if (!op.previousTexts || Object.keys(op.previousTexts).length === 0) break

      for (const [filePath, content] of Object.entries(op.previousTexts)) {
        const fullPath = safePath(contextTreeDir, filePath)
        // eslint-disable-next-line no-await-in-loop
        await mkdir(dirname(fullPath), {recursive: true})
        // eslint-disable-next-line no-await-in-loop
        await writeFile(fullPath, content, 'utf8')
        result.restoredFiles.push(filePath)
      }

      break
    }

    case 'MERGE': {
      if (!op.previousTexts || Object.keys(op.previousTexts).length === 0) {
        throw new Error(`Cannot undo MERGE: missing previousTexts for ${op.outputFile ?? op.inputFiles[0]}`)
      }

      // Restore all source files from previousTexts
      for (const [filePath, content] of Object.entries(op.previousTexts)) {
        const fullPath = safePath(contextTreeDir, filePath)
        // eslint-disable-next-line no-await-in-loop
        await mkdir(dirname(fullPath), {recursive: true})
        // eslint-disable-next-line no-await-in-loop
        await writeFile(fullPath, content, 'utf8')
        result.restoredFiles.push(filePath)
      }

      // Delete merged output if it wasn't an original source
      if (op.outputFile && !op.previousTexts[op.outputFile]) {
        await unlinkSafe(safePath(contextTreeDir, op.outputFile))
        result.deletedFiles.push(op.outputFile)
      }

      break
    }

    case 'TEMPORAL_UPDATE': {
      if (!op.previousTexts || Object.keys(op.previousTexts).length === 0) {
        throw new Error(`Cannot undo TEMPORAL_UPDATE: missing previousTexts for ${op.inputFiles[0]}`)
      }

      for (const [filePath, content] of Object.entries(op.previousTexts)) {
        const fullPath = safePath(contextTreeDir, filePath)
        // eslint-disable-next-line no-await-in-loop
        await mkdir(dirname(fullPath), {recursive: true})
        // eslint-disable-next-line no-await-in-loop
        await writeFile(fullPath, content, 'utf8')
        result.restoredFiles.push(filePath)
      }

      break
    }
  }
}

async function undoSynthesize(
  op: Extract<DreamOperation, {type: 'SYNTHESIZE'}>,
  contextTreeDir: string,
  result: DreamUndoResult,
): Promise<void> {
  // UPDATE modified a pre-existing file — can't undo without previousTexts (not captured by SYNTHESIZE)
  if (op.action === 'UPDATE') {
    throw new Error(`Cannot undo SYNTHESIZE/UPDATE: previousTexts not captured for ${op.outputFile}`)
  }

  // CREATE — delete the synthesized file
  await unlinkSafe(safePath(contextTreeDir, op.outputFile))
  result.deletedFiles.push(op.outputFile)
}

/**
 * Clean up review system artifacts created by the dream's dual-write.
 * - Mark curate log operations from dream entries as 'rejected'
 * - Delete review backups for files involved in needsReview operations
 */
type ReviewTarget = {
  path: string
  type: CurateLogOperation['type']
}

function reviewTargetKey(target: ReviewTarget): string {
  return `${target.type}:${target.path}`
}

function collectReviewTargets(operations: DreamOperation[]): ReviewTarget[] {
  const targets: ReviewTarget[] = []
  for (const op of operations) {
    if (!op.needsReview) continue

    if (op.type === 'PRUNE' && op.action === 'ARCHIVE') {
      targets.push({path: op.file, type: 'DELETE'})
      continue
    }

    if (op.type === 'CONSOLIDATE' && op.action === 'MERGE') {
      targets.push({path: op.outputFile ?? op.inputFiles[0], type: 'MERGE'})
      continue
    }

    if (op.type === 'CONSOLIDATE') {
      targets.push({path: op.inputFiles[0], type: 'UPDATE'})
      continue
    }

    if (op.type === 'SYNTHESIZE') {
      targets.push({path: op.outputFile, type: op.action === 'CREATE' ? 'ADD' : 'UPDATE'})
    }
  }

  return targets
}

function buildReviewStatusUpdates(entry: CurateLogEntry): Array<{operationIndex: number; reviewStatus: 'rejected'}> {
  return entry.operations
    .map((op, operationIndex) =>
      op.reviewStatus && op.reviewStatus !== 'rejected'
        ? {operationIndex, reviewStatus: 'rejected' as const}
        : null,
    )
    .filter((update): update is {operationIndex: number; reviewStatus: 'rejected'} => update !== null)
}

function matchLegacyDreamReviewEntry(
  entries: CurateLogEntry[],
  operations: DreamOperation[],
): CurateLogEntry[] {
  const expected = collectReviewTargets(operations).map((target) => reviewTargetKey(target)).sort()
  if (expected.length === 0) return []

  const matches = entries.filter((entry) => {
    const actual = entry.operations.map((op) => reviewTargetKey({path: op.path, type: op.type})).sort()
    return actual.length === expected.length && actual.every((value, index) => value === expected[index])
  })

  return matches.length === 1 ? matches : []
}

async function cleanupReviewEntries(log: DreamLogEntry, deps: DreamUndoDeps): Promise<void> {
  const hasReviewOps = log.operations.some((op) => op.needsReview)

  // Mark curate log entries from dream as rejected.
  // Runs whenever the dream had any needsReview ops — even if previousTexts is absent
  // (e.g. legacy CROSS_REFERENCE entries), so the pending review task is always cleaned up.
  if (deps.curateLogStore && hasReviewOps) {
    try {
      const entries = await deps.curateLogStore.list({status: ['completed']})
      const dreamEntries = entries.filter((entry) => entry.input.context === 'dream')
      const matchedEntries = log.taskId
        ? dreamEntries.filter((entry) => entry.taskId === log.taskId)
        : matchLegacyDreamReviewEntry(dreamEntries, log.operations)

      for (const entry of matchedEntries) {
        const updates = buildReviewStatusUpdates(entry)
        if (updates.length === 0) continue
        // eslint-disable-next-line no-await-in-loop
        await deps.curateLogStore.batchUpdateOperationReviewStatus(entry.id, updates)
      }
    } catch {
      // Fail-open: review cleanup must not block undo
    }
  }

  // Delete review backups for affected files (collected from previousTexts keys,
  // which mirror what the backup store received during the dream).
  if (deps.reviewBackupStore) {
    const reviewFilePaths = new Set<string>()
    for (const op of log.operations) {
      if (!op.needsReview) continue
      if (op.type === 'PRUNE') reviewFilePaths.add(op.file)
      if (op.type === 'CONSOLIDATE' && op.previousTexts) {
        for (const file of Object.keys(op.previousTexts)) reviewFilePaths.add(file)
      }

      if (op.type === 'SYNTHESIZE') reviewFilePaths.add(op.outputFile)
    }

    if (reviewFilePaths.size > 0) {
      await Promise.all(
        [...reviewFilePaths].map((file) => deps.reviewBackupStore!.delete(file).catch(() => {})),
      )
    }
  }
}

async function undoPrune(
  op: Extract<DreamOperation, {type: 'PRUNE'}>,
  ctx: UndoContext,
): Promise<void> {
  switch (op.action) {
    case 'ARCHIVE': {
      // Tool-mode finalize writes a flat .brv/archive/<relPath> copy and
      // captures the body inline as previousTexts; restore from the log
      // directly so we don't depend on archive-service-managed stubs.
      //
      // Newer log entries also carry `previousMtimes` and
      // `previousSignals`; restoring them re-creates the observable
      // state that drove the prune decision (e.g. importance < 35,
      // mtime > 60d) so the topic re-surfaces on the next scan if it
      // still qualifies. Older entries lack these fields — the file
      // is still restored, but signals fall back to defaults.
      if (op.previousTexts && Object.keys(op.previousTexts).length > 0) {
        const archiveDir = join(dirname(ctx.contextTreeDir), 'archive')
        for (const [filePath, content] of Object.entries(op.previousTexts)) {
          const fullPath = safePath(ctx.contextTreeDir, filePath)
          // eslint-disable-next-line no-await-in-loop
          await mkdir(dirname(fullPath), {recursive: true})
          // eslint-disable-next-line no-await-in-loop
          await writeFile(fullPath, content, 'utf8')

          // Restore original mtime so stale-mtime prune candidates
          // re-qualify. `writeFile` stamps mtime=now; `utimes` overwrites.
          const savedMtimeMs = op.previousMtimes?.[filePath]
          if (savedMtimeMs !== undefined) {
            const mtime = new Date(savedMtimeMs)
            // eslint-disable-next-line no-await-in-loop
            await utimes(fullPath, mtime, mtime)
          }

          // Restore sidecar signals so importance / maturity-driven
          // prune candidates re-qualify. Best-effort — sidecar write
          // failure shouldn't fail the file restore.
          const savedSignals = op.previousSignals?.[filePath]
          if (savedSignals !== undefined && ctx.deps.runtimeSignalStore) {
            try {
              // eslint-disable-next-line no-await-in-loop
              await ctx.deps.runtimeSignalStore.set(filePath, savedSignals)
            } catch {
              // best-effort sidecar restore; the file itself is back
            }
          }

          ctx.result.restoredFiles.push(filePath)

          // Clean up the .brv/archive/<relPath> duplicate so we don't leave
          // a stale copy alongside the restored original. Best-effort —
          // ENOENT is fine, real errors get surfaced via the per-op try/catch.
          // eslint-disable-next-line no-await-in-loop
          await unlinkSafe(join(archiveDir, filePath))
        }

        break
      }

      // Legacy LLM-driven prune path — archive service round-trip.
      if (!ctx.deps.archiveService) {
        throw new Error(`Cannot undo PRUNE/ARCHIVE: no archive service available for ${op.file}`)
      }

      if (!op.stubPath) {
        throw new Error(`Cannot undo PRUNE/ARCHIVE: missing stubPath for ${op.file}`)
      }

      const restored = await ctx.deps.archiveService.restoreEntry(op.stubPath, ctx.deps.projectRoot)
      ctx.result.restoredArchives.push(restored)
      break
    }

    case 'KEEP': {
      // No-op — nothing was changed
      break
    }

    case 'SUGGEST_MERGE': {
      if (op.mergeTarget) {
        ctx.mergesToRemove.push({mergeTarget: op.mergeTarget, sourceFile: op.file})
      }

      break
    }
  }
}
