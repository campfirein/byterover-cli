/**
 * Markdown topic → bv-topic HTML conversion.
 *
 * Ports lines 1154-1531 of the Python oracle. `convertMarkdownTopicToHtml`
 * is a pure function: input markdown + mtime + relPath, output HTML +
 * warnings list. No disk IO; the orchestrator owns atomic writes.
 *
 * Output uses ONLY closed bv-* vocabulary; orphan content is mapped to
 * existing bv-* targets via the heading-name heuristic, or dropped with
 * a per-file warning when no clean target exists.
 */

import type {Diagram, Fact, Narrative, RawConcept} from './parsers.js'

import {KNOWN_SECTION_HEADINGS_LOWER} from './constants.js'
import {
  escapeHtmlText,
  maskFencedBlocks,
  normalizeDiagramType,
  normalizeFactCategory,
  relPathToTopicPath,
  type RuleEntry,
  splitRulesBlock,
} from './helpers.js'
import {
  checkUnknownFrontmatterKeys,
  checkYamlHashHazard,
  diagramsSectionSpan,
  extractAllFencedBlocks,
  extractH1Title,
  extractLedeParagraph,
  processOrphanSections,
} from './heuristics.js'
import {
  htmlRelatedPaths,
  optStrTyped,
  parseFacts,
  parseFrontmatter,
  parseNarrative,
  parseRawConcept,
  parseReason,
  strListTyped,
} from './parsers.js'
import {SECTION_REGEX, sectionStripPattern} from './regex.js'

export type ConvertResult = {
  html: string
  warnings: string[]
}

export type ConvertInput = {
  markdown: string
  mtimeMs: number
  relPath: string
}

/**
 * Render a UTC date as RFC3339 with millisecond precision + trailing
 * `Z` — matches the TS html-writer's timestamp format and is byte-
 * equal with Python's
 * `.astimezone(utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")`.
 */
function toIso(date: Date): string {
  return date.toISOString()
}

/**
 * Suffix `ruleId` with `-2`, `-3`, ... until it doesn't collide with
 * any entry already in `seen`, then record it.
 */
function uniquifyId(ruleId: string, seen: Set<string>): string {
  let candidate = ruleId
  let suffix = 2
  while (seen.has(candidate)) {
    candidate = `${ruleId}-${suffix}`
    suffix++
  }

  seen.add(candidate)
  return candidate
}

function appendReason(parts: string[], reason: string | undefined): void {
  if (reason === undefined || reason.length === 0) return
  parts.push(`<bv-reason>${escapeHtmlText(reason)}</bv-reason>`)
}

function appendRawConcept(parts: string[], rc: RawConcept): void {
  if (rc.task !== undefined) {
    parts.push(`<bv-task>${escapeHtmlText(rc.task)}</bv-task>`)
  }

  if (rc.changes !== undefined && rc.changes.length > 0) {
    const items = rc.changes
      .map((c) => `<li>${escapeHtmlText(c)}</li>`)
      .join('')
    parts.push(`<bv-changes>${items}</bv-changes>`)
  }

  if (rc.files !== undefined && rc.files.length > 0) {
    const items = rc.files.map((f) => `<li>${escapeHtmlText(f)}</li>`).join('')
    parts.push(`<bv-files>${items}</bv-files>`)
  }

  if (rc.flow !== undefined) {
    parts.push(`<bv-flow>${escapeHtmlText(rc.flow)}</bv-flow>`)
  }

  if (rc.timestamp !== undefined) {
    parts.push(`<bv-timestamp>${escapeHtmlText(rc.timestamp)}</bv-timestamp>`)
  }

  if (rc.author !== undefined) {
    parts.push(`<bv-author>${escapeHtmlText(rc.author)}</bv-author>`)
  }

  for (const pat of rc.patterns ?? []) {
    const attrs: string[] = []
    if (pat.flags !== undefined) {
      attrs.push(` flags="${escapeHtmlText(pat.flags)}"`)
    }

    if (pat.description !== undefined) {
      attrs.push(` description="${escapeHtmlText(pat.description)}"`)
    }

    parts.push(
      `<bv-pattern${attrs.join('')}>${escapeHtmlText(pat.pattern)}</bv-pattern>`,
    )
  }
}

