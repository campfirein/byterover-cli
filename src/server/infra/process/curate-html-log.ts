import {readFile} from 'node:fs/promises'
import {relative, sep} from 'node:path'

import type {CurateMeta} from '../../../shared/curate-meta.js'
import type {CurateLogEntry, CurateLogOperation} from '../../core/domain/entities/curate-log-entry.js'
import type {IReviewBackupStore} from '../../core/interfaces/storage/i-review-backup-store.js'
import type {HtmlWriteResult} from '../render/writer/html-writer.js'

import {computeSummary} from './curate-log-handler.js'

/**
 * Default `input.context` sentinel for tool-mode curates that don't carry
 * a user-intent string (MCP calls — the agent typed the HTML directly,
 * there was no `brv curate "<text>"` kickoff). The TUI / `brv curate view`
 * renders this so the log row isn't visually empty.
 */
const DEFAULT_TOOL_MODE_INTENT = '<curated via tool mode>'

const FALLBACK_PATH = '<unknown>'

type BuildInput = {
  /** Wall-clock at write completion (write success OR validation failure). */
  completedAt: number
  /** Whether the caller passed --overwrite / `confirmOverwrite: true`. */
  confirmOverwrite: boolean
  /** Whether a file already existed at the resolved path BEFORE this write. Used to default `type`. */
  existedBefore: boolean
  /** Relative path of the written topic file (e.g. `security/auth.html`). May be undefined on validation failure. */
  filePath?: string
  /** Pre-allocated log id from `FileCurateLogStore.getNextId()` (`cur-<timestamp_ms>` format). */
  id: string
  /** User intent string (CLI kickoff text). MCP calls have no intent — leave undefined to use the sentinel. */
  intent?: string
  /** Agent-supplied operation metadata. Optional. */
  meta?: CurateMeta
  /** Snapshot of project's reviewDisabled flag at task-create time. */
  reviewDisabled: boolean
  /** Wall-clock at write start. */
  startedAt: number
  /** Task id correlating this log entry with its task. */
  taskId: string
  /** Topic path (`security/auth`, no `.html`). May be undefined on validation failure. */
  topicPath?: string
  /** Result from `writeHtmlTopic`. */
  writeResult: HtmlWriteResult
}

/**
 * Capture the current bytes of a context-tree file into the review-backup
 * store BEFORE a destructive write happens. This is the contract the
 * review-handler reject path relies on (`review-handler.ts:148-167`): on
 * reject, it reads `backupStore.read(relPath)`; `null` is treated as
 * "ADD — unlink the file", any non-null content as "restore via writeFile".
 *
 * Without this call, an UPDATE-shaped tool-mode curate writes a
 * `reviewStatus: 'pending'` log entry but no backup — and `brv review reject`
 * deletes the user's prior knowledge instead of restoring it.
 *
 * Mirrors main's `backupBeforeWrite` (`src/agent/infra/tools/implementations/
 * curate-tool.ts:480`) — same semantics:
 *   - Honors `reviewDisabled`: backups exist solely to support reject-restore.
 *     With reviews off they are dead state.
 *   - First-write-wins (delegated to `FileReviewBackupStore.save`): the backup
 *     always reflects the snapshot-at-last-push, never an intermediate state
 *     between two curates that haven't been pushed.
 *   - Best-effort: ENOENT (no prior file on disk = ADD case) is swallowed —
 *     there's nothing to back up. Other I/O failures are also swallowed so a
 *     transient store error doesn't fail an otherwise-successful curate.
 *
 * Call this immediately before `writeHtmlTopic` in both the daemon's
 * `case 'curate-html-direct'` and the CLI's `continueSession`.
 */
export async function backupContextTreeFile(input: {
  /** Absolute path to the file `writeHtmlTopic` will (over)write. */
  absoluteFilePath: string
  /** Absolute path to the project's context-tree root (`.brv/context-tree/`). */
  contextTreeRoot: string
  /** Project's review-backup store (instantiate with the project's `.brv/` dir). */
  reviewBackupStore: IReviewBackupStore
  /** Snapshot of the project's reviewDisabled flag for this task. */
  reviewDisabled: boolean
}): Promise<void> {
  if (input.reviewDisabled) return
  try {
    const content = await readFile(input.absoluteFilePath, 'utf8')
    // Normalize to forward-slashes — review-handler keys backups by the relative
    // context-tree path it derived the same way (`relative()`); on Windows the
    // separators would otherwise disagree across surfaces.
    const relativePath = relative(input.contextTreeRoot, input.absoluteFilePath).replaceAll(sep, '/')
    await input.reviewBackupStore.save(relativePath, content)
  } catch {
    // Best-effort. ENOENT is the ADD case (no prior file to back up) and is the
    // most common path — leaving it implicit avoids tying this helper to fs error
    // codes. Other failures (perms, disk full) also fall through so backup
    // failure never blocks the user's curate.
  }
}

