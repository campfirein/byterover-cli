/**
 * Edge-case heuristics — ports lines 890-1151 of the Python oracle.
 *
 * Cases handled here:
 *   1  — body H1 title fallback
 *   2  — orphan ## section routing via ORPHAN_H2_HEURISTIC
 *   3  — unknown frontmatter key warnings
 *   4  — lede paragraph hoist to <bv-topic summary>
 *   6  — all fenced blocks promoted to <bv-diagram>
 *   11 — YAML # truncation hazard detection
 */

import type {Diagram, Fact, Narrative} from './parsers.js'

import {
  KNOWN_FRONTMATTER_KEYS_CONTENT,
  ORPHAN_H2_HEURISTIC,
  RUNTIME_SIGNAL_FRONTMATTER_KEYS,
} from './constants.js'
import {
  collectBulletItemsWithContinuations,
  listOrphanSections,
  type RuleEntry,
  splitRulesBlock,
} from './helpers.js'
import {maskFencedBlocks,normalizeDiagramType} from './helpers.js'
import {parseFactBullets, pythonStrLen} from './parsers.js'
import {
  DIAGRAMS_SECTION_REGEX,
  FENCED_BLOCK_REGEX,
  NARRATIVE_SECTION_REGEX,
} from './regex.js'

// ---------------------------------------------------------------------------
// Case 1 — body H1 title fallback
// ---------------------------------------------------------------------------

/**
 * Find the first `# X` body H1 (single-#, not ##). Returns the heading
 * text or `undefined`. Stops at the first `## X` so the H1 must
 * precede any ##.
 */
export function extractH1Title(body: string): string | undefined {
  for (const line of body.split('\n')) {
    const m = /^#\s+(.+?)\s*$/.exec(line)
    if (m !== null) return m[1]?.trim()
    // Bail on ANY heading at H2 or deeper (`##`, `###`, `####`, ...).
    // Intentional — matches the Python oracle's semantic: "H1 must
    // precede every other heading or it's not a topic title". A body
    // that opens with `### Foo` then `# Title` returns undefined here.
    if (line.trimStart().startsWith('##')) return undefined
  }

  return undefined
}

// ---------------------------------------------------------------------------
// Case 4 — lede paragraph hoist
// ---------------------------------------------------------------------------

/**
 * Extract prose between the body H1 and the first `## ` section (or
 * end-of-body). Returns the joined non-empty lines or `undefined` when
 * no lede content exists.
 */
export function extractLedeParagraph(body: string): string | undefined {
  let afterH1 = false
  const captured: string[] = []
  for (const line of body.split('\n')) {
    if (!afterH1) {
      if (/^#\s+\S/.test(line)) afterH1 = true
      continue
    }

    if (line.trimStart().startsWith('## ')) break
    if (line.startsWith('---')) break
    captured.push(line)
  }

  const text = captured.join('\n').trim()
  return text.length === 0 ? undefined : text
}

// ---------------------------------------------------------------------------
// Case 11 — YAML # truncation hazard
// ---------------------------------------------------------------------------

/**
 * Detect `<space>#` inside unquoted YAML scalar values that would
 * silently truncate. Scans key:value lines for ' #' outside of quoted
 * strings.
 */
export function checkYamlHashHazard(yamlBlock: string): string[] {
  const warnings: string[] = []
  for (const line of yamlBlock.split('\n')) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (m === null) continue
    const key = m[1] ?? ''
    const rest = m[2] ?? ''
    if (
      rest.startsWith("'") ||
      rest.startsWith('"') ||
      rest.startsWith('|') ||
      rest.startsWith('>') ||
      rest.startsWith('[') ||
      rest.startsWith('{')
    ) {
      continue
    }

    if (rest.includes(' #')) {
      warnings.push(
        `yaml-comment-truncation:${key} value contains ' #' — PyYAML treats as inline comment, likely silently truncating`,
      )
    }
  }

  return warnings
}

// ---------------------------------------------------------------------------
// Case 3 — unknown frontmatter key warnings
// ---------------------------------------------------------------------------

export function checkUnknownFrontmatterKeys(
  frontmatter: Record<string, unknown>,
): string[] {
  const warnings: string[] = []
  for (const key of Object.keys(frontmatter)) {
    if (KNOWN_FRONTMATTER_KEYS_CONTENT.has(key)) continue
    if (RUNTIME_SIGNAL_FRONTMATTER_KEYS.has(key)) continue
    warnings.push(`dropped-frontmatter-key:${key}`)
  }

  return warnings
}

// ---------------------------------------------------------------------------
// Case 6 — fenced block extraction (+ diagrams-section dedup)
// ---------------------------------------------------------------------------

/**
 * Promote every fenced code block in the body to a `bv-diagram` entry.
 * Language tag drives the type (in-enum → that type; else 'other').
 * Blocks whose source span falls inside an excluded range (e.g.,
 * already-extracted `### Diagrams` blocks) are skipped.
 */
export function extractAllFencedBlocks(
  body: string,
  excludeSpans: Array<[number, number]>,
): Diagram[] {
  const out: Diagram[] = []
  FENCED_BLOCK_REGEX.lastIndex = 0
  for (const bm of body.matchAll(FENCED_BLOCK_REGEX)) {
    if (bm.index === undefined) continue
    const blockStart = bm.index
    let skip = false
    for (const [start, end] of excludeSpans) {
      if (start <= blockStart && blockStart < end) {
        skip = true
        break
      }
    }

    if (skip) continue
    const entry: Diagram = {
      content: (bm[4] ?? '').replace(/\s+$/, ''),
      type: normalizeDiagramType(bm[3] ?? ''),
    }
    if (bm[1] !== undefined) entry.title = bm[1]
    out.push(entry)
  }

  return out
}

