/**
 * Markdown body parsers — mirrors `parseContent` family in the
 * MarkdownWriter (TS) and lines 457-887 of the Python oracle.
 */

import yaml from 'js-yaml'

import {NARRATIVE_SUBSECTION_HEURISTIC, RAW_CONCEPT_LABEL_MAP} from './constants.js'
import {
  collectBulletItemsWithContinuations,
  maskFencedBlocks,
  stripBulletPrefix,
} from './helpers.js'
import {
  FENCED_BLOCK_REGEX,
  NARRATIVE_SECTION_REGEX,
  NARRATIVE_SUBSECTION_REGEX,
  sectionByHeadingPattern,
} from './regex.js'

// ---------------------------------------------------------------------------
// js-yaml schema — matches PyYAML SafeLoader-minus-timestamps as closely as
// js-yaml allows.
//
// Adds YAML 1.1 boolean resolution (yes/no/on/off as bool) on top of
// CORE_SCHEMA. The alternation deliberately omits the single-letter
// `y / Y / n / N` forms: PyYAML's SafeLoader bool resolver also omits
// them (verified against `yaml.SafeLoader.yaml_implicit_resolvers`),
// so adding them here would parse `title: y` as a boolean and surface
// a spurious type-mismatch warning vs the oracle. Two acknowledged
// divergences from PyYAML:
//   - `012` (leading-zero int) parses as decimal 12 here; PyYAML parses
//     as octal 10. Rare in frontmatter.
//   - Floats/timestamps that PyYAML treats specially remain strings —
//     matches the FrontmatterLoader's removed timestamp resolver.
// ---------------------------------------------------------------------------

const yaml11Bool = new yaml.Type('tag:yaml.org,2002:bool', {
  construct: (data) => /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/.test(data),
  kind: 'scalar',
  resolve: (data) =>
    typeof data === 'string' &&
    /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/.test(
      data,
    ),
})

const FRONTMATTER_SCHEMA = yaml.CORE_SCHEMA.extend({implicit: [yaml11Bool]})

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

export type FrontmatterParse = {
  body: string
  frontmatter: Record<string, unknown> | undefined
  parseError: string | undefined
  yamlBlock: string
}

/**
 * Extract YAML frontmatter from the head of the file.
 *
 * Returns `{frontmatter, body, yamlBlock, parseError}`. `parseError`
 * is `undefined` on success; a short string when YAML parsing fails
 * or the parsed value isn't a mapping. Callers surface non-undefined
 * `parseError` as an operator-visible warning so broken frontmatter
 * is never silently dropped.
 *
 * When no frontmatter is found at all, returns `{frontmatter:
 * undefined, body: original, yamlBlock: '', parseError: undefined}` —
 * that's a content-shape signal, not a parse failure.
 */
export function parseFrontmatter(content: string): FrontmatterParse {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return {body: content, frontmatter: undefined, parseError: undefined, yamlBlock: ''}
  }

  const lfIdx = content.indexOf('\n---\n', 4)
  const crlfIdx = content.indexOf('\r\n---\r\n', 5)
  const isCrlf = lfIdx === -1
  const end = isCrlf ? crlfIdx : lfIdx
  if (end < 0) {
    return {
      body: content,
      frontmatter: undefined,
      parseError: 'unterminated-frontmatter-delimiter',
      yamlBlock: '',
    }
  }

  const delim = isCrlf ? 7 : 5
  const yamlBlock = content.slice(isCrlf ? 5 : 4, end)
  const body = content.slice(end + delim)
  let parsed: unknown
  try {
    parsed = yaml.load(yamlBlock, {schema: FRONTMATTER_SCHEMA})
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return {body, frontmatter: undefined, parseError: `yaml-parse-error: ${message}`, yamlBlock}
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const typeLabel =
      parsed === null
        ? 'NoneType'
        : Array.isArray(parsed)
          ? 'list'
          : typeof parsed
    return {
      body,
      frontmatter: undefined,
      parseError: `frontmatter-not-a-mapping (got ${typeLabel})`,
      yamlBlock,
    }
  }

  return {body, frontmatter: parsed as Record<string, unknown>, parseError: undefined, yamlBlock}
}

// ---------------------------------------------------------------------------
// Typed frontmatter readers (case 13)
// ---------------------------------------------------------------------------

