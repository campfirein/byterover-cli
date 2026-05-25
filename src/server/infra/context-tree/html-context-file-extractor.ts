import type {Narrative, RawConcept} from '../../core/domain/knowledge/markdown-writer.js'
import type {ElementNode} from '../../core/domain/render/element-types.js'
import type {ContextFileContent} from '../../core/interfaces/context-tree/i-context-file-reader.js'

import {getInnerText, parseHtml, walkElements} from '../render/reader/html-parser.js'

/**
 * Extract a `ContextFileContent` from an HTML topic file.
 *
 * Format-aware counterpart to `MarkdownWriter.parseContent`: produces the
 * same return shape, but sources fields from `<bv-topic>` attributes +
 * typed `<bv-*>` child elements instead of YAML frontmatter + markdown
 * sections. Used by `FileContextFileReader` when the input is `.html`.
 *
 * Field mapping (HTML → ContextFileContent):
 *   <bv-topic title>             → title  (falls back to fallbackTitle)
 *   <bv-topic tags>              → tags   (comma-split, trimmed)
 *   <bv-topic keywords>          → keywords  (comma-split, trimmed)
 *   <bv-task>                    → rawConcept.task
 *   <bv-changes> > <li>          → rawConcept.changes[]
 *   <bv-files> > <li>            → rawConcept.files[]
 *   <bv-flow>                    → rawConcept.flow
 *   <bv-timestamp>               → rawConcept.timestamp
 *   <bv-author>                  → rawConcept.author
 *   <bv-pattern>                 → rawConcept.patterns[]  (with flags + description attrs)
 *   <bv-structure>               → narrative.structure
 *   <bv-dependencies>            → narrative.dependencies
 *   <bv-highlights>              → narrative.highlights
 *   <bv-rule>                    → narrative.rules  (siblings serialised as bullet list)
 *   <bv-examples>                → narrative.examples
 *   <bv-diagram>                 → narrative.diagrams[]  (with type + title attrs)
 *
 * Not yet exposed (interface gap on ContextFileContent — follow-up):
 *   <bv-topic summary>, <bv-topic related>, <bv-fact>, <bv-decision>,
 *   <bv-bug>, <bv-fix>.
 */
export function parseHtmlContextContent(
  content: string,
  fallbackTitle: string,
  relativePath: string,
): ContextFileContent {
  const document = parseHtml(content)
  const topic = walkElements(document).find((e) => e.tagName === 'bv-topic')

  // Scope all subsequent element extraction to the `<bv-topic>` subtree.
  // Stray sibling bv-* elements outside the topic (malformed input, or
  // a future format with multiple roots) are intentionally ignored —
  // matches the "fields are sourced from <bv-topic> children" contract.
  // If no topic root was found, fall through with an empty scope so the
  // result has all-empty fields rather than crashing.
  const scope: readonly ElementNode[] = topic ? walkElements(topic) : []
  const attrs = topic?.attributes ?? {}

  const title = attrs.title?.trim() ? attrs.title.trim() : fallbackTitle
  const tags = parseCsvAttribute(attrs.tags)
  const keywords = parseCsvAttribute(attrs.keywords)

  const rawConcept = extractRawConcept(scope)
  const narrative = extractNarrative(scope)

  return {
    content,
    keywords,
    ...(narrative !== undefined && {narrative}),
    path: relativePath,
    ...(rawConcept !== undefined && {rawConcept}),
    tags,
    title,
  }
}

// ── Internal helpers ──────────────────────────────────────────────