/**
 * Build a `CurateLogEntry` for a single tool-mode curate write.
 *
 * Pure — no I/O. The caller persists via `FileCurateLogStore.save()`.
 * The log entry id MUST be pre-allocated via `store.getNextId()` so the
 * resulting filename matches `FileCurateLogStore`'s `ID_PATTERN`
 * (`cur-<timestamp_ms>`); a random UUID would silently produce an entry
 * that `list()` and `getById()` cannot find.
 *
 * Both the daemon's `curate-html-direct` handler and the CLI's
 * `continueSession` use this helper so the on-disk log shape stays
 * identical regardless of which surface initiated the curate.
 *
 * Review semantics:
 *   - `needsReview` is `meta.impact === 'high' && !reviewDisabled && status === 'success'`.
 *   - `reviewStatus` is `'pending'` when `needsReview`, else undefined.
 *   - On failure the entry is still written (with `status: 'error'`) for
 *     telemetry, but no review surfacing — failed writes aren't actionable
 *     and surfacing them would create noise in `brv review pending`.
 */
export function buildCurateHtmlLogEntry(input: BuildInput): CurateLogEntry {
  const {
    completedAt,
    confirmOverwrite,
    existedBefore,
    filePath,
    id,
    intent,
    meta,
    reviewDisabled,
    startedAt,
    taskId,
    topicPath,
    writeResult,
  } = input

  const operation = writeResult.ok
    ? buildSuccessOperation({confirmOverwrite, existedBefore, filePath, meta, reviewDisabled, topicPath})
    : buildFailureOperation({filePath, meta, topicPath, writeResult})

  const base = {
    format: 'html' as const,
    id,
    input: {context: intent ?? DEFAULT_TOOL_MODE_INTENT},
    operations: [operation],
    startedAt,
    summary: computeSummary([operation]),
    taskId,
  }

  if (writeResult.ok) {
    return {...base, completedAt, status: 'completed'}
  }

  return {
    ...base,
    completedAt,
    error: writeResult.errors.map((e) => `${e.kind}: ${e.message}`).join('\n'),
    status: 'error',
  }
}

function buildSuccessOperation(args: {
  confirmOverwrite: boolean
  existedBefore: boolean
  filePath?: string
  meta?: CurateMeta
  reviewDisabled: boolean
  topicPath?: string
}): CurateLogOperation {
  const {confirmOverwrite, existedBefore, filePath, meta, reviewDisabled, topicPath} = args
  const derivedType = existedBefore && confirmOverwrite ? 'UPDATE' : 'ADD'
  const needsReview = meta?.impact === 'high' && !reviewDisabled

  // Agent-asserted `meta.type` wins over `derivedType` unconditionally —
  // even when on-disk truth contradicts it (e.g. agent says UPDATE but
  // existedBefore=false, possibly because of a topic-path typo on a
  // search-first-then-update flow). We honor the agent's intent because
  // the agent had the user context the writer doesn't have; the on-disk
  // signal is a sanity-check, not an override. The asymmetry is the same
  // reason `impact` has no fallback at all — semantic judgments stay with
  // the agent.
  const op: CurateLogOperation = {
    path: topicPath ?? FALLBACK_PATH,
    status: 'success',
    type: meta?.type ?? derivedType,
  }

  if (filePath !== undefined) op.filePath = filePath
  if (meta?.impact !== undefined) op.impact = meta.impact
  if (meta?.confidence !== undefined) op.confidence = meta.confidence
  if (meta?.reason !== undefined) op.reason = meta.reason
  if (meta?.summary !== undefined) op.summary = meta.summary
  if (meta?.previousSummary !== undefined) op.previousSummary = meta.previousSummary

  // Only emit needsReview when the agent asserted impact. No meta = no
  // review-worthiness judgment, so the field stays undefined rather than
  // an explicit `false` (which would conflate "agent said low" with
  // "agent didn't say anything").
  if (meta?.impact !== undefined) {
    op.needsReview = needsReview
    if (needsReview) op.reviewStatus = 'pending'
  }

  return op
}

function buildFailureOperation(args: {
  filePath?: string
  meta?: CurateMeta
  topicPath?: string
  writeResult: Extract<HtmlWriteResult, {ok: false}>
}): CurateLogOperation {
  const {filePath, meta, topicPath, writeResult} = args

  const op: CurateLogOperation = {
    needsReview: false,
    path: topicPath ?? FALLBACK_PATH,
    status: 'failed',
    type: meta?.type ?? 'ADD',
  }

  if (filePath !== undefined) op.filePath = filePath
  if (meta?.impact !== undefined) op.impact = meta.impact
  if (meta?.confidence !== undefined) op.confidence = meta.confidence
  if (meta?.reason !== undefined) op.reason = meta.reason
  if (meta?.summary !== undefined) op.summary = meta.summary
  if (meta?.previousSummary !== undefined) op.previousSummary = meta.previousSummary

  op.message = writeResult.errors.map((e) => `${e.kind}: ${e.message}`).join('\n')

  return op
}
