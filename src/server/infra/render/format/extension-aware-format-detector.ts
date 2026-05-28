import type {QueryLogMatchedDoc} from '../../../core/domain/entities/query-log-entry.js'
import type {IFormatDetector} from '../../../core/interfaces/render/i-format-detector.js'

import {getFormatForRead} from './format-detector.js'

/**
 * Default `IFormatDetector` binding post-HTML migration. Inspects the path
 * extension of each matched doc and reports `'html'` when at least one
 * `.html`/`.htm` topic was retrieved, `'markdown'` for a legacy-only recall,
 * and `undefined` for an empty recall (cache hit, OOD short-circuit, tier 4
 * LLM-only response).
 *
 * The single-`'html'` policy is deliberate: post-migration HTML is the new
 * emission format and any HTML doc in the recall is the load-bearing signal
 * for telemetry rollups. Reporting `'markdown'` for a mixed result would
 * hide HTML traffic from cost / coverage dashboards.
 *
 * Replaces {@link MarkdownOnlyFormatDetector} as the wired default. The stub
 * is retained for tests that pin the pre-migration behaviour.
 */
export class ExtensionAwareFormatDetector implements IFormatDetector {
  public detect(matchedDocs: readonly QueryLogMatchedDoc[]): 'html' | 'markdown' | undefined {
    if (matchedDocs.length === 0) return undefined
    for (const doc of matchedDocs) {
      if (getFormatForRead(stripSharedAlias(doc.path)) === 'html') return 'html'
    }

    return 'markdown'
  }
}

/**
 * Shared-source paths are namespaced as `[alias]:<rel-path>`. The read-side
 * `getFormatForRead` only understands filesystem-style paths, so strip the
 * alias before delegation. Local paths pass through unchanged.
 *
 * Defense-in-depth note: today `path.extname` would still return the right
 * extension on a `[alias]:rel/path.html` input because the colon lives in
 * the dirname segment and `extname` operates on the basename. The helper is
 * kept anyway so (a) the detector's contract stays independent of
 * `getFormatForRead`'s internals — e.g. if it ever switches to URL-style
 * parsing the alias prefix would break it, and (b) the alias-stripping
 * branch is testable in isolation.
 */
function stripSharedAlias(p: string): string {
  if (!p.startsWith('[')) return p
  const colon = p.indexOf(':')
  return colon === -1 ? p : p.slice(colon + 1)
}