/** Python type-name string compatible with Python's `type(x).__name__`. */
function pythonTypeName(v: unknown): string {
  if (v === null) return 'NoneType'
  if (Array.isArray(v)) return 'list'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float'
  if (typeof v === 'object') return 'dict'
  return typeof v
}

/**
 * Like `optStr`, but emits a type-mismatch warning when the value is
 * present but not a string (case 13). Missing values are silent —
 * they fall back to the next resolution layer.
 */
export function optStrTyped(
  value: unknown,
  key: string,
  warnings: string[],
): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  warnings.push(
    `frontmatter-type-mismatch:${key} expected string, got ${pythonTypeName(value)}`,
  )
  return undefined
}

/**
 * Like `strList`, but emits a type-mismatch warning when the value is
 * present but neither a string nor a list-of-strings.
 */
export function strListTyped(
  value: unknown,
  key: string,
  warnings: string[],
): string[] {
  if (value === undefined || value === null) return []
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
  }

  if (Array.isArray(value)) {
    const out: string[] = []
    let bad = 0
    for (const v of value) {
      if (typeof v === 'string') out.push(v)
      else bad++
    }

    if (bad > 0) {
      warnings.push(
        `frontmatter-type-mismatch:${key} contained ${bad} non-string element(s) — dropped`,
      )
    }

    return out
  }

  warnings.push(
    `frontmatter-type-mismatch:${key} expected string or list, got ${pythonTypeName(value)}`,
  )
  return []
}

/** Rewrite `.md` suffixes in related-path values to `.html`. */
export function htmlRelatedPaths(values: string[]): string[] {
  return values.map((v) => (v.endsWith('.md') ? `${v.slice(0, -3)}.html` : v))
}

// ---------------------------------------------------------------------------
// Section walkers
// ---------------------------------------------------------------------------

/**
 * Extract the content body of a named `## Heading` section.
 *
 * Fence-masked so a literal `## ...` line inside a code block doesn't
 * terminate the section. Content is sliced from the ORIGINAL body
 * using the matched span so fences survive intact.
 */
export function parseSection(body: string, heading: string): string | undefined {
  const pattern = sectionByHeadingPattern(heading)
  const masked = maskFencedBlocks(body)
  const m = pattern.exec(masked)
  if (m === null || m.index === undefined) return undefined
  // Group 1 holds the body span (relative to the start of group 0).
  const bodyStart = m.index + m[0].length - (m[1]?.length ?? 0)
  const text = body.slice(bodyStart, bodyStart + (m[1]?.length ?? 0)).trim()
  return text.length === 0 ? undefined : text
}

export function parseReason(body: string): string | undefined {
  return parseSection(body, 'Reason')
}

// ---------------------------------------------------------------------------
// Raw Concept
// ---------------------------------------------------------------------------

export type RawConcept = {
  author?: string
  changes?: string[]
  files?: string[]
  flow?: string
  patterns?: Array<{description: string; flags?: string; pattern: string}>
  task?: string
  timestamp?: string
}

/**
 * Parse `## Raw Concept`. Plural-tolerant (`**Tasks:**`, `**Flows:**`)
 * via `RAW_CONCEPT_LABEL_MAP`. Loose-bullet tolerant in Changes / Files
 * sections. Patterns subsection requires the explicit bullet+backtick
 * form: `- \`<re>\` (flags: <f>) - <desc>`.
 */
