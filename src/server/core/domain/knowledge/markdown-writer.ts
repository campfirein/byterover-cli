import {dump as yamlDump, load as yamlLoad} from 'js-yaml'

import { normalizeRelationPath, parseRelations } from './relation-parser.js'

export interface RawConcept {
  author?: string
  changes?: string[]
  files?: string[]
  flow?: string
  patterns?: Array<{description: string; flags?: string; pattern: string;}>
  task?: string
  timestamp?: string
}

export interface Narrative {
  dependencies?: string
  diagrams?: Array<{content: string; title?: string; type: string}>
  examples?: string
  highlights?: string
  rules?: string
  structure?: string
}

export interface Fact {
  category?: string
  statement: string
  subject?: string
  value?: string
}

/**
 * Content timestamps kept in markdown frontmatter. `createdAt` is the
 * immutable creation time; `updatedAt` reflects the last content
 * modification. Runtime ranking signals (importance, recency, maturity,
 * accessCount, updateCount) live in the sidecar — see
 * `features/runtime-signals/plan.md`.
 */
export interface ContextTimestamps {
  createdAt?: string
  updatedAt?: string
}

export interface ContextData {
  facts?: Fact[]
  keywords: string[]
  name: string
  narrative?: Narrative
  rawConcept?: RawConcept
  reason?: string
  relations?: string[]
  snippets: string[]
  summary?: string
  tags: string[]
  timestamps?: ContextTimestamps
}

/**
 * Fields carried in the markdown frontmatter block. Post-commit-5 this
 * covers only semantic content and content timestamps; runtime ranking
 * signals live in the sidecar.
 *
 * `parseFrontmatter` may return instances that also carry legacy fields
 * (importance, recency, maturity, accessCount, updateCount) on files
 * written before the migration. Those are silently ignored — the typed
 * shape only exposes what commit 5 and later writers produce.
 */
interface Frontmatter {
  createdAt?: string
  keywords: string[]
  related: string[]
  summary?: string
  tags: string[]
  title?: string
  updatedAt?: string
}

/**
 * Frontmatter shape with all seven semantic fields guaranteed present.
 * Produced by `validateSemanticFrontmatter` in lenient mode.
 */
export interface CompleteFrontmatter {
  createdAt: string
  keywords: string[]
  related: string[]
  summary: string
  tags: string[]
  title: string
  updatedAt: string
}

const REQUIRED_STRING_FIELDS = ['title', 'summary'] as const
// tags and keywords are structurally required by the input type signature
// (Partial<CompleteFrontmatter> & {keywords: string[]; tags: string[]});
// only 'related' needs a runtime presence check here.
const REQUIRED_ARRAY_FIELDS = ['related'] as const
const REQUIRED_TIMESTAMP_FIELDS = ['createdAt', 'updatedAt'] as const

/**
 * Validate that a parsed frontmatter object contains all seven required
 * semantic fields.
 *
 * **Strict mode** — throws if any required field is missing. Used for
 * new-write paths (curate ADD, review-api-handler) and test fixtures.
 *
 * **Lenient mode** — synthesises safe defaults in-memory for any missing
 * field (`""` for strings, `[]` for arrays, `now()` for timestamps) and
 * emits a single `console.warn`. Does NOT rewrite the file on read.
 * Used for the legacy read path.
 */
