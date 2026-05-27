/* eslint-disable camelcase -- preserve_html_siblings is the on-disk JSON key written by the Python oracle; the manifest format is the wire contract and snake_case is intentional. */
/**
 * Migrator orchestrator — ports lines 1625-1913 of the Python oracle.
 *
 * Public API:
 *   - `runMigration({projectRoot, dryRun})` walks `.brv/context-tree/`
 *     and migrates every topic. Returns a structured report.
 *   - `rollback({projectRoot, dryRun})` reverses the most recent
 *     migration: restores archived files, deletes generated HTML
 *     siblings (except those that predated migration), removes the
 *     archive folder.
 *   - `summarizeReport(report)` returns the single-line status string
 *     the CLI prints.
 *
 * On-disk format compatibility:
 *   - Archive directory: `.brv/_migrations/context-tree-md-<YYYY-MM-DD>/`
 *   - Pre-existing-HTML manifest: `_pre_existing_html_siblings.json`
 *     at the archive root, written BEFORE archiving (Ctrl+C-safe),
 *     always — even when the preserve list is empty — so rollback's
 *     "no preserve list" warning is only fired when something
 *     genuinely went wrong.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  
} from 'node:fs'
import {join, relative} from 'node:path'

import type {FileEntry, MigrationReport, RollbackReport} from './types.js'

import {
  classifyEntry,
  htmlSiblingExists,
  htmlSiblingPath,
  listTreeFiles,
  toPosix,
} from './classify.js'
import {
  ARCHIVE_FOLDER_PREFIX,
  BRV_DIR,
  CONTEXT_TREE_DIR,
  MANIFEST_FILE,
  MIGRATIONS_DIR,
  PRE_EXISTING_HTML_MANIFEST,
} from './constants.js'
import {convertMarkdownTopicToHtml} from './convert.js'
import {moveFile, writeAtomic} from './io.js'

function nowIsoUtc(): string {
  return new Date().toISOString()
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10) // YYYY-MM-DD
}

function archiveFailed(
  sourceAbs: string,
  archiveAbs: string,
  rel: string,
  reason: string,
  dryRun: boolean,
): FileEntry {
  const entry: FileEntry = {outcome: 'failed', reason, sourceRelPath: rel}
  if (dryRun) return entry
  try {
    moveFile(sourceAbs, archiveAbs)
    entry.archivePath = archiveAbs
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error)
    entry.reason = `${reason}; archive-move-error: ${err}`
  }

  return entry
}

function processFile(input: {
  archiveRoot: string
  dryRun: boolean
  rel: string
  treeFiles: Set<string>
  treeRoot: string
}): FileEntry {
  const {archiveRoot, dryRun, rel, treeFiles, treeRoot} = input
  const basename = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
  if (!basename.endsWith('.md') && basename !== MANIFEST_FILE) {
    return {outcome: 'skipped', reason: 'unsupported-extension', sourceRelPath: rel}
  }

  const kind = classifyEntry(rel, treeFiles)
  const sourceAbs = join(treeRoot, ...rel.split('/'))
  const archiveAbs = join(archiveRoot, ...rel.split('/'))

  if (kind === 'manifest' || kind === 'derived') {
    if (!dryRun) moveFile(sourceAbs, archiveAbs)
    return {
      archivePath: archiveAbs,
      outcome: 'archived',
      reason: kind,
      sourceRelPath: rel,
    }
  }

  // kind === 'topic'
  if (htmlSiblingExists(treeRoot, rel)) {
    if (!dryRun) moveFile(sourceAbs, archiveAbs)
    return {
      archivePath: archiveAbs,
      outcome: 'archived',
      reason: 'html-sibling-exists',
      sourceRelPath: rel,
    }
  }

  let markdown: string
  try {
    markdown = readFileSync(sourceAbs, 'utf8')
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error)
    return archiveFailed(sourceAbs, archiveAbs, rel, `read-error: ${err}`, dryRun)
  }

  if (markdown.trim().length === 0) {
    // Empty standalone topic — surface as failed so the operator can
    // decide whether to delete or fill in. Standalone sidecars (`*.abstract.md`
    // / `*.overview.md` with no base `<name>.md` in the same directory)
    // also reach this branch: `classifyEntry` keeps them as `'topic'`
    // because there's nothing to derive from, and the empty-body check
    // here flags them so the operator sees them.
    return archiveFailed(sourceAbs, archiveAbs, rel, 'empty-file', dryRun)
  }

  const {mtimeMs} = statSync(sourceAbs)
  let result
  try {
    result = convertMarkdownTopicToHtml({markdown, mtimeMs, relPath: rel})
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error)
    return archiveFailed(sourceAbs, archiveAbs, rel, `convert-error: ${err}`, dryRun)
  }

  const htmlAbs = htmlSiblingPath(treeRoot, rel)
  if (dryRun) {
    const entry: FileEntry = {
      htmlPath: htmlAbs,
      outcome: 'migrated',
      sourceRelPath: rel,
    }
    if (result.warnings.length > 0) entry.warnings = result.warnings
    return entry
  }

  let htmlWritten = false
  try {
    writeAtomic(htmlAbs, result.html)
    htmlWritten = true
    moveFile(sourceAbs, archiveAbs)
  } catch (error: unknown) {
    const err = error instanceof Error ? error.message : String(error)
    // Best-effort cleanup of the just-written HTML sibling when the
    // archive move fails (e.g. EXDEV copy/unlink raised partway). Without
    // this, a re-run sees the orphaned `<name>.html`, classifies the
    // `.md` as `html-sibling-exists`, and silently archives it without
    // re-converting — operator loses their recovery path. Ignore unlink
    // errors; the goal is "consistent with never-migrated", not strict.
    if (htmlWritten) {
      try {
        unlinkSync(htmlAbs)
      } catch {
        // intentionally swallowed — best-effort
      }
    }

    return archiveFailed(sourceAbs, archiveAbs, rel, `write-error: ${err}`, dryRun)
  }

  const entry: FileEntry = {
    archivePath: archiveAbs,
    htmlPath: htmlAbs,
    outcome: 'migrated',
    sourceRelPath: rel,
  }
  if (result.warnings.length > 0) entry.warnings = result.warnings
  return entry
}

export type RunMigrationInput = {
  dryRun?: boolean
  projectRoot: string
}

export function runMigration(input: RunMigrationInput): MigrationReport {
  const {dryRun = false, projectRoot} = input
  const startedAt = nowIsoUtc()
  const treeRoot = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR)

  const report: MigrationReport = {
    archiveRoot: undefined,
    completedAt: '',
    dryRun,
    files: [],
    projectRoot,
    startedAt,
    summary: {archived: 0, failed: 0, migrated: 0, skipped: 0},
  }

  if (!existsSync(treeRoot)) {
    report.completedAt = nowIsoUtc()
    return report
  }

  const archiveRoot = join(
    projectRoot,
    BRV_DIR,
    MIGRATIONS_DIR,
    `${ARCHIVE_FOLDER_PREFIX}${todayUtc()}`,
  )

  // Refuse to re-enter a day's archive that already exists. A second run
  // on the same UTC day would overwrite the preserve manifest and mix
  // archived `.md` files from both runs, silently destroying pre-existing
  // `.html` siblings on a later rollback. The Python oracle has the same
  // bug — we diverge here deliberately because the failure is silent and
  // non-undoable. Sentinel phrase 'Migration already ran today' is matched
  // by the CLI to render a clean message instead of "Unexpected error:".
  // Gated on `!dryRun` because dry-run is documented as in-memory only —
  // an existing archive isn't a hazard when nothing will be written.
  if (!dryRun && existsSync(archiveRoot)) {
    throw new Error(
      `Migration already ran today; archive at ${archiveRoot} already exists. ` +
        'Run `brv migrate --rollback` to undo the previous run before migrating again, ' +
        'or move/delete the archive directory manually if you are sure it is safe.',
    )
  }

  report.archiveRoot = archiveRoot

  const treeFilesList = listTreeFiles(treeRoot)
  const treeFilesSet = new Set(treeFilesList)

  // Compute + write the preserve list BEFORE archiving anything.
  // Ctrl+C safety: a killed process still leaves a usable preserve
  // manifest on disk so rollback won't delete pre-existing siblings.
  const preExisting = treeFilesList
    .filter((rel) => rel.endsWith('.md') && htmlSiblingExists(treeRoot, rel))
    .sort()
  if (!dryRun) {
    const manifestPath = join(archiveRoot, PRE_EXISTING_HTML_MANIFEST)
    writeAtomic(
      manifestPath,
      `${JSON.stringify({preserve_html_siblings: preExisting}, null, 2)}\n`,
    )
    // writeAtomic uses `${target}.tmp + rename`. JSON.stringify with
    // indent=2 + trailing newline matches Python's
    // `json.dumps(..., indent=2)` (which doesn't add a trailing
    // newline). Adjust if differential tests show drift.
  }

  for (const rel of treeFilesList) {
    const entry = processFile({
      archiveRoot,
      dryRun,
      rel,
      treeFiles: treeFilesSet,
      treeRoot,
    })
    report.files.push(entry)
    report.summary[entry.outcome]++
  }

  report.completedAt = nowIsoUtc()
  return report
}

export type RollbackInput = {
  dryRun?: boolean
  projectRoot: string
}

/**
 * Throws `Error` when there's no archive to roll back.
 */
