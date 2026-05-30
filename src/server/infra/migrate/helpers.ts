/**
 * Pure helpers for the markdown→HTML migrator.
 *
 * Ports `scripts/migrate-context-tree-py/migrate_context_tree.py`
 * lines 213-455 and 583-644. All functions are pure (no IO, no
 * mutable global state).
 */

import {
  DIAGRAM_TYPES,
  FACT_CATEGORIES,
  KNOWN_SECTION_HEADINGS_LOWER,
} from './constants.js'
import {
  FENCE_MASK_REGEX,
  LOOSE_BULLET_PREFIX,
  RFC2119_STRIP,
  RULE_PREFIX_LINE,
  SECTION_REGEX,
} from './regex.js'

/** A single parsed rule entry — text + optional severity + stable id. */
export type RuleEntry = {
  id: string
  severity?: 'info' | 'must' | 'should'
  text: string
}

/** Heading + content tuple yielded by the orphan-section walker. */
export type OrphanSection = {
  content: string
  heading: string
}

/**
 * Return RFC2119 severity for a rule text, or `undefined` when no
 * keyword is present. Precedence is `must > should > info` so a
 * sentence with multiple keywords gets the strongest tier.
 *
 * Word boundaries are enforced so `trust` doesn't match `MUST`.
 */
export function inferRuleSeverity(
  text: string,
): 'info' | 'must' | 'should' | undefined {
  if (/\b(MUST|SHALL)\b/i.test(text)) return 'must'
  if (/\bSHOULD\b/i.test(text)) return 'should'
  if (/\b(MAY|INFO)\b/i.test(text)) return 'info'
  return undefined
}

/**
 * Generate a stable kebab-case id from rule text. Strips RFC2119
 * keywords, normalises to ASCII alphanumerics + hyphens, takes the
 * first ~6 words, prefixes with the supplied marker.
 *
 * Returns `<prefix>-rule` for empty / all-stopword input so callers
 * always have a non-empty id.
 */
export function slugifyRuleId(text: string, prefix: string): string {
  const cleaned = text
    .replaceAll(RFC2119_STRIP, ' ')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/g, ' ')
  const words = cleaned.split(/\s+/).filter((w) => w.length > 0).slice(0, 6)
  if (words.length === 0) return `${prefix}-rule`
  let slug = words.join('-').replaceAll(/-{2,}/g, '-').replaceAll(/^-+|-+$/g, '')
  if (slug.length > 48) {
    const head = slug.slice(0, 48)
    const lastHyphen = head.lastIndexOf('-')
    slug = lastHyphen === -1 ? head : head.slice(0, lastHyphen)
  }

  return `${prefix}-${slug}`
}

/** Collapse a diagram type label to the bv-diagram schema enum. */
export function normalizeDiagramType(typeLabel?: string): string {
  if (typeLabel === undefined || typeLabel.length === 0) return 'ascii'
  const lowered = typeLabel.toLowerCase()
  return DIAGRAM_TYPES.has(lowered) ? lowered : 'other'
}

/** Collapse a fact category to the bv-fact schema enum, or undefined. */
export function normalizeFactCategory(category?: string): string | undefined {
  if (category === undefined) return undefined
  const lowered = category.toLowerCase()
  return FACT_CATEGORIES.has(lowered) ? lowered : 'other'
}

/**
 * Entity-encode the five HTML special characters. `&` is escaped
 * first so subsequent encodings don't get double-encoded.
 */