export function validateSemanticFrontmatter(
  frontmatter: Partial<CompleteFrontmatter> & {keywords: string[]; tags: string[]},
  mode: 'lenient' | 'strict',
  filePath: string,
): CompleteFrontmatter {
  const missing: string[] = []

  for (const field of REQUIRED_STRING_FIELDS) {
    if (frontmatter[field] === undefined) missing.push(field)
  }

  for (const field of REQUIRED_ARRAY_FIELDS) {
    if (frontmatter[field] === undefined) missing.push(field)
  }

  for (const field of REQUIRED_TIMESTAMP_FIELDS) {
    if (frontmatter[field] === undefined) missing.push(field)
  }

  if (missing.length === 0) {
    return frontmatter as CompleteFrontmatter
  }

  if (mode === 'strict') {
    throw new Error(
      `Missing required frontmatter fields in ${filePath}: ${missing.join(', ')}`,
    )
  }

  // Lenient: synthesise defaults
  const now = new Date().toISOString()
  const result: CompleteFrontmatter = {
    createdAt: frontmatter.createdAt ?? frontmatter.updatedAt ?? now,
    keywords: frontmatter.keywords,
    related: frontmatter.related ?? [],
    summary: frontmatter.summary ?? '',
    tags: frontmatter.tags,
    title: frontmatter.title ?? '',
    updatedAt: frontmatter.updatedAt ?? now,
  }

  console.warn(`[frontmatter] Missing required fields in ${filePath}: ${missing.join(', ')}`)

  return result
}

interface ParsedFrontmatter {
  body: string
  frontmatter: Frontmatter
}

/**
 * Generate YAML frontmatter block from context data.
 *
 * Emits only semantic fields and content timestamps. Runtime ranking
 * signals (importance, recency, maturity, accessCount, updateCount) are
 * not written — they live in the sidecar store since commit 5 of the
 * runtime-signals migration.
 */
function generateFrontmatter(
  title: string,
  relations?: string[],
  tags: string[] = [],
  keywords: string[] = [],
  timestamps?: ContextTimestamps,
  summary?: string,
): string {
  const normalizedRelations = (relations || []).map(rel => normalizeRelationPath(rel))

  const now = new Date().toISOString()
  const createdAt = timestamps?.createdAt ?? timestamps?.updatedAt ?? now
  const updatedAt = timestamps?.updatedAt ?? createdAt

  // Field order is enforced by insertion order (yamlDump uses sortKeys:false).
  // Must match migration script's buildCompleteFrontmatter() for idempotency.
  const fm: Record<string, string | string[]> = {}
  fm.title = title ?? ''
  fm.summary = summary ?? ''
  fm.tags = tags
  fm.related = normalizedRelations
  fm.keywords = keywords
  fm.createdAt = createdAt
  fm.updatedAt = updatedAt

  const yamlContent = yamlDump(fm, { flowLevel: 1, lineWidth: -1, sortKeys: false }).trimEnd()

  return `---\n${yamlContent}\n---\n`
}

/**
 * Parse YAML frontmatter from markdown content.
 * Returns null if no frontmatter is found (backward compat with old format).
 *
 * Exported for cross-module reuse by daemon-side telemetry harvest
 * (M12.3: AnalyticsHook reads frontmatter from affected files post-op
 * to populate per-event `tags` / `keywords` / `related` arrays). Existing
 * in-file callers are unaffected by the export-keyword addition.
 */
export function parseFrontmatter(content: string): null | ParsedFrontmatter {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return null
  }

  const endIndex = content.indexOf('\n---\n', 4)
  const endIndexCrlf = content.indexOf('\r\n---\r\n', 5)
  const actualEnd = endIndex === -1 ? endIndexCrlf : endIndex

  if (actualEnd < 0) {
    return null
  }

  const isCrlf = endIndex === -1
  const yamlBlock = content.slice(isCrlf ? 5 : 4, actualEnd)
  const delimiterLen = isCrlf ? 7 : 5  // '\r\n---\r\n' = 7, '\n---\n' = 5
  const body = content.slice(actualEnd + delimiterLen)

  try {
    const parsed = yamlLoad(yamlBlock) as null | Record<string, unknown>

    if (!parsed || typeof parsed !== 'object') {
      return null
    }

    const frontmatter: Frontmatter = {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.filter((k): k is string => typeof k === 'string') : [],
      related: Array.isArray(parsed.related) ? parsed.related.filter((r): r is string => typeof r === 'string') : [],
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t): t is string => typeof t === 'string') : [],
    }

    if (typeof parsed.title === 'string') {
      frontmatter.title = parsed.title
    }

    if (typeof parsed.summary === 'string') {
      frontmatter.summary = parsed.summary
    }

    // Content timestamps (createdAt is immutable, updatedAt tracks real
    // content modification). Pre-migration files may also carry legacy
    // scoring fields (importance, recency, maturity, accessCount,
    // updateCount) — those are silently ignored here; the runtime signals
    // they represented now live in the sidecar.
    if (typeof parsed.createdAt === 'string') {
      frontmatter.createdAt = parsed.createdAt
    }

    if (typeof parsed.updatedAt === 'string') {
      frontmatter.updatedAt = parsed.updatedAt
    }

    return { body, frontmatter }
  } catch {
    return null
  }
}

