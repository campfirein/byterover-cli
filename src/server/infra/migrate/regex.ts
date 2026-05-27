/**
 * Precompiled regular expressions for the markdown→HTML migrator.
 *
 * Ported from the Python oracle. Key translation rule: every Python
 * `\Z` (end-of-input) becomes JS `(?![\s\S])` — JS's `$` under the `m`
 * flag matches end-of-line, not end-of-input, and `$(?!.)` succeeds at
 * end-of-line too because `.` doesn't match `\n` without the `s` flag.
 * `(?![\s\S])` is the only safe absolute-end anchor.
 *
 * Each regex carries a doc-comment pointing at the originating Python
 * line for traceability during oracle drift reviews.
 */

/** Python line 235 — strips RFC2119 keywords from rule text when slugifying. */
export const RFC2119_STRIP = /\b(MUST|SHALL|SHOULD|MAY|INFO)\b/gi

/**
 * Python lines 266-269 — "Rule N:" / "Rule N." splitter.
 *
 * Matches when "Rule N:" appears at line start (`^`) OR immediately
 * after sentence-ending punctuation + whitespace (so mid-sentence
 * "similar to Rule 3:" mentions don't split). Operates against a
 * fence-masked text to avoid splitting on rule-like text inside a
 * code fence.
 */
export const RULE_PREFIX_LINE = /(?:^|(?<=[.!?])\s+)Rule\s*\d+\s*[:.)]\s*/gim

/**
 * Python line 399 — top-level `## Heading` walker.
 *
 * Returns `[fullMatch, heading, body]`. The end anchor is
 * `(?=^##\s|(?![\s\S]))` — next `## ` at line start, or end-of-input.
 * NOTE: caller must `.lastIndex = 0` before each `exec` loop or use
 * `matchAll`.
 */
export const SECTION_REGEX = /^##\s+([^\n]+?)\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/gm

/**
 * Python lines 411-413 — fenced code block matcher with optional
 * preceding `**Title**` line.
 *
 * Capture groups:
 *   1 = title (optional)
 *   2 = fence marker (``` or ~~~)
 *   3 = language tag (may be empty)
 *   4 = body content (verbatim)
 *
 * Both fence styles are supported. The title line, when present, must
 * be IMMEDIATELY followed by the fence (no blank line between) — a
 * blank line means the bold line was a paragraph, not a diagram title.
 */
export const FENCED_BLOCK_REGEX =
  /(?:(?:^|\n)\*\*(.+?)\*\*[ \t]*\n)?(```|~~~)(\w*)\n([\s\S]*?)\2/g

/**
 * Python line 420 — fence-mask matcher.
 *
 * Used by `maskFencedBlocks` to replace fenced regions with same-
 * length whitespace so structural regexes can walk text without
 * false-matching inside code samples. Span positions must remain
 * aligned to the original text.
 */
export const FENCE_MASK_REGEX = /```[\s\S]*?```|~~~[\s\S]*?~~~/g

/** Python line 586 — loose bullet prefix (dash, asterisk, plus, or numbered). */
export const LOOSE_BULLET_PREFIX = /^\s*(?:[-*+]|\d+\.)\s+/

/**
 * Escape a string for safe inclusion in a `new RegExp(...)` pattern.
 * JavaScript has no built-in equivalent of Python's `re.escape`.
 */
export function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * Build a section walker pattern for a specific heading.
 *
 * Mirrors Python lines 568-571 — `(?ms)##\s*<heading>\s*\n([\s\S]*?)
 * (?=^##\s[^#]|\n---\n|\Z)`. The `[^#]` after `##\s` prevents
 * matching `### Heading` as a `## ` prefix.
 *
 * The end anchor `(?![\s\S])` substitutes for Python `\Z`.
 */
export function sectionByHeadingPattern(heading: string): RegExp {
  const escaped = escapeRegex(heading)
  return new RegExp(
    `##\\s*${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s[^#]|\\n---\\n|(?![\\s\\S]))`,
    'gim',
  )
}

/**
 * Narrative section walker — matches `## Narrative` and captures body.
 *
 * Same end-anchor structure as `sectionByHeadingPattern('Narrative')`,
 * exposed as its own constant because it's used in three different
 * call sites and pattern uniformity matters.
 */
export const NARRATIVE_SECTION_REGEX = sectionByHeadingPattern('Narrative')

/**
 * Inner narrative subsection walker — captures every `### X` block
 * inside an already-extracted narrative section.
 *
 * End anchor: next `### `, next `## ` (with `[^#]` to skip `###`), or
 * end-of-input.
 */
export const NARRATIVE_SUBSECTION_REGEX =
  /^###\s+(.+?)\s*$\n([\s\S]*?)(?=^###\s|^##\s[^#]|(?![\s\S]))/gm

/** Inner `### Diagrams` span walker (for dedup against extract-all-fences). */
export const DIAGRAMS_SECTION_REGEX =
  /###\s*Diagrams\s*\n([\s\S]*?)(?=^###\s|^##\s[^#]|(?![\s\S]))/gim

/**
 * Snippet-extractor strip pattern — used by `extractSnippetsFromBody`
 * to remove canonical section bodies before scanning the residual for
 * `---`-separated legacy snippets. Each canonical heading gets its
 * own pattern via `sectionStripPattern`.
 */
export function sectionStripPattern(heading: string): RegExp {
  const escaped = escapeRegex(heading)
  return new RegExp(
    `##\\s*${escaped}[\\s\\S]*?(?=^##\\s[^#]|\\n---\\n|(?![\\s\\S]))`,
    'gim',
  )
}