export function parseRawConcept(body: string): {
  rawConcept: RawConcept
  warnings: string[]
} {
  const warnings: string[] = []
  const section = parseSection(body, 'Raw Concept')
  if (section === undefined) return {rawConcept: {}, warnings}

  const rc: RawConcept = {}
  // Walk every **Label:** bold-heading subsection.
  const subIter = section.matchAll(
    /\*\*\s*([A-Za-z][\w \t]*?)\s*:\s*\*\*\s*\n?([\s\S]*?)(?=\n\*\*[A-Za-z]|\n##|$)/g,
  )
  for (const m of subIter) {
    const rawLabel = (m[1] ?? '').trim()
    const subBody = (m[2] ?? '').trim()
    const key = RAW_CONCEPT_LABEL_MAP.get(rawLabel.toLowerCase())
    if (key === undefined) {
      if (subBody.length > 0) {
        warnings.push(
          `dropped-raw-concept-subsection:${rawLabel} (${pythonStrLen(subBody)} chars)`,
        )
      }

      continue
    }

    switch (key) {
    case 'author': {
      if (rc.author === undefined) {
        const firstLine = subBody.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
        rc.author = firstLine ?? subBody
      }
    
    break;
    }

    case 'changes': {
      const existing = rc.changes ?? []
      existing.push(...collectBulletItemsWithContinuations(subBody))
      if (existing.length > 0) rc.changes = existing
    
    break;
    }

    case 'files': {
      const existing = rc.files ?? []
      existing.push(...collectBulletItemsWithContinuations(subBody))
      if (existing.length > 0) rc.files = existing
    
    break;
    }

    case 'flow': {
      if (rc.flow === undefined) rc.flow = subBody
    
    break;
    }

    case 'patterns': {
      const existing = rc.patterns ?? []
      for (const line of subBody.split('\n')) {
        const stripped = line.trim()
        if (!stripped.startsWith('- `') && !stripped.startsWith('* `')) continue
        const pm = /^[-*]\s+`(.+?)`(?:\s*\(flags:\s*(.+?)\))?\s*-\s*(.+)$/.exec(stripped)
        if (pm !== null) {
          const entry: {description: string; flags?: string; pattern: string} = {
            description: (pm[3] ?? '').trim(),
            pattern: pm[1] ?? '',
          }
          if (pm[2] !== undefined) entry.flags = pm[2]
          existing.push(entry)
        }
      }

      if (existing.length > 0) rc.patterns = existing
    
    break;
    }

    case 'task': {
      if (rc.task === undefined) rc.task = subBody
    
    break;
    }

    case 'timestamp': {
      if (rc.timestamp === undefined) {
        const firstLine = subBody.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
        rc.timestamp = firstLine ?? subBody
      }
    
    break;
    }
    // No default
    }
  }

  return {rawConcept: rc, warnings}
}

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

export type Diagram = {content: string; title?: string; type: string}

export type Narrative = {
  dependencies?: string
  diagrams?: Diagram[]
  examples?: string
  highlights?: string
  rules?: string
  structure?: string
}

export type NarrativeExtras = {
  decisions?: string[]
  patterns?: string[]
}

/**
 * Parse `## Narrative`. Canonical subsections: structure, dependencies,
 * highlights, rules, examples, diagrams[]. Unknown `### X` subsections
 * route via `NARRATIVE_SUBSECTION_HEURISTIC` (case 8).
 */
export function parseNarrative(body: string): {
  extras: NarrativeExtras
  narrative: Narrative
  warnings: string[]
} {
  const warnings: string[] = []
  const masked = maskFencedBlocks(body)
  NARRATIVE_SECTION_REGEX.lastIndex = 0
  const m = NARRATIVE_SECTION_REGEX.exec(masked)
  if (m === null || m.index === undefined) {
    return {extras: {}, narrative: {}, warnings}
  }

  const bodyStart = m.index + m[0].length - (m[1]?.length ?? 0)
  const section = body.slice(bodyStart, bodyStart + (m[1]?.length ?? 0))
  const narrative: Narrative = {}
  const extras: NarrativeExtras = {}

  const sectionMasked = maskFencedBlocks(section)
  NARRATIVE_SUBSECTION_REGEX.lastIndex = 0
  for (const sm of sectionMasked.matchAll(NARRATIVE_SUBSECTION_REGEX)) {
    if (sm.index === undefined) continue
    const label = (sm[1] ?? '').trim()
    const lower = label.toLowerCase()
    const subBodyStart = sm.index + sm[0].length - (sm[2]?.length ?? 0)
    const subBody = section.slice(subBodyStart, subBodyStart + (sm[2]?.length ?? 0)).trim()
    if (subBody.length === 0) continue

    // Canonical narrative subsections.
    if (lower === 'structure') {
      if (narrative.structure === undefined) narrative.structure = subBody
      continue
    }

    if (lower === 'dependencies') {
      if (narrative.dependencies === undefined) narrative.dependencies = subBody
      continue
    }

    if (lower === 'highlights' || lower === 'features') {
      if (narrative.highlights === undefined) narrative.highlights = subBody
      continue
    }

    if (lower === 'rules') {
      if (narrative.rules === undefined) narrative.rules = subBody
      continue
    }

    if (lower === 'examples') {
      if (narrative.examples === undefined) narrative.examples = subBody
      continue
    }

    if (lower === 'diagrams') {
      const diagrams: Diagram[] = []
      // Groups: 1=title (opt), 2=fence marker, 3=lang, 4=content
      FENCED_BLOCK_REGEX.lastIndex = 0
      for (const bm of subBody.matchAll(FENCED_BLOCK_REGEX)) {
        const entry: Diagram = {
          content: (bm[4] ?? '').replace(/\s+$/, ''),
          type: bm[3] !== undefined && bm[3].length > 0 ? bm[3] : 'ascii',
        }
        if (bm[1] !== undefined) entry.title = bm[1]
        diagrams.push(entry)
      }

      if (diagrams.length > 0) narrative.diagrams = diagrams
      continue
    }

    // Case 8: heuristic-route unknown ### subsections.
    const strategy = NARRATIVE_SUBSECTION_HEURISTIC.get(lower)
    switch (strategy) {
    case 'decisions_multiple': {
      const items = parseBulletItems(subBody)
      if (items.length > 0) {
        if (extras.decisions === undefined) extras.decisions = []
        extras.decisions.push(...items)
      }
    
    break;
    }

    case 'patterns_multiple': {
      const items = parseBulletItems(subBody)
      if (items.length > 0) {
        if (extras.patterns === undefined) extras.patterns = []
        extras.patterns.push(...items)
      }
    
    break;
    }

    case 'structure_if_empty': {
      if (narrative.structure === undefined) {
        narrative.structure = subBody
      } else {
        warnings.push(
          `dropped-narrative-subsection:${label} (canonical structure already populated, ${pythonStrLen(subBody)} chars)`,
        )
      }
    
    break;
    }

    default: {
      warnings.push(
        `dropped-narrative-subsection:${label} (${pythonStrLen(subBody)} chars)`,
      )
    }
    }
  }

  return {extras, narrative, warnings}
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

export type Fact = {
  category?: string
  statement: string
  subject?: string
  value?: string
}

/**
 * Extract bulleted items (any common style) as a list of strings,
 * preserving indented continuation lines as part of the same item.
 */
export function parseBulletItems(sectionBody: string): string[] {
  return collectBulletItemsWithContinuations(sectionBody)
}

/**
 * Parse a bulleted section as bv-fact items. Used for both `## Facts`
 * (canonical) and `## Evidence` (orphan-routed).
 */
export function parseFactBullets(sectionBody: string): Fact[] {
  const facts: Fact[] = []
  for (const line of sectionBody.split('\n')) {
    const content = stripBulletPrefix(line)
    if (content === undefined) continue
    const stripped = content.trim()
    if (stripped.length === 0) continue
    const structured = /^\*\*(.+?)\*\*\s*:\s*(.+?)(?:\s*\[(\w+)\])?$/.exec(stripped)
    if (structured !== null) {
      const entry: Fact = {
        statement: (structured[2] ?? '').trim(),
        subject: (structured[1] ?? '').trim(),
      }
      if (structured[3] !== undefined) entry.category = structured[3]
      facts.push(entry)
      continue
    }

    const plain = /^(.+?)(?:\s*\[(\w+)\])?$/.exec(stripped)
    if (plain !== null) {
      const entry: Fact = {statement: (plain[1] ?? '').trim()}
      if (plain[2] !== undefined) entry.category = plain[2]
      facts.push(entry)
    }
  }

  return facts
}

/** Parse `## Facts` section. Accepts dash, asterisk, and numbered bullets. */
export function parseFacts(body: string): Fact[] {
  const section = parseSection(body, 'Facts')
  if (section === undefined) return []
  return parseFactBullets(section)
}

// ---------------------------------------------------------------------------
// String-length helper (code-point count to match Python `len(str)`)
// ---------------------------------------------------------------------------

/**
 * Python `len(str)` counts Unicode code points. JS `string.length`
 * counts UTF-16 code units (so emoji etc. drift by ~2x). Use this
 * everywhere a warning string includes a char count.
 */
export function pythonStrLen(s: string): number {
  // Spread iterates code points, not UTF-16 code units.
  return [...s].length
}