export function escapeHtmlText(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Convert `security/auth.md` → `security/auth`. Normalises
 * backslashes; rejects `..` / `.` segments so the migrated topic
 * passes the HTML writer's path safety check.
 *
 * Throws on unsafe segments — caller routes the failure into
 * `_archive_failed`.
 */
export function relPathToTopicPath(relPath: string): string {
  const normalised = relPath.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalised.split('/').filter((s) => s.length > 0)
  for (const seg of segments) {
    if (seg === '..' || seg === '.') {
      throw new Error(`Topic path contains unsafe segment '${seg}': ${relPath}`)
    }
  }

  const joined = segments.join('/')
  return joined.endsWith('.md') ? joined.slice(0, -3) : joined
}

/**
 * Replace fenced code blocks with equal-length whitespace so
 * structural regexes (`## heading`, `Rule N:` splitter, etc.) can
 * walk the text without false-matching inside code samples. Span
 * positions are preserved by the same-length substitution.
 */
export function maskFencedBlocks(text: string): string {
  // `g` flag is set on FENCE_MASK_REGEX; .replaceAll resets it per call.
  return text.replaceAll(FENCE_MASK_REGEX, (match) => ' '.repeat(match.length))
}

/**
 * Walk a markdown body and return every `## X` section whose heading
 * is not in the canonical set. Content is sliced back out of the
 * ORIGINAL body via the matched span so fenced code survives intact.
 *
 * Case-insensitive canonical match so lowercase `## reason` is still
 * treated as canonical — mirrors the canonical-heading loops that use
 * the `i` flag.
 */
export function listOrphanSections(body: string): OrphanSection[] {
  const masked = maskFencedBlocks(body)
  const out: OrphanSection[] = []
  // `matchAll` is non-destructive of the regex's `lastIndex` because it
  // builds its own iterator state.
  for (const m of masked.matchAll(SECTION_REGEX)) {
    if (m.index === undefined) continue
    const heading = (m[1] ?? '').trim()
    if (KNOWN_SECTION_HEADINGS_LOWER.has(heading.toLowerCase())) continue
    // `m[2]` carries the body-span slice from the masked text. Its
    // start offset is `m.index + m[0].indexOf(m[2])`; rather than do
    // arithmetic, we re-slice from the original body using the
    // captured indices via a recomputation.
    const bodyStart = m.index + m[0].length - (m[2]?.length ?? 0)
    const bodyEnd = bodyStart + (m[2]?.length ?? 0)
    const content = body.slice(bodyStart, bodyEnd).trim()
    if (content.length === 0) continue
    out.push({content, heading})
  }

  return out
}

/**
 * Return the content of a bulleted line (any common style), or
 * `undefined` if the line isn't a bullet.
 */
export function stripBulletPrefix(line: string): string | undefined {
  // LOOSE_BULLET_PREFIX has no `g` flag — safe to reuse.
  const m = LOOSE_BULLET_PREFIX.exec(line)
  return m === null ? undefined : line.slice(m[0].length)
}

/**
 * Split a bulleted block into items, preserving indented continuation
 * lines on the same item.
 *
 * Markdown allows multi-line list items where continuation text is
 * indented under the bullet. The naive line-by-line splitter drops
 * those continuations silently — this helper folds indented (or
 * pure-whitespace) follow-up lines back into the current item until
 * the next bullet-leading line or a blank-line break.
 */
export function collectBulletItemsWithContinuations(text: string): string[] {
  const items: string[] = []
  let current: string[] | undefined
  const flush = (): void => {
    if (current === undefined) return
    const joined = current.join('\n').trim()
    if (joined.length > 0) items.push(joined)
    current = undefined
  }

  for (const line of text.split('\n')) {
    if (LOOSE_BULLET_PREFIX.test(line)) {
      flush()
      const stripped = stripBulletPrefix(line) ?? ''
      current = [stripped.replace(/\s+$/, '')]
      continue
    }

    if (current === undefined) continue
    if (line.trim().length === 0) {
      flush()
      continue
    }

    if (line.startsWith(' ') || line.startsWith('\t')) {
      current.push(line.trim())
    } else {
      flush()
    }
  }

  flush()
  return items
}

/**
 * Split a markdown `### Rules` block into individual rule entries.
 *
 * Detection priority:
 *   1. dash/asterisk/plus bullets (`-`, `*`, `+`)
 *   2. numbered list (`1.`, `2.`)
 *   3. "Rule N:" / "Rule N." prefix on consecutive lines
 *   4. blank-line-separated paragraphs
 *
 * Each entry carries `text`, optional `severity`, and a unique `id`.
 */
export function splitRulesBlock(rulesText: string): RuleEntry[] {
  const trimmed = rulesText.trim()
  if (trimmed.length === 0) return []

  // Detect bullet/numbered/Rule-prefix/paragraph style on a fence-
  // masked copy so a `- some code` line or a `Rule 1:` mention inside
  // a fenced sample doesn't flip the detector. Item extraction can
  // still operate on the original text — the bullet collector is
  // fence-blind, but the masked detector gates entry into that branch.
  const masked = maskFencedBlocks(trimmed)
  const hasBullets = /^[-*+]\s+\S/m.test(masked)
  const hasNumbered = /^\d+\.\s+\S/m.test(masked)

  let items: string[]
  if (hasBullets || hasNumbered) {
    items = collectBulletItemsWithContinuations(trimmed)
  } else if (RULE_PREFIX_LINE.test(masked)) {
    // Walk match positions in the masked text, slice the corresponding
    // chunks out of `trimmed`. Drop the first chunk (intro paragraph
    // before the first prefix).
    RULE_PREFIX_LINE.lastIndex = 0
    const spans: Array<[number, number]> = []
    let last = 0
    let m: null | RegExpExecArray
    while ((m = RULE_PREFIX_LINE.exec(masked)) !== null) {
      spans.push([last, m.index])
      last = m.index + m[0].length
    }

    spans.push([last, trimmed.length])
    items = spans
      .slice(1)
      .map(([s, e]) => trimmed.slice(s, e).trim())
      .filter((s) => s.length > 0)
  } else {
    const spans: Array<[number, number]> = []
    let last = 0
    for (const m of masked.matchAll(/\n\s*\n/g)) {
      if (m.index === undefined) continue
      spans.push([last, m.index])
      last = m.index + m[0].length
    }

    spans.push([last, trimmed.length])
    items = spans
      .map(([s, e]) => trimmed.slice(s, e).trim())
      .filter((s) => s.length > 0)
  }

  const seenIds = new Set<string>()
  const out: RuleEntry[] = []
  for (const text of items) {
    const baseId = slugifyRuleId(text, 'r')
    let ruleId = baseId
    let suffix = 2
    while (seenIds.has(ruleId)) {
      ruleId = `${baseId}-${suffix}`
      suffix++
    }

    seenIds.add(ruleId)
    const severity = inferRuleSeverity(text)
    const entry: RuleEntry = {id: ruleId, text}
    if (severity !== undefined) entry.severity = severity
    out.push(entry)
  }

  return out
}