/**
 * Return [start, end) span of the `## Narrative > ### Diagrams`
 * subsection for fenced-block dedup. Returns `undefined` when no
 * such subsection exists.
 */
export function diagramsSectionSpan(body: string): [number, number] | undefined {
  const masked = maskFencedBlocks(body)
  NARRATIVE_SECTION_REGEX.lastIndex = 0
  const nar = NARRATIVE_SECTION_REGEX.exec(masked)
  if (nar === null || nar.index === undefined) return undefined
  const sectionStart = nar.index + nar[0].length - (nar[1]?.length ?? 0)
  const section = masked.slice(sectionStart, sectionStart + (nar[1]?.length ?? 0))
  DIAGRAMS_SECTION_REGEX.lastIndex = 0
  const mDia = DIAGRAMS_SECTION_REGEX.exec(section)
  if (mDia === null || mDia.index === undefined) return undefined
  // Group 1 is the body span of the diagrams section, relative to
  // `section`. Compute its absolute start/end against `body`.
  const innerStart = mDia.index + mDia[0].length - (mDia[1]?.length ?? 0)
  const start = sectionStart + innerStart
  const end = start + (mDia[1]?.length ?? 0)
  return [start, end]
}

// ---------------------------------------------------------------------------
// Case 2 — orphan section routing
// ---------------------------------------------------------------------------

export type OrphanExtras = {
  decisions?: string[]
  dependencies?: string
  examples?: string
  facts?: Fact[]
  highlights?: string
  patterns?: string[]
  reason?: string
  rules?: RuleEntry[]
  structure?: string
  summaryAttrOverride?: string
}

/**
 * Route orphan `## X` sections to bv-* targets via the heading-name
 * heuristic. Conflict resolution: canonical wins; if the canonical
 * target is already populated, the orphan content is dropped and a
 * warning is emitted.
 */
export function processOrphanSections(input: {
  body: string
  canonicalNarrative: Narrative
  canonicalReason: string | undefined
  canonicalSummaryAttr: string
}): {extras: OrphanExtras; warnings: string[]} {
  const {body, canonicalNarrative, canonicalReason, canonicalSummaryAttr} = input
  const warnings: string[] = []
  const extras: OrphanExtras = {}

  for (const orphan of listOrphanSections(body)) {
    const {heading} = orphan
    const lower = heading.toLowerCase()
    const {content} = orphan
    const strategy = ORPHAN_H2_HEURISTIC.get(lower)

    if (strategy === undefined) {
      warnings.push(
        `dropped-orphan-section:${heading} (${pythonStrLen(content)} chars — no bv-* target)`,
      )
      continue
    }

    if (strategy === 'summary_attr_if_empty') {
      if (canonicalSummaryAttr.length === 0 && extras.summaryAttrOverride === undefined) {
        const firstParaSplit = content.split(/\n\s*\n/, 2)
        extras.summaryAttrOverride = (firstParaSplit[0] ?? '').trim()
      } else {
        warnings.push(
          `dropped-orphan-section:${heading} (canonical summary already populated)`,
        )
      }

      continue
    }

    if (strategy === 'reason_if_empty') {
      if (canonicalReason === undefined && extras.reason === undefined) {
        extras.reason = content
      } else {
        warnings.push(
          `dropped-orphan-section:${heading} (canonical <bv-reason> already populated)`,
        )
      }

      continue
    }

    if (strategy === 'structure_if_empty') {
      if (canonicalNarrative.structure === undefined && extras.structure === undefined) {
        extras.structure = content
      } else {
        warnings.push(
          `dropped-orphan-section:${heading} (canonical <bv-structure> already populated)`,
        )
      }

      continue
    }

    if (strategy === 'dependencies_if_empty') {
      if (
        canonicalNarrative.dependencies === undefined &&
        extras.dependencies === undefined
      ) {
        extras.dependencies = content
      } else {
        warnings.push(
          `dropped-orphan-section:${heading} (canonical <bv-dependencies> already populated)`,
        )
      }

      continue
    }

    if (strategy === 'highlights_if_empty') {
      if (
        canonicalNarrative.highlights === undefined &&
        extras.highlights === undefined
      ) {
        extras.highlights = content
      } else {
        warnings.push(
          `dropped-orphan-section:${heading} (canonical <bv-highlights> already populated)`,
        )
      }

      continue
    }

    if (strategy === 'examples_if_empty') {
      if (canonicalNarrative.examples === undefined && extras.examples === undefined) {
        extras.examples = content
      } else {
        warnings.push(
          `dropped-orphan-section:${heading} (canonical <bv-examples> already populated)`,
        )
      }

      continue
    }

    if (strategy === 'rules_split') {
      const items = splitRulesBlock(content)
      if (items.length > 0) {
        if (extras.rules === undefined) extras.rules = []
        extras.rules.push(...items)
      }

      continue
    }

    if (strategy === 'patterns_multiple') {
      const items = collectBulletItemsWithContinuations(content)
      if (items.length > 0) {
        if (extras.patterns === undefined) extras.patterns = []
        extras.patterns.push(...items)
      }

      continue
    }

    if (strategy === 'decisions_multiple') {
      const items = collectBulletItemsWithContinuations(content)
      if (items.length > 0) {
        if (extras.decisions === undefined) extras.decisions = []
        extras.decisions.push(...items)
      }

      continue
    }

    if (strategy === 'facts_parse') {
      const items = parseFactBullets(content)
      if (items.length > 0) {
        if (extras.facts === undefined) extras.facts = []
        extras.facts.push(...items)
      } else {
        warnings.push(
          `dropped-orphan-section:${heading} (no parseable fact bullets in ${pythonStrLen(content)} chars)`,
        )
      }

      continue
    }
  }

  return {extras, warnings}
}