function appendNarrative(
  parts: string[],
  narr: Narrative,
  ruleIds: Set<string>,
): void {
  if (narr.structure !== undefined) {
    parts.push(`<bv-structure>${escapeHtmlText(narr.structure)}</bv-structure>`)
  }

  if (narr.dependencies !== undefined) {
    parts.push(
      `<bv-dependencies>${escapeHtmlText(narr.dependencies)}</bv-dependencies>`,
    )
  }

  if (narr.highlights !== undefined) {
    parts.push(
      `<bv-highlights>${escapeHtmlText(narr.highlights)}</bv-highlights>`,
    )
  }

  if (narr.rules !== undefined) {
    for (const rule of splitRulesBlock(narr.rules)) {
      const rid = uniquifyId(rule.id, ruleIds)
      const sev = rule.severity === undefined ? '' : ` severity="${rule.severity}"`
      parts.push(
        `<bv-rule${sev} id="${escapeHtmlText(rid)}">` +
          `${escapeHtmlText(rule.text)}</bv-rule>`,
      )
    }
  }

  if (narr.examples !== undefined) {
    parts.push(`<bv-examples>${escapeHtmlText(narr.examples)}</bv-examples>`)
  }

  for (const d of narr.diagrams ?? []) {
    const type = normalizeDiagramType(d.type)
    const title = d.title === undefined ? '' : ` title="${escapeHtmlText(d.title)}"`
    parts.push(
      `<bv-diagram type="${type}"${title}><pre><code>` +
        `${escapeHtmlText(d.content)}</code></pre></bv-diagram>`,
    )
  }
}

function appendFacts(parts: string[], facts: Fact[]): void {
  for (const fact of facts) {
    const {category} = fact
    const attrs: string[] = []
    if (fact.subject !== undefined) {
      attrs.push(`subject="${escapeHtmlText(fact.subject)}"`)
    }

    const normalisedCategory = normalizeFactCategory(category)
    if (normalisedCategory !== undefined) {
      attrs.push(`category="${normalisedCategory}"`)
    }

    if (fact.value !== undefined) {
      attrs.push(`value="${escapeHtmlText(fact.value)}"`)
    }

    const attrPart = attrs.length === 0 ? '' : ` ${attrs.join(' ')}`
    parts.push(
      `<bv-fact${attrPart}>${escapeHtmlText(fact.statement)}</bv-fact>`,
    )
  }
}

function appendExtraRules(
  parts: string[],
  rules: RuleEntry[],
  ruleIds: Set<string>,
): void {
  for (const rule of rules) {
    const rid = uniquifyId(rule.id, ruleIds)
    const sev = rule.severity === undefined ? '' : ` severity="${rule.severity}"`
    parts.push(
      `<bv-rule${sev} id="${escapeHtmlText(rid)}">` +
        `${escapeHtmlText(rule.text)}</bv-rule>`,
    )
  }
}

function appendExtraPatterns(parts: string[], patterns: string[]): void {
  for (const p of patterns) {
    parts.push(`<bv-pattern>${escapeHtmlText(p)}</bv-pattern>`)
  }
}

function appendExtraDecisions(parts: string[], decisions: string[]): void {
  for (const d of decisions) {
    parts.push(`<bv-decision>${escapeHtmlText(d)}</bv-decision>`)
  }
}

/**
 * Detect legacy `---`-separated snippets in the body. A "snippet"
 * only exists when the body contains an explicit `\n---\n` ruler
 * AFTER frontmatter has been stripped.
 */
