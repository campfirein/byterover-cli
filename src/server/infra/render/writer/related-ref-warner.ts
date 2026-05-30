import {statSync} from 'node:fs'
import path from 'node:path'

/**
 * Read-only resolver for `<bv-topic related="...">` refs.
 *
 * The agent has no filesystem view of `.brv/context-tree/`, so even a
 * well-prompted agent can mistype a path or reference a topic that
 * hasn't been written yet. This walks each comma-separated ref and
 * surfaces a warning when the form the agent wrote is broken: the
 * suffix IS the choice (`.html` → file form, bare → folder form), and
 * the FE routes by suffix. So a `.html` ref must point at a file that
 * exists; a bare ref must point at a folder that exists. The other
 * on-disk shape is irrelevant — probing both would silently accept
 * dead-pill scenarios (e.g. `.html` ref + only folder on disk).
 *
 * The warner never mutates the attribute and never rejects the write
 * — refs are advisory metadata, and a "forward reference" to a topic
 * about to be curated is legit.
 *
 * Parsing is permissive: leading `@` and surrounding whitespace are
 * stripped, empty entries are skipped. Path segments containing `..`
 * or `.` are rejected as unsafe without touching the filesystem.
 */
export function computeRelatedWarnings(options: {
  contextTreeRoot: string
  relatedAttr: string | undefined
}): readonly string[] {
  const {contextTreeRoot, relatedAttr} = options
  if (!relatedAttr || relatedAttr.trim().length === 0) return []

  const warnings: string[] = []
  for (const rawEntry of relatedAttr.split(',')) {
    const entry = rawEntry.trim()
    if (entry.length === 0) continue

    const warning = checkRef({contextTreeRoot, originalRef: entry})
    if (warning !== undefined) warnings.push(warning)
  }

  return warnings
}

/**
 * Resolve a single ref against the context-tree root. Returns either
 * undefined (clean) or a single warning string.
 */
function checkRef(options: {contextTreeRoot: string; originalRef: string}): string | undefined {
  const {contextTreeRoot, originalRef} = options

  const stripped = originalRef.startsWith('@') ? originalRef.slice(1) : originalRef
  const wantsFile = stripped.endsWith('.html')
  const withoutExt = wantsFile ? stripped.slice(0, -'.html'.length) : stripped

  // Reject `.` and `..` segments before any filesystem access. The check
  // must happen on the path the user wrote, not on a normalised form,
  // so an attempted traversal surfaces as `unsafe` rather than `not found`.
  const segments = withoutExt.replaceAll('\\', '/').split('/').filter((s) => s.length > 0)
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      return `related ref "${originalRef}" contains an unsafe path segment ("${segment}") and was not resolved`
    }
  }

  if (segments.length === 0) {
    return `related ref "${originalRef}" is empty after stripping the leading "@" and is invalid`
  }

  const relative = segments.join('/')
  const candidate = wantsFile
    ? path.resolve(contextTreeRoot, `${relative}.html`)
    : path.resolve(contextTreeRoot, relative)

  // Defence in depth: even after segment filtering, the resolved path
  // must remain inside the context-tree root. A symlink in `contextTreeRoot`
  // could theoretically escape; reject any resolution that does.
  const rootResolved = path.resolve(contextTreeRoot)
  if (!isInsideRoot(candidate, rootResolved)) {
    return `related ref "${originalRef}" resolves outside the context-tree root and was not checked`
  }

  // Stat-only probe: any error (ENOENT, EACCES, EBUSY, a mid-curate
  // deletion, …) is treated as "not present" so the warner stays
  // advisory after a successful write. It runs post-write — its job is
  // to surface refs, not to fail the operation — so an unprovable
  // target is reported as broken rather than thrown. Probe only the
  // shape the agent chose: a `.html` ref against a folder (or a bare
  // ref against a file) is a dead pill the FE cannot route, so it
  // must surface even when the "other" shape happens to exist.
  if (wantsFile) {
    if (safeStatIsFile(candidate)) return undefined
    return `related ref "${originalRef}" was not found — no file at "${relative}.html" under the context tree`
  }

  if (safeStatIsDir(candidate)) return undefined
  return `related ref "${originalRef}" was not found — no folder at "${relative}/" under the context tree (bare refs target folders; add ".html" if you meant a file)`
}

function isInsideRoot(candidate: string, rootResolved: string): boolean {
  return candidate === rootResolved || candidate.startsWith(rootResolved + path.sep)
}

function safeStatIsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function safeStatIsDir(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}
