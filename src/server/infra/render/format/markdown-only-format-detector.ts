import type {QueryLogMatchedDoc} from '../../../core/domain/entities/query-log-entry.js'
import type {IFormatDetector} from '../../../core/interfaces/render/i-format-detector.js'

/**
 * Pre-migration `IFormatDetector` stub. Always reports `'markdown'` when any
 * docs are present, `undefined` when none. Kept around for tests that pin
 * the pre-HTML-migration shape; production wires `ExtensionAwareFormatDetector`.
 */
export class MarkdownOnlyFormatDetector implements IFormatDetector {
  public detect(matchedDocs: readonly QueryLogMatchedDoc[]): 'html' | 'markdown' | undefined {
    if (matchedDocs.length === 0) return undefined
    return 'markdown'
  }
}