export function extractSnippetsFromBody(body: string): string[] {
  if (!body.includes('\n---\n')) return []
  const masked = maskFencedBlocks(body)
  const dropSpans: Array<[number, number]> = []
  for (const heading of ['Relations', 'Reason', 'Raw Concept', 'Narrative', 'Facts']) {
    const pattern = sectionStripPattern(heading)
    for (const m of masked.matchAll(pattern)) {
      if (m.index === undefined) continue
      dropSpans.push([m.index, m.index + m[0].length])
    }
  }

  // Strip orphan ## X sections too — they're routed elsewhere and must
  // not count as snippets here. Skip canonical headings (case-insensitive)
  // so a lowercase canonical heading adjacent to a `---` snippet doesn't
  // produce an unterminated drop span that swallows the snippet on merge.
  SECTION_REGEX.lastIndex = 0
  for (const m of masked.matchAll(SECTION_REGEX)) {
    if (m.index === undefined) continue
    const heading = (m[1] ?? '').trim()
    if (KNOWN_SECTION_HEADINGS_LOWER.has(heading.toLowerCase())) continue
    dropSpans.push([m.index, m.index + m[0].length])
  }

  dropSpans.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const [s, e] of dropSpans) {
    const last = merged.at(-1)
    if (last !== undefined && s <= last[1]) {
      last[1] = Math.max(last[1], e)
    } else {
      merged.push([s, e])
    }
  }

  const pieces: string[] = []
  let cursor = 0
  for (const [s, e] of merged) {
    pieces.push(body.slice(cursor, s))
    cursor = e
  }

  pieces.push(body.slice(cursor))
  const residual = pieces.join('').trim()

  const snippets: string[] = []
  for (const snippet of residual.split(/(?:^|\n)---\n/)) {
    const t = snippet.trim()
    if (t.length === 0) continue
    if (t === 'No context available.') continue
    snippets.push(t)
  }

  return snippets
}

/**
 * One-shot conversion of a markdown topic to its bv-topic HTML
 * equivalent. Returns `{html, warnings}`. Pure function — no disk IO.
 */
