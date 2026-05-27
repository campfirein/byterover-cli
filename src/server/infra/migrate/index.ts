/**
 * Public exports for the migrator service.
 */

export {convertMarkdownTopicToHtml} from './convert.js'
export type {ConvertInput, ConvertResult} from './convert.js'
export {rollback, runMigration, summarizeReport} from './orchestrator.js'
export type {RollbackInput, RunMigrationInput} from './orchestrator.js'
export type {
  FileEntry,
  FileOutcome,
  MigrationReport,
  MigrationSummary,
  RollbackReport,
} from './types.js'
