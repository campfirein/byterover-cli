/**
 * Tree-walk + sibling helpers.
 *
 * Ports lines 1533-1607 of the Python oracle. Forward-slash paths
 * throughout — the orchestrator stores `rel` strings as POSIX-style
 * for byte-equal report output regardless of host OS.
 */

import {existsSync, readdirSync} from 'node:fs'
import {join, sep} from 'node:path'

import {
  ARCHIVE_DIR,
  MANIFEST_FILE,
  SUMMARY_INDEX_FILE,
} from './constants.js'

export type EntryKind = 'derived' | 'manifest' | 'topic'

/**
 * Returns 'manifest', 'derived', or 'topic'. Called for files NOT in
 * `_archived/` (filtered upstream).
 *
 * `.abstract.md` / `.overview.md` sidecars are classified as derived
 * ONLY when the base `<name>.md` sibling exists in the same dir. A
 * standalone sidecar with no corresponding base is a regular topic.
 */
export function classifyEntry(rel: string, treeFiles: Set<string>): EntryKind {
  const basename = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
  if (basename === MANIFEST_FILE) return 'manifest'
  if (basename === SUMMARY_INDEX_FILE) return 'derived'
  const sidecarMatch = /^(.+?)\.(?:abstract|overview)\.md$/.exec(basename)
  if (sidecarMatch !== null) {
    const prefix = rel.includes('/') ? rel.slice(0, rel.length - basename.length) : ''
    const siblingBase = `${prefix}${sidecarMatch[1]}.md`
    if (treeFiles.has(siblingBase)) return 'derived'
    // Otherwise the sidecar is a standalone topic that happens to end
    // in .abstract.md / .overview.md — treat as a regular topic.
  }

  return 'topic'
}

/**
 * Recursively list every regular file under `treeRoot`, returning
 * forward-slash-normalised relative paths, sorted alphabetically.
 *
 * Skips `_archived/` and any hidden directory (e.g. `.git/`).
 * Hidden files at the root of the tree (e.g. `.snapshot.json`) still
 * pass through and are classified as `unsupported-extension` upstream.
 */
export function listTreeFiles(treeRoot: string): string[] {
  if (!existsSync(treeRoot)) return []
  const out: string[] = []
  walk(treeRoot, '', out)
  // Explicit sort for deterministic report ordering. Node's
  // readdir order is unspecified; Python's `Path.rglob` returns in
  // sorted order on most filesystems but we don't rely on that.
  out.sort()
  return out
}

function walk(root: string, relDir: string, out: string[]): void {
  const fullDir = join(root, relDir)
  let entries
  try {
    entries = readdirSync(fullDir, {withFileTypes: true})
  } catch {
    return
  }

  for (const ent of entries) {
    if (ent.isDirectory()) {
      if (ent.name === ARCHIVE_DIR) continue
      if (ent.name.startsWith('.')) continue
      const childRel = relDir.length === 0 ? ent.name : `${relDir}/${ent.name}`
      walk(root, childRel, out)
      continue
    }

    if (!ent.isFile()) continue
    const rel = relDir.length === 0 ? ent.name : `${relDir}/${ent.name}`
    out.push(rel)
  }
}

/**
 * Map `foo/bar.md` → `<tree-root>/foo/bar.html`.
 *
 * Uses string concatenation rather than Node's `path.extname` swap
 * because a legitimate topic filename like `node.js.md` would
 * otherwise lose the `.js` segment and mismatch the `<bv-topic path>`
 * attribute the writer produces.
 */
export function htmlSiblingPath(treeRoot: string, relMd: string): string {
  const relHtml = `${relMd.slice(0, -3)}.html`
  // Build with the host separator since this is a filesystem path,
  // not a bv-topic `path` attribute.
  return join(treeRoot, ...relHtml.split('/'))
}

export function htmlSiblingExists(treeRoot: string, relMd: string): boolean {
  if (!relMd.endsWith('.md')) return false
  return existsSync(htmlSiblingPath(treeRoot, relMd))
}

/** Convert a host path back to POSIX form for report output. */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}
