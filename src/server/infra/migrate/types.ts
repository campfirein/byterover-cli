/**
 * Shared types for the migrator service.
 *
 * Report JSON shape mirrors the Python oracle's `run_migration` /
 * `rollback` outputs so a downstream differential test can compare
 * native shapes after dynamic-field normalization.
 */

export type FileOutcome = 'archived' | 'failed' | 'migrated' | 'skipped'

export type FileEntry = {
  archivePath?: string
  htmlPath?: string
  outcome: FileOutcome
  reason?: string
  sourceRelPath: string
  warnings?: string[]
}

export type MigrationSummary = {
  archived: number
  failed: number
  migrated: number
  skipped: number
}

export type MigrationReport = {
  archiveRoot: string | undefined
  completedAt: string
  dryRun: boolean
  files: FileEntry[]
  projectRoot: string
  startedAt: string
  summary: MigrationSummary
}

export type RollbackReport = {
  archiveRoot: string
  completedAt: string
  deletedHtml: string[]
  dryRun: boolean
  preservedHtml: string[]
  projectRoot: string
  restored: number
  /**
   * `.html` siblings that would have been deleted but were kept because
   * the preserve manifest was missing or unreadable — we don't know
   * which of them genuinely pre-existed the migration, so refusing to
   * delete is the safe default. Operator can review this list and
   * remove them manually if no longer needed.
   */
  skippedHtml: string[]
  startedAt: string
  /**
   * Operator-visible warnings raised during rollback (e.g. missing or
   * unreadable `_pre_existing_html_siblings.json` manifest). Returned
   * to the CLI so the user sees them — daemon stderr is invisible to
   * the caller.
   */
  warnings: string[]
}
