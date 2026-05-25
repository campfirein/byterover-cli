/**
 * Derived-artifact predicates for the Hierarchical DAG architecture.
 *
 * Three predicates with clear separation of concerns:
 * - isDerivedArtifact()  — non-searchable derived content (excluded from query fingerprint)
 * - isArchiveStub()      — searchable stubs (included in BM25 index and fingerprint)
 * - isExcludedFromSync() — union of above (excluded from snapshot/sync/merge/push)
 */

import {ABSTRACT_EXTENSION, ARCHIVE_DIR, FULL_ARCHIVE_EXTENSION, MANIFEST_FILE, OVERVIEW_EXTENSION, STUB_EXTENSION, SUMMARY_INDEX_FILE} from '../../constants.js'
import {toUnixPath} from './path-utils.js'

/**
 * Returns true if the given relative path is a derived artifact
 * that should be excluded from snapshot tracking, CoGit sync,
 * and query cache fingerprinting.
 *
 * Derived artifacts: _index.md, _manifest.json, _archived/*.full.md
 * NOTE: _archived/*.stub.md are NOT derived — they are searchable.
 */
export function isDerivedArtifact(relativePath: string): boolean {
  const normalized = toUnixPath(relativePath)
  const segments = normalized.split('/')
  const fileName = segments.at(-1) ?? ''

  if (fileName === SUMMARY_INDEX_FILE) return true

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
 * Returns true if the path is a channel turn artifact —
 * `channel/<id>/turns/<turnId>/**` — i.e. ephemeral per-turn ACP state
 * (events.jsonl, turn.json, deliveries/*.json). These are excluded from
 * sync but are deliberately NOT classified as derived artifacts: query,
 * manifest, archive and summary paths consume `isDerivedArtifact`, and
 * we do not want to hide channel turn logs from those surfaces — only
 * from CoGit/snapshot/sync. The channel's own `meta.json` (durable
 * definition: members, capabilities, settings) is kept synced.
 *
 * Slice 8.7 — Phase 8 follow-up. See
 * `plan/channel-protocol/IMPLEMENTATION_PHASE_8_FOLLOWUPS.md` §"Slice 8.7".
 *
 * @deprecated Slice 9.5. Phase 9 relocated channel turn transcripts to
 * `.brv/channel-history/<channelId>/turns/<turnId>.ndjson`, which is
 * structurally outside the cogit-scanned `.brv/context-tree/` root and
 * needs no predicate filter. Legacy `<channelDir>/turns/<turnId>/`
 * subdirs are now retentioned by `ChannelTranscriptGc.sweepLegacyMount`.
 * This predicate remains load-bearing only until any host's pre-Phase-9
 * legacy turn directory has aged out via GC — once that's confirmed for
 * the wild (target removal: 2026-08), the predicate + its branch in
 * `isExcludedFromSync` can be deleted in a follow-up. Do NOT add new
 * call sites.
 */
export function isChannelTurnArtifact(relativePath: string): boolean {
  const normalized = toUnixPath(relativePath)
  const segments = normalized.split('/')
  return segments[0] === 'channel' && segments[2] === 'turns'
}

/**
 * Returns true if the path should be excluded from snapshot tracking,
 * CoGit sync (push/pull/merge), and writer operations.
 * This includes ALL derived artifacts plus searchable stubs plus
 * channel turn artifacts (per-turn ephemeral ACP state).
 */
export function isExcludedFromSync(relativePath: string): boolean {
  return isDerivedArtifact(relativePath) || isArchiveStub(relativePath) || isChannelTurnArtifact(relativePath)
}
