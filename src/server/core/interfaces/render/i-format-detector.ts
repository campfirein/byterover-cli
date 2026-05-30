import type {QueryLogMatchedDoc} from '../../domain/entities/query-log-entry.js'

/**
 * Strategy for deciding the `format` field on a populated `QueryLogEntry`.
 * Receives the docs the recall touched and reports `'html'`, `'markdown'`,
 * or `undefined` (no docs touched).
 *
 * Production binding is `ExtensionAwareFormatDetector` — inspects each
 * `matchedDoc.path` extension. `MarkdownOnlyFormatDetector` is the
 * pre-migration stub kept around for tests that pin legacy behaviour.
 */
export interface IFormatDetector {
  detect(matchedDocs: readonly QueryLogMatchedDoc[]): 'html' | 'markdown' | undefined
}