/**
 * Normalizes newline characters in text.
 * Converts literal \n strings to actual newlines.
 */
function normalizeNewlines(text: string): string {
  return text.replaceAll(String.raw`\n`, '\n');
}

function generateRawConceptSection(rawConcept?: RawConcept): string {
  if (!rawConcept) {
    return ''
  }

  const parts: string[] = []

  if (rawConcept.task) {
    parts.push(`**Task:**\n${normalizeNewlines(rawConcept.task)}`)
  }

  if (rawConcept.changes && rawConcept.changes.length > 0) {
    parts.push(`**Changes:**\n${rawConcept.changes.map(c => `- ${normalizeNewlines(c)}`).join('\n')}`)
  }

  if (rawConcept.files && rawConcept.files.length > 0) {
    parts.push(`**Files:**\n${rawConcept.files.map(f => `- ${normalizeNewlines(f)}`).join('\n')}`)
  }

  if (rawConcept.flow) {
    parts.push(`**Flow:**\n${normalizeNewlines(rawConcept.flow)}`)
  }

  if (rawConcept.timestamp) {
    parts.push(`**Timestamp:** ${normalizeNewlines(rawConcept.timestamp)}`)
  }

  if (rawConcept.author) {
    parts.push(`**Author:** ${rawConcept.author}`)
  }

  if (rawConcept.patterns && rawConcept.patterns.length > 0) {
    const patternsText = rawConcept.patterns.map(p =>
      `- \`${p.pattern}\`${p.flags ? ` (flags: ${p.flags})` : ''} - ${p.description}`
    ).join('\n')
    parts.push(`**Patterns:**\n${patternsText}`)
  }

  if (parts.length === 0) {
    return ''
  }

  return `\n## Raw Concept\n${parts.join('\n\n')}\n`
}

function generateNarrativeSection(narrative?: Narrative): string {
  if (!narrative) {
    return ''
  }

  const parts: string[] = []

  if (narrative.structure) {
    parts.push(`### Structure\n${normalizeNewlines(narrative.structure)}`)
  }

  if (narrative.dependencies) {
    parts.push(`### Dependencies\n${normalizeNewlines(narrative.dependencies)}`)
  }

  if (narrative.highlights) {
    parts.push(`### Highlights\n${normalizeNewlines(narrative.highlights)}`)
  }

  if (narrative.rules) {
    parts.push(`### Rules\n${narrative.rules}`)
  }

  if (narrative.examples) {
    parts.push(`### Examples\n${narrative.examples}`)
  }

  if (narrative.diagrams && narrative.diagrams.length > 0) {
    const diagramParts = narrative.diagrams.map(d => {
      const lang = d.type === 'ascii' ? '' : d.type
      const titleLine = d.title ? `**${d.title}**\n` : ''
      return `${titleLine}\`\`\`${lang}\n${d.content}\n\`\`\``
    })
    parts.push(`### Diagrams\n${diagramParts.join('\n\n')}`)
  }

  if (parts.length === 0) {
    return ''
  }

  return `\n## Narrative\n${parts.join('\n\n')}\n`
}