export function rollback(input: RollbackInput): RollbackReport {
  const {dryRun = false, projectRoot} = input
  const startedAt = nowIsoUtc()
  const migrationsDir = join(projectRoot, BRV_DIR, MIGRATIONS_DIR)
  const treeRoot = join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR)

  const archives = existsSync(migrationsDir)
    ? readdirSync(migrationsDir, {withFileTypes: true})
        .filter((e) => e.isDirectory() && e.name.startsWith(ARCHIVE_FOLDER_PREFIX))
        .map((e) => join(migrationsDir, e.name))
        .sort()
    : []
  const archiveRoot = archives.at(-1)
  if (archiveRoot === undefined) {
    // Sentinel string the CLI matches on to render a clean message
    // (instead of "Unexpected error: ..." via formatConnectionError).
    // Keeps Python exit-code parity (oracle raises RuntimeError → exit 1).
    throw new Error(
      'No archive to roll back. Run `brv migrate` first.',
    )
  }


  // Load the pre-existing-HTML preserve list. `manifestMissing` is true
  // only when the file is genuinely absent or unparseable — a valid but
  // empty `{"preserve_html_siblings": []}` stays false (common case: no
  // pre-existing siblings, deletion proceeds normally). When truly
  // missing, we skip `.html` deletion entirely to avoid destroying
  // pre-existing content we have no record of.
  const warnings: string[] = []
  let preserveHtmlSiblings = new Set<string>()
  let manifestMissing = false
  const manifestPath = join(archiveRoot, PRE_EXISTING_HTML_MANIFEST)
  if (existsSync(manifestPath)) {
    try {
      const raw = readFileSync(manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as {preserve_html_siblings?: unknown}
      const list = parsed.preserve_html_siblings
      // Require every element to be a string. Silently filtering
      // non-strings here would let a malformed manifest like
      // `{"preserve_html_siblings": [123]}` look valid-but-empty after
      // the filter, leaving `manifestMissing=false` and proceeding to
      // delete .html siblings — defeating the whole point of the safety
      // check. Treat any non-string element as corrupt.
      if (Array.isArray(list) && list.every((x) => typeof x === 'string')) {
        preserveHtmlSiblings = new Set(list)
      } else {
        manifestMissing = true
        const reason = Array.isArray(list)
          ? 'contains non-string entries'
          : 'has unexpected shape (preserve_html_siblings is not an array)'
        warnings.push(
          `preserve-list manifest at ${manifestPath} ${reason}; pre-existing .html siblings will be preserved by skipping deletion`,
        )
      }
    } catch (error: unknown) {
      manifestMissing = true
      const err = error instanceof Error ? error.message : String(error)
      warnings.push(
        `preserve-list manifest at ${manifestPath} is unreadable (${err}); pre-existing .html siblings will be preserved by skipping deletion`,
      )
    }
  } else {
    manifestMissing = true
    warnings.push(
      `no preserve-list manifest at ${manifestPath} — either this archive predates the manifest feature or the prior migration was interrupted before it was written. Pre-existing .html siblings will be preserved by skipping deletion`,
    )
  }

  const restored: string[] = []
  const deletedHtml: string[] = []
  const preservedHtml: string[] = []
  const skippedHtml: string[] = []

  const archivedFiles = listAllFiles(archiveRoot).sort()
  for (const archivedAbs of archivedFiles) {
    const rel = toPosix(relative(archiveRoot, archivedAbs))
    if (rel === PRE_EXISTING_HTML_MANIFEST) continue
    const target = join(treeRoot, ...rel.split('/'))
    if (!dryRun) moveFile(archivedAbs, target)
    restored.push(rel)

    if (rel.endsWith('.md')) {
      const htmlSibling = htmlSiblingPath(treeRoot, rel)
      if (preserveHtmlSiblings.has(rel)) {
        preservedHtml.push(rel)
        continue
      }

      // When the manifest is missing/corrupt we can't tell pre-existing
      // from migrator-generated siblings — record what WOULD have been
      // deleted in `skippedHtml` and leave the file in place for the
      // operator to inspect.
      if (manifestMissing) {
        if (existsSync(htmlSibling)) skippedHtml.push(htmlSibling)
        continue
      }

      if (existsSync(htmlSibling)) {
        if (!dryRun) unlinkSync(htmlSibling)
        deletedHtml.push(htmlSibling)
      }
    }
  }

  if (!dryRun) rmSync(archiveRoot, {force: true, recursive: true})

  if (manifestMissing && skippedHtml.length > 0) {
    warnings.push(
      `skipped deletion of ${skippedHtml.length} .html sibling(s) because the preserve manifest was unavailable — remove them manually if no longer needed`,
    )
  }

  return {
    archiveRoot,
    completedAt: nowIsoUtc(),
    deletedHtml,
    dryRun,
    preservedHtml,
    projectRoot,
    restored: restored.length,
    skippedHtml,
    startedAt,
    warnings,
  }
}

function listAllFiles(root: string): string[] {
  const out: string[] = []
  if (!existsSync(root)) return out
  walkFiles(root, out)
  return out
}

function walkFiles(dir: string, out: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, {withFileTypes: true})
  } catch {
    return
  }

  for (const ent of entries) {
    const full = join(dir, ent.name)
    if (ent.isDirectory()) {
      walkFiles(full, out)
    } else if (ent.isFile()) {
      out.push(full)
    }
  }
}

export function summarizeReport(report: MigrationReport): string {
  const {summary} = report
  const mode = report.dryRun ? 'dry-run' : 'applied'
  return `[${mode}] migrated=${summary.migrated} archived=${summary.archived} skipped=${summary.skipped} failed=${summary.failed}`
}

