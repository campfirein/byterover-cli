/**
 * Topic loader for tool-mode dream.
 *
 * Walks `.brv/context-tree/` recursively, parses the `<bv-topic>` root of
 * each `.html` file, and combines the resulting metadata with sidecar
 * signals + file mtime so the per-kind candidate generators have a single
 * input shape to work from.
 *
 * Best-effort: malformed / empty files are skipped (not thrown). Hidden
 * dirs (`.git`, `.archive`, etc.) are skipped to avoid pulling in
 * git-internal HTML files or archived content.
 */

import {readdir, readFile, stat} from 'node:fs/promises'
import {join, relative, sep} from 'node:path'

import type {RuntimeSignals} from '../../../core/domain/knowledge/runtime-signals-schema.js'
import type {IRuntimeSignalStore} from '../../../core/interfaces/storage/i-runtime-signal-store.js'

import {createDefaultRuntimeSignals} from '../../../core/domain/knowledge/runtime-signals-schema.js'

/**
 * Combined topic record used as the source-of-truth for every candidate
 * generator. Each generator projects this down to its own input shape.
 */
export type ToolModeTopic = {
  /** Full raw HTML. */
  html: string
  /** File modification time in ms since epoch. */
  mtimeMs: number
  /** Path under `.brv/context-tree/`, forward-slash normalized (e.g. `security/jwt.html`). */
  path: string
  /** Parsed `related=` attribute, lowercase paths. Empty if not present. */
  related: string[]
  /** Sidecar signals (falls back to defaults when the path has no sidecar entry). */
  signals: RuntimeSignals
  /** Parsed `summary=` attribute, or empty string. */
  summary: string
  /** Parsed `title=` attribute. */
  title: string
}

const BV_TOPIC_RE = /<bv-topic\b([^>]*)>/i

export async function loadToolModeTopics(params: {
  contextTreeRoot: string
  runtimeSignalStore: IRuntimeSignalStore
}): Promise<ToolModeTopic[]> {
  const {contextTreeRoot, runtimeSignalStore} = params

  let signalsByPath: Map<string, RuntimeSignals>
  try {
    signalsByPath = await runtimeSignalStore.list()
  } catch {
    signalsByPath = new Map()
  }

  const htmlFiles: string[] = []
  await walkHtmlFiles(contextTreeRoot, htmlFiles)

  const topics = await Promise.all(htmlFiles.map((absolutePath) => loadOne(absolutePath, contextTreeRoot, signalsByPath)))

  return topics.filter((t): t is ToolModeTopic => t !== undefined)
}

async function walkHtmlFiles(rootDir: string, accumulator: string[], current?: string): Promise<void> {
  const dir = current ?? rootDir
  let entries
  try {
    entries = await readdir(dir, {withFileTypes: true})
  } catch {
    return
  }

  const subwalks: Array<Promise<void>> = []
  for (const entry of entries) {
    // Skip dot-prefixed dirs (.git, .DS_Store, etc.). Topics under dot-dirs
    // are not supported. NOTE: archived topics live at .brv/archive/ (a
    // sibling of context-tree/), not inside context-tree itself, so this
    // walker would not encounter them regardless.
    if (entry.name.startsWith('.')) continue
    const next = join(dir, entry.name)
    if (entry.isDirectory()) {
      subwalks.push(walkHtmlFiles(rootDir, accumulator, next))
      continue
    }

    if (entry.isFile() && entry.name.endsWith('.html')) {
      accumulator.push(next)
    }
  }

  await Promise.all(subwalks)
}

async function loadOne(
  absolutePath: string,
  contextTreeRoot: string,
  signalsByPath: Map<string, RuntimeSignals>,
): Promise<ToolModeTopic | undefined> {
  let html: string
  try {
    html = await readFile(absolutePath, 'utf8')
  } catch {
    return undefined
  }

  if (!html.trim()) return undefined

  const topicMatch = BV_TOPIC_RE.exec(html)
  if (!topicMatch) return undefined

  const attrs = parseAttributes(topicMatch[1] ?? '')
  if (!('title' in attrs)) return undefined

  let mtimeMs = 0
  try {
    const stats = await stat(absolutePath)
    mtimeMs = stats.mtimeMs
  } catch {
    // ignore
  }

  const relPath = relative(contextTreeRoot, absolutePath).replaceAll(sep, '/')
  const signals = signalsByPath.get(relPath) ?? createDefaultRuntimeSignals()

  return {
    html,
    mtimeMs,
    path: relPath,
    related: parseRelated(attrs.related ?? ''),
    signals,
    summary: attrs.summary ?? '',
    title: attrs.title ?? '',
  }
}

/**
 * Extract a flat attr map from the inside of an opening `<bv-topic ...>` tag.
 * Accepts both double- and single-quoted values (HTML5 allows both, and
 * hand-authored topics may use either). Unquoted values are not allowed
 * in the bv-topic vocabulary so we don't try to recover them.
 */
function parseAttributes(rawAttrs: string): Record<string, string> {
  const result: Record<string, string> = {}
  const attrRe = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: null | RegExpExecArray
  while ((match = attrRe.exec(rawAttrs)) !== null) {
    const name = match[1]?.toLowerCase()
    const value = match[2] ?? match[3]
    if (name && value !== undefined) result[name] = value
  }

  return result
}

/**
 * Parse a comma-separated `related=` attribute into a list of filesystem-style
 * paths. The bv-topic convention is `@domain/topic` (no `.html`), but byPath /
 * searchService both emit `domain/topic.html`. Normalizing here keeps
 * link-candidates' alreadyLinkedTo filter functional — without this step,
 * already-linked pairs would keep resurfacing across scans.
 */
function parseRelated(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => normalizeRelatedRef(s))
}

function normalizeRelatedRef(ref: string): string {
  // Strip the topic-ref `@` prefix used by bv-topic frontmatter.
  const stripped = ref.startsWith('@') ? ref.slice(1) : ref
  // Append `.html` when missing so the ref matches search-service hit paths.
  return stripped.endsWith('.html') ? stripped : `${stripped}.html`
}
