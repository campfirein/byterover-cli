/**
 * Events for `brv migrate` — markdown → bv-topic HTML conversion.
 *
 * Two operations:
 *   - RUN: forward migration (apply or dry-run)
 *   - ROLLBACK: reverse the most recent migration (apply or dry-run);
 *     a dry-run request returns the same payload shape and is used by
 *     the CLI as the interactive confirmation preview.
 *
 * Requests carry NO `projectRoot`. The daemon resolves the caller's
 * project from the registered clientId via the standard
 * `ProjectPathResolver` (mirrors ResetHandler / VcHandler). Field names
 * are camelCase per TS convention.
 */

export const MigrateEvents = {
  ROLLBACK: 'migrate:rollback',
  RUN: 'migrate:run',
} as const

export interface MigrateRunRequest {
  dryRun: boolean
}

export interface MigrateRunReportFileEntry {
  archivePath?: string
  htmlPath?: string
  outcome: 'archived' | 'failed' | 'migrated' | 'skipped'
  reason?: string
  sourceRelPath: string
  warnings?: string[]
}

export interface MigrateRunReport {
  archiveRoot: string | undefined
  completedAt: string
  dryRun: boolean
  files: MigrateRunReportFileEntry[]
  projectRoot: string
  startedAt: string
  summary: {archived: number; failed: number; migrated: number; skipped: number}
}

export interface MigrateRunResponse {
  report: MigrateRunReport
}

export interface MigrateRollbackRequest {
  dryRun: boolean
}

export interface MigrateRollbackResponse {
  archiveRoot: string
  completedAt: string
  deletedHtml: string[]
  dryRun: boolean
  preservedHtml: string[]
  projectRoot: string
  restored: number
  /**
   * `.html` siblings that would have been deleted but were kept because
   * the preserve manifest was missing/unreadable. The CLI surfaces a
   * summary count on stderr (text mode) or via the full list in the
   * JSON envelope.
   */
  skippedHtml: string[]
  startedAt: string
  /**
   * Operator-visible warnings raised inside the daemon (e.g. missing /
   * unreadable `_pre_existing_html_siblings.json` manifest). The CLI
   * must surface these on stderr or in the `--format json` envelope —
   * daemon stderr is invisible to the CLI user.
   */
  warnings: string[]
}