function parseCsvAttribute(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function extractRawConcept(elements: readonly ElementNode[]): RawConcept | undefined {
  const rawConcept: RawConcept = {}

  const taskNode = elements.find((e) => e.tagName === 'bv-task')
  if (taskNode) {
    const text = getInnerText(taskNode).trim()
    if (text) rawConcept.task = text
  }

  const changesNode = elements.find((e) => e.tagName === 'bv-changes')
  if (changesNode) {
    const items = extractListItems(changesNode)
    if (items.length > 0) rawConcept.changes = items
  }

  const filesNode = elements.find((e) => e.tagName === 'bv-files')
  if (filesNode) {
    const items = extractListItems(filesNode)
    if (items.length > 0) rawConcept.files = items
  }

  const flowNode = elements.find((e) => e.tagName === 'bv-flow')
  if (flowNode) {
    const text = getInnerText(flowNode).trim()
    if (text) rawConcept.flow = text
  }

  const timestampNode = elements.find((e) => e.tagName === 'bv-timestamp')
  if (timestampNode) {
    const text = getInnerText(timestampNode).trim()
    if (text) rawConcept.timestamp = text
  }

  const authorNode = elements.find((e) => e.tagName === 'bv-author')
  if (authorNode) {
    const text = getInnerText(authorNode).trim()
    if (text) rawConcept.author = text
  }

  const patternNodes = elements.filter((e) => e.tagName === 'bv-pattern')
  if (patternNodes.length > 0) {
    const patterns: Array<{description: string; flags?: string; pattern: string}> = []
    for (const node of patternNodes) {
      const pattern = getInnerText(node).trim()
      if (!pattern) continue
      const description = node.attributes.description?.trim() ?? ''
      const flags = node.attributes.flags?.trim()
      patterns.push({
        description,
        pattern,
        ...(flags && {flags}),
      })
    }

    if (patterns.length > 0) rawConcept.patterns = patterns
  }

  return Object.keys(rawConcept).length === 0 ? undefined : rawConcept
}

function extractNarrative(elements: readonly ElementNode[]): Narrative | undefined {
  const narrative: Narrative = {}

  const structureNode = elements.find((e) => e.tagName === 'bv-structure')
  if (structureNode) {
    const text = getInnerText(structureNode).trim()
    if (text) narrative.structure = text
  }

  const dependenciesNode = elements.find((e) => e.tagName === 'bv-dependencies')
  if (dependenciesNode) {
    const text = getInnerText(dependenciesNode).trim()
    if (text) narrative.dependencies = text
  }

  const highlightsNode = elements.find((e) => e.tagName === 'bv-highlights')
  if (highlightsNode) {
    const text = getInnerText(highlightsNode).trim()
    if (text) narrative.highlights = text
  }

  const examplesNode = elements.find((e) => e.tagName === 'bv-examples')
  if (examplesNode) {
    const text = getInnerText(examplesNode).trim()
    if (text) narrative.examples = text
  }

  // Multiple `<bv-rule>` siblings are aggregated into a single bullet list
  // matching the markdown-writer's `### Rules` render format. The MD shape
  // for narrative.rules is freeform string; we serialise structured HTML
  // rules deterministically so the cogit push / webui consumers see the
  // same shape they used to. Prefix is built from parts so spacing is
  // correct in every combination (severity-only, id-only, both, neither).
  const ruleNodes = elements.filter((e) => e.tagName === 'bv-rule')
  if (ruleNodes.length > 0) {
    const lines: string[] = []
    for (const node of ruleNodes) {
      const text = getInnerText(node).trim()
      if (!text) continue
      const severity = node.attributes.severity?.trim()
      const id = node.attributes.id?.trim()
      const prefixParts: string[] = []
      if (severity) prefixParts.push(`[${severity}]`)
      if (id) prefixParts.push(`(${id})`)
      const prefix = prefixParts.length > 0 ? `${prefixParts.join(' ')}: ` : ''
      lines.push(`- ${prefix}${text}`)
    }

    if (lines.length > 0) narrative.rules = lines.join('\n')
  }

  // Multiple `<bv-diagram>` siblings → structured list. Type defaults to
  // 'other' when the attribute is absent (mirrors the MD writer's behaviour).
  const diagramNodes = elements.filter((e) => e.tagName === 'bv-diagram')
  if (diagramNodes.length > 0) {
    const diagrams: Array<{content: string; title?: string; type: string}> = []
    for (const node of diagramNodes) {
      const text = getInnerText(node).trim()
      if (!text) continue
      const type = node.attributes.type?.trim() ?? 'other'
      const title = node.attributes.title?.trim()
      diagrams.push({
        content: text,
        type,
        ...(title && {title}),
      })
    }

    if (diagrams.length > 0) narrative.diagrams = diagrams
  }

  return Object.keys(narrative).length === 0 ? undefined : narrative
}

/**
 * Extract `<li>` items from a container element (e.g. `<bv-changes>` or
 * `<bv-files>` with a nested `<ul>` or `<ol>`). Returns an empty array
 * when no `<li>` children are present — the schema documents `<li>`
 * children as the expected shape, and `getInnerText` collapses
 * whitespace (so a newline-based fallback wouldn't be reachable in
 * practice). Matches the markdown writer's strictness: MD-side bullets
 * that don't start with `- ` are also dropped.
 */
function extractListItems(container: ElementNode): string[] {
  return walkElements(container)
    .filter((e) => e.tagName === 'li')
    .map((li) => getInnerText(li).trim())
    .filter((s) => s.length > 0)
}