export function convertMarkdownTopicToHtml(input: ConvertInput): ConvertResult {
  const {markdown, mtimeMs, relPath} = input
  const warnings: string[] = []
  const topicPath = relPathToTopicPath(relPath)

  const normalised = markdown.endsWith('\n') ? markdown : `${markdown}\n`
  const fmParse = parseFrontmatter(normalised)
  const frontmatter = fmParse.frontmatter ?? {}

  if (fmParse.parseError !== undefined) {
    warnings.push(`malformed-frontmatter: ${fmParse.parseError}`)
  }

  warnings.push(
    ...checkYamlHashHazard(fmParse.yamlBlock),
    ...checkUnknownFrontmatterKeys(frontmatter),
  )

  const {body} = fmParse

  // Title: frontmatter -> body H1 (case 1) -> path slug.
  const fmTitle = optStrTyped(frontmatter.title, 'title', warnings)
  const title = fmTitle ?? extractH1Title(body) ?? topicPath.split('/').at(-1) ?? topicPath

  // Summary: frontmatter -> orphan ## Abstract / ## Overview (later) ->
  // lede paragraph (case 4) -> empty.
  let summary =
    optStrTyped(frontmatter.summary, 'summary', warnings) ??
    optStrTyped(frontmatter.short_description, 'short_description', warnings) ??
    ''

  const tags = strListTyped(frontmatter.tags, 'tags', warnings)
  const keywords = strListTyped(frontmatter.keywords, 'keywords', warnings)
  // Match Python: `_str_list_typed(related, …) or _str_list_typed(relateds, …)`.
  // Calling `strListTyped` twice on the same field re-emits any
  // type-mismatch warning it pushed the first time — store the result.
  const relatedPrimary = strListTyped(frontmatter.related, 'related', warnings)
  const relatedSource =
    relatedPrimary.length > 0
      ? relatedPrimary
      : strListTyped(frontmatter.relateds, 'relateds', warnings)
  const related = htmlRelatedPaths(relatedSource)

  const createdAtRaw = optStrTyped(frontmatter.createdAt, 'createdAt', warnings)
  const updatedAtRaw = optStrTyped(frontmatter.updatedAt, 'updatedAt', warnings)
  const fallback = toIso(new Date(mtimeMs))
  let createdAt = createdAtRaw
  let updatedAt = updatedAtRaw
  if (createdAt === undefined || updatedAt === undefined) {
    warnings.push(`missing-timestamps: using stat.mtime fallback (${fallback})`)
    createdAt = createdAt ?? fallback
    updatedAt = updatedAt ?? fallback
  }

  // Canonical parsing.
  const rcResult = parseRawConcept(body)
  warnings.push(...rcResult.warnings)
  const narrResult = parseNarrative(body)
  warnings.push(...narrResult.warnings)
  const {narrative} = narrResult
  const facts = parseFacts(body)
  let reason = parseReason(body)

  // Orphan section heuristic (case 2).
  const orphan = processOrphanSections({
    body,
    canonicalNarrative: narrative,
    canonicalReason: reason,
    canonicalSummaryAttr: summary,
  })
  warnings.push(...orphan.warnings)

  // Merge canonical + orphan-discovered content. Canonical wins.
  if (reason === undefined && orphan.extras.reason !== undefined) {
    reason = orphan.extras.reason
  }

  for (const key of ['structure', 'dependencies', 'highlights', 'examples'] as const) {
    if (narrative[key] === undefined && orphan.extras[key] !== undefined) {
      narrative[key] = orphan.extras[key]
    }
  }

  // Matches Python lines 1256-1261. Note the asymmetry:
  //   - rules + patterns combine narrative_extras + orphan_extras
  //   - decisions + facts include only orphan_extras (narrative_extras
  //     entries are silently discarded by the oracle)
  // The TS port preserves this exactly for byte parity.
  const extraRules: RuleEntry[] = [...(orphan.extras.rules ?? [])]
  const extraPatterns: string[] = [
    ...(narrResult.extras.patterns ?? []),
    ...(orphan.extras.patterns ?? []),
  ]
  const extraDecisions: string[] = [...(orphan.extras.decisions ?? [])]
  const extraFacts: Fact[] = [...(orphan.extras.facts ?? [])]

  // Case 4 final fallback: hoist lede paragraph if summary still empty.
  if (summary.length === 0 && orphan.extras.summaryAttrOverride !== undefined) {
    summary = orphan.extras.summaryAttrOverride
  }

  if (summary.length === 0) {
    const lede = extractLedeParagraph(body)
    if (lede !== undefined) {
      summary = lede.split(/\n\s*\n/, 1)[0]?.trim() ?? ''
    }
  }

  // Case 6: every fenced block anywhere → bv-diagram. Dedup against
  // canonical ### Diagrams extraction.
  const dSpan = diagramsSectionSpan(body)
  const excludeSpans: Array<[number, number]> = dSpan === undefined ? [] : [dSpan]
  const extraDiagrams: Diagram[] = extractAllFencedBlocks(body, excludeSpans)
  if (extraDiagrams.length > 0) {
    narrative.diagrams = [...(narrative.diagrams ?? []), ...extraDiagrams]
  }

  const snippets = extractSnippetsFromBody(body)
  if (snippets.length > 0) {
    warnings.push(
      `dropped-snippets: ${snippets.length} legacy '---'-separated snippets discarded (no <bv-snippet> element)`,
    )
  }

  // Assemble topic attributes.
  const attrs: string[] = [
    `path="${escapeHtmlText(topicPath)}"`,
    `title="${escapeHtmlText(title)}"`,
  ]
  if (summary.length > 0) attrs.push(`summary="${escapeHtmlText(summary)}"`)
  if (tags.length > 0) attrs.push(`tags="${escapeHtmlText(tags.join(','))}"`)
  if (keywords.length > 0) attrs.push(`keywords="${escapeHtmlText(keywords.join(','))}"`)
  if (related.length > 0) attrs.push(`related="${escapeHtmlText(related.join(','))}"`)
  attrs.push(
    `createdat="${escapeHtmlText(createdAt)}"`,
    `updatedat="${escapeHtmlText(updatedAt)}"`,
  )

  const bodyParts: string[] = []
  const ruleIdRegistry = new Set<string>()
  appendReason(bodyParts, reason)
  appendRawConcept(bodyParts, rcResult.rawConcept)
  appendNarrative(bodyParts, narrative, ruleIdRegistry)
  appendFacts(bodyParts, [...facts, ...extraFacts])
  appendExtraRules(bodyParts, extraRules, ruleIdRegistry)
  appendExtraPatterns(bodyParts, extraPatterns)
  appendExtraDecisions(bodyParts, extraDecisions)

  const inner =
    bodyParts.length === 0 ? '' : `\n  ${bodyParts.join('\n  ')}\n`
  const html = `<bv-topic ${attrs.join(' ')}>${inner}</bv-topic>`
  return {html, warnings}
}