function generateFactsSection(facts?: Fact[]): string {
  if (!facts || facts.length === 0) {
    return ''
  }

  const lines = facts.map(fact => {
    const categoryPart = fact.category ? ` [${fact.category}]` : ''
    if (fact.subject) {
      return `- **${fact.subject}**: ${fact.statement}${categoryPart}`
    }

    return `- ${fact.statement}${categoryPart}`
  })

  return `\n## Facts\n${lines.join('\n')}\n`
}

function parseRawConceptSection(content: string): RawConcept | undefined {
  // Forgiving regex: allows optional whitespace after "## Raw Concept"
  const rawConceptMatch = content.match(/##\s*Raw Concept\s*\n([\s\S]*?)(?=\n##\s|\n---\n|$)/i)
  if (!rawConceptMatch) {
    return undefined
  }

  const sectionContent = rawConceptMatch[1]
  const rawConcept: RawConcept = {}

  // Forgiving: allows whitespace around "Task:" and after the newline
  const taskMatch = sectionContent.match(/\*\*\s*Task\s*:\s*\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n##|$)/i)
  if (taskMatch) {
    rawConcept.task = taskMatch[1].trim()
  }

  const changesMatch = sectionContent.match(/\*\*\s*Changes\s*:\s*\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n##|$)/i)
  if (changesMatch) {
    rawConcept.changes = changesMatch[1]
      .split('\n')
      .filter(line => line.trim().startsWith('- '))
      .map(line => line.trim().slice(2))
  }

  const filesMatch = sectionContent.match(/\*\*\s*Files\s*:\s*\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n##|$)/i)
  if (filesMatch) {
    rawConcept.files = filesMatch[1]
      .split('\n')
      .filter(line => line.trim().startsWith('- '))
      .map(line => line.trim().slice(2))
  }

  const flowMatch = sectionContent.match(/\*\*\s*Flow\s*:\s*\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n##|$)/i)
  if (flowMatch) {
    rawConcept.flow = flowMatch[1].trim()
  }

  // Timestamp can be inline, so more flexible pattern
  const timestampMatch = sectionContent.match(/\*\*\s*Timestamp\s*:\s*\*\*\s*(.+)/i)
  if (timestampMatch) {
    rawConcept.timestamp = timestampMatch[1].trim()
  }

  // Author can be inline
  const authorMatch = sectionContent.match(/\*\*\s*Author\s*:\s*\*\*\s*(.+)/i)
  if (authorMatch) {
    rawConcept.author = authorMatch[1].trim()
  }

  // Patterns is multi-line with list items
  const patternsMatch = sectionContent.match(/\*\*\s*Patterns\s*:\s*\*\*\s*\n([\s\S]*?)(?=\n\*\*|\n##|$)/i)
  if (patternsMatch) {
    const patterns: Array<{description: string; flags?: string; pattern: string;}> = []
    for (const line of patternsMatch[1]
      .split('\n')
      .filter(line => line.trim().startsWith('- `'))) {
        const match = line.match(/- `(.+?)`(?:\s*\(flags:\s*(.+?)\))?\s*-\s*(.+)/)
        if (match) {
          patterns.push({
            description: match[3].trim(),
            pattern: match[1],
            ...(match[2] ? {flags: match[2]} : {})
          })
        }
      }

    if (patterns.length > 0) {
      rawConcept.patterns = patterns
    }
  }

  if (Object.keys(rawConcept).length === 0) {
    return undefined
  }

  return rawConcept
}

function parseNarrativeSection(content: string): Narrative | undefined {
  // Forgiving regex: allows optional whitespace after "## Narrative"
  const narrativeMatch = content.match(/##\s*Narrative\s*\n([\s\S]*?)(?=\n##\s[^#]|\n---\n|$)/i)
  if (!narrativeMatch) {
    return undefined
  }

  const sectionContent = narrativeMatch[1]
  const narrative: Narrative = {}

  // Forgiving: allows whitespace after "### Structure"
  const structureMatch = sectionContent.match(/###\s*Structure\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/i)
  if (structureMatch) {
    narrative.structure = structureMatch[1].trim()
  }

  const dependenciesMatch = sectionContent.match(/###\s*Dependencies\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/i)
  if (dependenciesMatch) {
    narrative.dependencies = dependenciesMatch[1].trim()
  }

  const highlightsMatch = sectionContent.match(/###\s*(?:Highlights|Features)\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/i)
  if (highlightsMatch) {
    narrative.highlights = highlightsMatch[1].trim()
  }

  const rulesMatch = sectionContent.match(/###\s*Rules\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/i)
  if (rulesMatch) {
    narrative.rules = rulesMatch[1].trim()
  }

  const examplesMatch = sectionContent.match(/###\s*Examples\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/i)
  if (examplesMatch) {
    narrative.examples = examplesMatch[1].trim()
  }

  const diagramsMatch = sectionContent.match(/###\s*Diagrams\s*\n([\s\S]*?)(?=\n###\s|\n##\s|$)/i)
  if (diagramsMatch) {
    const diagrams: Array<{content: string; title?: string; type: string}> = []
    const blockRegex = /(?:\*\*(.+?)\*\*\n)?```(\w*)\n([\s\S]*?)```/g
    let match
    while ((match = blockRegex.exec(diagramsMatch[1])) !== null) {
      diagrams.push({
        content: match[3].trimEnd(),
        ...(match[1] ? {title: match[1]} : {}),
        type: match[2] || 'ascii',
      })
    }

    if (diagrams.length > 0) {
      narrative.diagrams = diagrams
    }
  }

  if (Object.keys(narrative).length === 0) {
    return undefined
  }

  return narrative
}

function parseFactsSection(content: string): Fact[] | undefined {
  const factsMatch = content.match(/##\s*Facts\s*\n([\s\S]*?)(?=\n##\s|\n---\n|$)/i)
  if (!factsMatch) {
    return undefined
  }

  const facts: Fact[] = []
  const lines = factsMatch[1].split('\n').filter(line => line.trim().startsWith('- '))

  for (const line of lines) {
    const trimmed = line.trim().slice(2) // remove "- "

    // Try to match "**subject**: statement [category]" pattern
    const structuredMatch = trimmed.match(/^\*\*(.+?)\*\*:\s*(.+?)(?:\s*\[(\w+)\])?$/)
    if (structuredMatch) {
      facts.push({
        statement: structuredMatch[2].trim(),
        subject: structuredMatch[1].trim(),
        ...(structuredMatch[3] ? {category: structuredMatch[3]} : {}),
      })

      continue
    }

    // Plain statement, optionally with [category]
    const plainMatch = trimmed.match(/^(.+?)(?:\s*\[(\w+)\])?$/)
    if (plainMatch) {
      facts.push({
        statement: plainMatch[1].trim(),
        ...(plainMatch[2] ? {category: plainMatch[2]} : {}),
      })
    }
  }

  return facts.length > 0 ? facts : undefined
}

function generateReasonSection(reason?: string): string {
  if (!reason) return ''
  return `\n## Reason\n${reason}\n`
}

function parseReasonSection(content: string): string | undefined {
  const match = content.match(/##\s*Reason\s*\n([\s\S]*?)(?=\n##\s|\n---\n|$)/i)
  if (!match) return undefined
  const text = match[1].trim()
  return text || undefined
}

function extractSnippetsFromContent(content: string): string[] {
  let snippetContent = content

  // Forgiving regex patterns for section removal
  const relationsMatch = content.match(/##\s*Relations[\s\S]*?(?=\n[^@\n]|$)/i)
  if (relationsMatch) {
    snippetContent = snippetContent.replace(relationsMatch[0], '').trim()
  }

  const reasonMatch = snippetContent.match(/##\s*Reason[\s\S]*?(?=\n##\s|\n---\n|$)/i)
  if (reasonMatch) {
    snippetContent = snippetContent.replace(reasonMatch[0], '').trim()
  }

  const rawConceptMatch = snippetContent.match(/##\s*Raw Concept[\s\S]*?(?=\n##\s|\n---\n|$)/i)
  if (rawConceptMatch) {
    snippetContent = snippetContent.replace(rawConceptMatch[0], '').trim()
  }

  const narrativeMatch = snippetContent.match(/##\s*Narrative[\s\S]*?(?=\n##\s|\n---\n|$)/i)
  if (narrativeMatch) {
    snippetContent = snippetContent.replace(narrativeMatch[0], '').trim()
  }

  const factsMatch = snippetContent.match(/##\s*Facts[\s\S]*?(?=\n##\s|\n---\n|$)/i)
  if (factsMatch) {
    snippetContent = snippetContent.replace(factsMatch[0], '').trim()
  }

  const snippets = snippetContent
    .split(/(?:^|\n)---\n/)
    .map(s => s.trim())
    .filter(s => s && s !== 'No context available.')

  return snippets
}

/**
 * Merges two RawConcept objects with the following strategy:
 *
 * **Scalars (task, flow, timestamp)**: Source wins (source.X || target.X)
 * - Rationale: The source represents "new" or "incoming" data that should
 *   take precedence over existing target data for singular values.
 *
 * **Arrays (changes, files)**: Concatenated and deduplicated (target first, then source)
 * - Rationale: For lists, we want to accumulate all entries rather than
 *   replacing them. Target entries are placed first to preserve order.
 *
 * @param source - The incoming/new RawConcept to merge (takes precedence for scalars)
 * @param target - The existing/base RawConcept to merge into
 * @returns Merged RawConcept or undefined if both inputs are empty
 */
function mergeRawConcepts(source?: RawConcept, target?: RawConcept): RawConcept | undefined {
  if (!source && !target) {
    return undefined
  }

  if (!source) return target
  if (!target) return source

  const merged: RawConcept = {}

  // Scalars: source wins (newer data takes precedence)
  merged.task = source.task || target.task
  merged.flow = source.flow || target.flow
  merged.timestamp = source.timestamp || target.timestamp
  merged.author = source.author || target.author

  // Arrays: concatenate and deduplicate (target first, then source)
  const allChanges = [...(target.changes || []), ...(source.changes || [])]
  if (allChanges.length > 0) {
    merged.changes = [...new Set(allChanges)]
  }

  const allFiles = [...(target.files || []), ...(source.files || [])]
  if (allFiles.length > 0) {
    merged.files = [...new Set(allFiles)]
  }

  // Patterns: concatenate and deduplicate by pattern+flags
  const allPatterns = [...(target.patterns || []), ...(source.patterns || [])]
  if (allPatterns.length > 0) {
    const seen = new Set<string>()
    merged.patterns = allPatterns.filter(p => {
      const key = p.pattern + (p.flags || '')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  if (Object.keys(merged).length === 0) {
    return undefined
  }

  return merged
}

function mergeNarratives(source?: Narrative, target?: Narrative): Narrative | undefined {
  if (!source && !target) {
    return undefined
  }

  if (!source) return target
  if (!target) return source

  const merged: Narrative = {}

  if (source.structure || target.structure) {
    const parts = [target.structure, source.structure].filter(Boolean)
    merged.structure = parts.join('\n\n')
  }

  if (source.dependencies || target.dependencies) {
    const parts = [target.dependencies, source.dependencies].filter(Boolean)
    merged.dependencies = parts.join('\n\n')
  }

  if (source.highlights || target.highlights) {
    const parts = [target.highlights, source.highlights].filter(Boolean)
    merged.highlights = parts.join('\n\n')
  }

  if (source.rules || target.rules) {
    const parts = [target.rules, source.rules].filter(Boolean)
    merged.rules = parts.join('\n\n')
  }

  if (source.examples || target.examples) {
    const parts = [target.examples, source.examples].filter(Boolean)
    merged.examples = parts.join('\n\n')
  }

  if (source.diagrams || target.diagrams) {
    const allDiagrams = [...(target.diagrams || []), ...(source.diagrams || [])]
    const seen = new Set<string>()
    merged.diagrams = allDiagrams.filter(d => {
      if (seen.has(d.content)) return false
      seen.add(d.content)
      return true
    })
  }

  if (Object.keys(merged).length === 0) {
    return undefined
  }

  return merged
}

function mergeFacts(source?: Fact[], target?: Fact[]): Fact[] | undefined {
  if (!source && !target) {
    return undefined
  }

  if (!source) return target
  if (!target) return source

  // Concatenate and deduplicate by statement text (case-insensitive)
  const seen = new Set<string>()
  const merged: Fact[] = []

  for (const fact of [...target, ...source]) {
    const key = fact.statement.toLowerCase().trim()
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(fact)
    }
  }

  return merged.length > 0 ? merged : undefined
}

/**
 * Extract the createdAt timestamp from a raw markdown file's frontmatter.
 * Used by callers (e.g. curate UPDATE) that need to preserve the immutable
 * creation time across a write without round-tripping through the full
 * parsed-content shape.
 */
export function parseCreatedAt(content: string): string | undefined {
  return parseFrontmatter(content)?.frontmatter.createdAt
}

function parseContentWithFrontmatter(content: string): {
  body: string
  keywords: string[]
  relations: string[]
  summary?: string
  tags: string[]
  timestamps?: ContextTimestamps
  title?: string
} {
  const parsed = parseFrontmatter(content)

  if (parsed) {
    const timestamps: ContextTimestamps = {}
    if (parsed.frontmatter.createdAt) timestamps.createdAt = parsed.frontmatter.createdAt
    if (parsed.frontmatter.updatedAt) timestamps.updatedAt = parsed.frontmatter.updatedAt

    return {
      body: parsed.body,
      keywords: parsed.frontmatter.keywords,
      relations: parsed.frontmatter.related,
      summary: parsed.frontmatter.summary,
      tags: parsed.frontmatter.tags,
      timestamps: Object.keys(timestamps).length > 0 ? timestamps : undefined,
      title: parsed.frontmatter.title,
    }
  }

  // Legacy format: parse @ relations from body
  return {
    body: content,
    keywords: [],
    relations: parseRelations(content),
    tags: [],
  }
}

export const MarkdownWriter = {
  generateContext(data: ContextData): string {
    const snippets = (data.snippets || []).filter(s => s && s.trim())
    const relations = data.relations || []

    const frontmatter = generateFrontmatter(data.name, relations, data.tags, data.keywords, data.timestamps, data.summary)
    const reasonSection = generateReasonSection(data.reason)
    const rawConceptSection = generateRawConceptSection(data.rawConcept)
    const narrativeSection = generateNarrativeSection(data.narrative)
    const factsSection = generateFactsSection(data.facts)

    const hasSnippets = snippets.length > 0

    // Build the content parts
    const parts: string[] = []

    // Add sections — reason first (WHY), then content sections, relations in frontmatter
    const sectionsContent = `${reasonSection}${rawConceptSection}${narrativeSection}${factsSection}`.trim()
    if (sectionsContent) {
      parts.push(sectionsContent)
    }

    // Add snippets if present
    if (hasSnippets) {
      const snippetsContent = snippets.join('\n\n---\n\n')
      parts.push(snippetsContent)
    }

    // If nothing at all, return empty (should not happen in practice)
    if (parts.length === 0 && !frontmatter) {
      return ''
    }

    // Join parts with separator only if we have both sections and snippets
    const body = parts.length > 0 ? parts.join('\n\n---\n\n') + '\n' : ''

    return `${frontmatter}${body}`
  },

  mergeContexts(sourceContent: string, targetContent: string, reason?: string, summary?: string): string {
    const sourceParsed = parseContentWithFrontmatter(sourceContent)
    const targetParsed = parseContentWithFrontmatter(targetContent)
    const mergedRelations = [...new Set([...sourceParsed.relations, ...targetParsed.relations])]

    const mergedTags = [...new Set([...sourceParsed.tags, ...targetParsed.tags])]
    const mergedKeywords = [...new Set([...sourceParsed.keywords, ...targetParsed.keywords])]
    // reason: explicit override wins, then source (newer), then target (older)
    const mergedReason = reason ?? parseReasonSection(sourceParsed.body) ?? parseReasonSection(targetParsed.body)

    // Merge timestamps: preserve the earliest createdAt and stamp a fresh
    // updatedAt. Scoring signals (importance/recency/maturity/counts) are
    // merged at the sidecar layer by the merge caller — not here.
    const mergedTimestamps = mergeTimestamps(sourceParsed.timestamps, targetParsed.timestamps)

    const sourceRawConcept = parseRawConceptSection(sourceParsed.body)
    const targetRawConcept = parseRawConceptSection(targetParsed.body)
    const mergedRawConcept = mergeRawConcepts(sourceRawConcept, targetRawConcept)

    const sourceNarrative = parseNarrativeSection(sourceParsed.body)
    const targetNarrative = parseNarrativeSection(targetParsed.body)
    const mergedNarrative = mergeNarratives(sourceNarrative, targetNarrative)

    const sourceFacts = parseFactsSection(sourceParsed.body)
    const targetFacts = parseFactsSection(targetParsed.body)
    const mergedFacts = mergeFacts(sourceFacts, targetFacts)

    const sourceSnippets = extractSnippetsFromContent(sourceParsed.body)
    const targetSnippets = extractSnippetsFromContent(targetParsed.body)

    const seenSnippets = new Set<string>()
    const mergedSnippets: string[] = []

    for (const snippet of [...targetSnippets, ...sourceSnippets]) {
      if (!seenSnippets.has(snippet)) {
        seenSnippets.add(snippet)
        mergedSnippets.push(snippet)
      }
    }

    return MarkdownWriter.generateContext({
      facts: mergedFacts,
      keywords: mergedKeywords,
      name: sourceParsed.title || targetParsed.title || '',
      narrative: mergedNarrative,
      rawConcept: mergedRawConcept,
      reason: mergedReason,
      relations: mergedRelations,
      snippets: mergedSnippets,
      summary: summary ?? sourceParsed.summary ?? targetParsed.summary,
      tags: mergedTags,
      timestamps: mergedTimestamps,
    })
  },

  parseContent(content: string, name: string = ''): ContextData {
    const { body, keywords, relations, summary, tags, timestamps, title } = parseContentWithFrontmatter(content)

    return {
      facts: parseFactsSection(body),
      keywords,
      name: title || name,
      narrative: parseNarrativeSection(body),
      rawConcept: parseRawConceptSection(body),
      reason: parseReasonSection(body),
      relations,
      snippets: extractSnippetsFromContent(body),
      summary,
      tags,
      timestamps,
    }
  },
}

/**
 * Merge two timestamp records: earliest createdAt, fresh updatedAt.
 *
 * Always stamps a fresh `updatedAt` — merge is a content modification, so
 * the output always carries an updated timestamp regardless of input shape.
 * `createdAt` only appears in the output when at least one input had it.
 */
function mergeTimestamps(a?: ContextTimestamps, b?: ContextTimestamps): ContextTimestamps {
  const out: ContextTimestamps = {updatedAt: new Date().toISOString()}

  const aCreated = a?.createdAt
  const bCreated = b?.createdAt
  if (aCreated && bCreated) {
    out.createdAt = new Date(aCreated).getTime() <= new Date(bCreated).getTime() ? aCreated : bCreated
  } else if (aCreated ?? bCreated) {
    out.createdAt = aCreated ?? bCreated
  }

  return out
}
