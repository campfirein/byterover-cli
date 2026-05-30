/**
 * Derived-artifact predicates for the Hierarchical DAG architecture.
 *
 * Three predicates with clear separation of concerns:
 * - isDerivedArtifact()  — non-searchable derived content (excluded from query fingerprint)
 * - isArchiveStub()      — searchable stubs (included in BM25 index and fingerprint)
 * - isExcludedFromSync() — derived + stubs that should NOT participate in snapshot/sync/merge/push.
 *                          index.html is the one derived artifact that IS synced so peers can
 *                          consume the latest navigation index without running `brv index rebuild`.
 */

import {ABSTRACT_EXTENSION, ARCHIVE_DIR, FULL_ARCHIVE_EXTENSION, INDEX_HTML_FILE, MANIFEST_FILE, OVERVIEW_EXTENSION, STUB_EXTENSION, SUMMARY_INDEX_FILE} from '../../constants.js'
import {toUnixPath} from './path-utils.js'

/**
 * Returns true if the given relative path is a derived artifact
 * that should be excluded from snapshot tracking, CoGit sync,
 * and query cache fingerprinting.
 *
 * Derived artifacts: _index.md, index.html, _manifest.json, _archived/*.full.md
 * NOTE: _archived/*.stub.md are NOT derived — they are searchable.
 */
export function isDerivedArtifact(relativePath: string): boolean {
  const normalized = toUnixPath(relativePath)
  const segments = normalized.split('/')
  const fileName = segments.at(-1) ?? ''

  if (fileName === SUMMARY_INDEX_FILE) return true

  // Tool-mode context-tree index. Root-only match — only the generator-written
  // `index.html` at the tree root is a navigation artifact. A user-authored
  // topic like `architecture/index.html` is a normal searchable topic, NOT
  // derived. (Legacy `_index.*` / `_manifest.json` keep basename matching:
  // the underscore prefix makes collisions effectively impossible.)
  if (normalized === INDEX_HTML_FILE) return true

  if (fileName === MANIFEST_FILE) return true

  if (fileName.endsWith(ABSTRACT_EXTENSION)) return true

  if (fileName.endsWith(OVERVIEW_EXTENSION)) return true

  if (segments.includes(ARCHIVE_DIR) && fileName.endsWith(FULL_ARCHIVE_EXTENSION)) return true

  return false
}

/**
 * Returns true if the path is an archive stub (.stub.md inside _archived/).
 * Stubs are searchable but excluded from snapshot/sync.
 */
export function isArchiveStub(relativePath: string): boolean {
  const normalized = toUnixPath(relativePath)
  const segments = normalized.split('/')
  const fileName = segments.at(-1) ?? ''

  return segments.includes(ARCHIVE_DIR) && fileName.endsWith(STUB_EXTENSION)
}

/**
 * Returns true if the path should be excluded from snapshot tracking,
 * CoGit sync (push/pull/merge), and writer operations.
 *
 * index.html is intentionally NOT excluded: it is derived but tracked so
 * peers consume the latest navigation index without running rebuild.
 */
export function isExcludedFromSync(relativePath: string): boolean {
  // Root-only — see `isDerivedArtifact` for the rationale on matching `index.html`
  // exactly at the tree root rather than by basename anywhere in the tree.
  if (toUnixPath(relativePath) === INDEX_HTML_FILE) return false
  return isDerivedArtifact(relativePath) || isArchiveStub(relativePath)
}
