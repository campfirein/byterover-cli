import MiniSearch from 'minisearch'
import {realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {removeStopwords} from 'stopword'

import type {ElementName} from '../../../../server/core/domain/render/element-types.js'
import type {IRuntimeSignalStore} from '../../../../server/core/interfaces/storage/i-runtime-signal-store.js'
import type {IFileSystem} from '../../../core/interfaces/i-file-system.js'
import type {ILogger} from '../../../core/interfaces/i-logger.js'
import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../sandbox/tools-sdk.js'

import {
  BRV_DIR,
  CONTEXT_TREE_DIR,
  OVERVIEW_EXTENSION,
  SHARED_SOURCE_LOCAL_SCORE_BOOST,
  SUMMARY_INDEX_FILE,
} from '../../../../server/constants.js'
import {
  applyDecay,
  compoundScore,
  determineTier,
  recordAccessHits,
} from '../../../../server/core/domain/knowledge/memory-scoring.js'
import {
  createDefaultRuntimeSignals,
  type RuntimeSignals,
} from '../../../../server/core/domain/knowledge/runtime-signals-schema.js'
import {warnSidecarFailure} from '../../../../server/core/domain/knowledge/sidecar-logging.js'
import {loadSources, type SearchOrigin} from '../../../../server/core/domain/source/source-schema.js'
import {isArchiveStub, isDerivedArtifact} from '../../../../server/infra/context-tree/derived-artifact.js'
import {
  parseArchiveStubFrontmatter,
  parseSummaryFrontmatter,
} from '../../../../server/infra/context-tree/summary-frontmatter.js'
import {getFormatForRead} from '../../../../server/infra/render/format/format-detector.js'
import {ElementAxisIndex} from '../../../../server/infra/render/reader/element-axis-index.js'
import {readHtmlTopicSync} from '../../../../server/infra/render/reader/html-reader.js'
import {isPathLikeQuery, matchMemoryPath, parseSymbolicQuery} from './memory-path-matcher.js'
import {
  buildReferenceIndex,
  buildSymbolTree,
  getSubtreeDocumentIds,
  getSymbolKindLabel,
  getSymbolOverview,
  MemorySymbolKind,
  type MemorySymbolTree,
  type ReferenceIndex,
  type SummaryDocLike,
} from './memory-symbol-tree.js'

const MAX_CONTEXT_TREE_FILES = 10_000
const DEFAULT_CACHE_TTL_MS = 5000

/** Bump when MINISEARCH_OPTIONS fields/boost change to invalidate cached indexes */
const INDEX_SCHEMA_VERSION = 6

/** Only include results whose normalized score is at least this fraction of the top result's score */
const SCORE_GAP_RATIO = 0.7

/** Minimum normalized score for the top result. Below this, the query is considered out-of-domain */
const MINIMUM_RELEVANCE_SCORE = 0.45

/** Normalized score threshold above which results are trusted despite unmatched query terms */
const UNMATCHED_TERM_SCORE_THRESHOLD = 0.85

/** Minimum query term length to consider "significant" for OOD term-based detection */
const UNMATCHED_TERM_MIN_LENGTH = 4

/** Chunk size in characters for smart excerpt extraction (~200 tokens) */
const CHUNK_SIZE_CHARS = 800

/** Overlap between chunks in characters (15% of chunk size) */
const CHUNK_OVERLAP_CHARS = 120

/**
 * Normalize raw MiniSearch BM25 score to [0, 1) range.
 * Uses the monotonic formula: score / (1 + score)
 * Maps: strong(15)→0.94, medium(8)→0.89, moderate(4)→0.80, weak(1)→0.50, none(0)→0.
 * Query-independent — no per-query normalization needed.
 */
function normalizeScore(rawScore: number): number {
  return rawScore / (1 + rawScore)
}

function getSymbolPath(origin: Pick<SearchOrigin, 'alias' | 'origin' | 'originKey'>, relativePath: string): string {
  if (origin.origin === 'local') {
    return relativePath
  }

  return `[${origin.alias ?? origin.originKey}]:${relativePath}`
}

/**
 * Propagate BM25 scores upward to parent domain/topic nodes.
 *
 * For each matched result, walks the parent chain and computes a decayed boost
 * (score * propagationFactor per level). New summary entries are added for
 * parent nodes that have a _index.md in summaryMap but are not already in results.
 *
 * @param results - Already-enriched search results (gap-ratio filtered)
 * @param symbolTree - Symbol tree for parent-chain traversal
 * @param summaryMap - Map of _index.md file paths → SummaryDocLike (for excerpt/metadata)
 * @param symbolPathDocMap - symbolPath → IndexedDocument lookup for context.md fallback
 * @param propagationFactor - Score multiplier per level up (default 0.55)
 * @returns New parent entries only — caller merges and re-sorts
 */
function propagateScoresToParents(
  results: Array<{bm25Score: number; path: string}>,
  symbolTree: MemorySymbolTree,
  summaryMap: Map<string, SummaryDocLike>,
  symbolPathDocMap: Map<string, IndexedDocument>,
  signalsByPath: Map<string, RuntimeSignals>,
  propagationFactor = 0.55,
): SearchKnowledgeResult['results'] {
  const boosts = new Map<string, number>()

  for (const r of results) {
    const symbol = symbolTree.symbolMap.get(r.path)
    let parent = symbol?.parent
    let factor = propagationFactor
    while (parent) {
      const cur = boosts.get(parent.path) ?? 0
      boosts.set(parent.path, Math.max(cur, r.bm25Score * factor))
      parent = parent.parent
      factor *= propagationFactor
    }
  }

  const existingPaths = new Set(results.map((r) => r.path))
  const boosted: SearchKnowledgeResult['results'] = []

  for (const [parentPath, score] of boosts.entries()) {
    if (existingPaths.has(parentPath)) continue
    const doc = getSummarySource(parentPath, summaryMap, symbolPathDocMap)
    if (!doc) continue

    // Propagate the strongest child BM25 signal upward. Apply the parent
    // summary's own scoring boost only when the sidecar has a concrete entry
    // for this path — matches the pre-migration behaviour where summaries
    // without scoring in their frontmatter were not boosted. Lookup uses the
    // summary doc's file path (e.g. `auth/jwt/_index.md`) which matches the
    // sidecar's relPath key scheme.
    const sidecarSignals = signalsByPath.get(doc.path)
    const finalScore = sidecarSignals
      ? compoundScore(score, sidecarSignals)
      : score

    boosted.push({
      backlinkCount: 0,
      excerpt: doc.excerpt,
      path: parentPath,
      score: finalScore,
      symbolKind: 'summary',
      title: parentPath,
    })
  }

  return boosted
}

/** Numeric rank for maturity tiers — used for minMaturity filtering in both BM25 and propagated results. */
const MATURITY_TIER_RANK: Record<string, number> = {core: 3, draft: 1, validated: 2}

const MINISEARCH_OPTIONS = {
  fields: ['title', 'content', 'path'] as string[],
  idField: 'id' as const,
  searchOptions: {
    boost: {path: 1.5, title: 3},
    fuzzy: 0.2,
    prefix: true,
  },
  storeFields: ['title', 'path'] as string[],
}

interface IndexedDocument {
  content: string
  /**
   * Format of the source file on disk. Curate emits HTML topics; the
   * legacy markdown path is kept for `brv swarm` (which still consumes
   * `.md` topics and writes via the MD writer). The BM25 index is
   * format-agnostic — for HTML files, the indexed content is the
   * entity-decoded inner text, identical in shape to the markdown
   * input — but downstream consumers (telemetry, query log) need the
   * file format to route reads.
   */
  format: 'html' | 'markdown'
  id: string
  mtime: number
  /** 'local' for this project, 'shared' for results from a knowledge source */
  origin: 'local' | 'shared'
  /** Alias of the shared source (undefined for local) */
  originAlias?: string
  /** Absolute path to the context tree root this document belongs to */
  originContextTreeRoot: string
  /** Stable hash key identifying the origin project */
  originKey: string
  /** Path to .overview.md sibling, if it exists at index-build time */
  overviewPath?: string
  path: string
  /** Path used in the merged symbol tree (namespaced for shared sources) */
  symbolPath: string
  title: string
}

interface SummarySource {
  excerpt: string
  path: string
}

interface CachedIndex {
  contextTreePath: string
  documentMap: Map<string, IndexedDocument>
  /**
   * Structural-axis index over the same corpus the BM25 index covers.
   * Pre-filters candidate paths by element shape when a `SearchOptions`
   * call carries an `elementHint`. Built in lockstep with the BM25
   * index — same lifetime, same invalidation triggers.
   */
  elementAxisIndex: ElementAxisIndex
  fileMtimes: Map<string, number>
  index: MiniSearch<IndexedDocument>
  lastValidatedAt: number
  pathToDocumentId: Map<string, string>
  referenceIndex: ReferenceIndex
  schemaVersion: number
  /** Shared knowledge sources (origins) that were included in this index build */
  sharedOrigins: SearchOrigin[]
  /** Mtime of sources.json at last build (undefined if no file) */
  sourcesFileMtime?: number
  /** _index.md files collected separately for symbol tree annotation */
  summaryMap: Map<string, SummaryDocLike>
  /** symbolPath → IndexedDocument lookup for getSummarySource context.md fallback */
  symbolPathDocMap: Map<string, IndexedDocument>
  symbolTree: MemorySymbolTree
}

/**
 * State for managing concurrent access to the search index.
 * Uses a promise-based lock to prevent duplicate index builds during parallel execution.
 */
interface IndexState {
  /** Promise for an in-progress index build, undefined if no build is in progress */
  buildingPromise: Promise<CachedIndex> | undefined
  /** Cached index data, undefined if not yet built */
  cachedIndex: CachedIndex | undefined
}

/**
 * Configuration for SearchKnowledgeService.
 */
export interface SearchKnowledgeServiceConfig {
  /** Base directory for the project (defaults to process.cwd()) */
  baseDirectory?: string
  /** Cache TTL in milliseconds (defaults to 5000) */
  cacheTtlMs?: number
  /**
   * Optional logger. When provided, sidecar read failures on the ranking
   * path emit a `warn` so the fail-open degradation is observable rather
   * than silent.
   */
  logger?: ILogger
  /**
   * Sidecar store for runtime ranking signals. When provided, `flushAccessHits`
   * mirrors its importance/accessCount/maturity bumps to the store alongside
   * the existing markdown writes. Phase 3 of the runtime-signals migration.
   */
  runtimeSignalStore?: IRuntimeSignalStore
}

/**
 * Optional structural-axis filter applied before BM25 ranking. Restricts
 * the candidate set to topic files containing at least one matching
 * `<bv-*>` element. Reserved for the structural-selector grammar (the
 * eventual `bv-rule[severity=must]` syntax); search callers today
 * leave it unset and rely on full-corpus BM25.
 *
 * Discriminated union: either match by tag alone, or by tag plus an
 * `attribute=value` pair. A half-set `{attribute}` without `value`
 * (or vice versa) is rejected at compile time so callers can't
 * silently lose their filtering intent.
 */
export type ElementHint =
  | {attribute: string; tag: ElementName; value: string}
  | {tag: ElementName}

/**
 * Extended search options supporting symbolic filters.
 */
export interface SearchOptions {
  /**
   * Pre-filter the candidate set by `<bv-*>` element shape before
   * BM25 ranking. Wired but unused by today's callers; the grammar
   * that drives this hint is downstream.
   */
  elementHint?: ElementHint
  /** Symbol kinds to exclude from results (e.g. ['subtopic']) */
  excludeKinds?: string[]
  /** Symbol kinds to include in results (e.g. ['domain', 'context']) */
  includeKinds?: string[]
  /** Maximum number of results to return */
  limit?: number
  /** Minimum maturity tier for results */
  minMaturity?: 'core' | 'draft' | 'validated'
  /** If true, return tree structure overview instead of search results */
  overview?: boolean
  /** Depth for overview mode (default: 2) */
  overviewDepth?: number
  /** Path prefix to scope search within (e.g. "auth" or "auth/jwt-tokens") */
  scope?: string
}

function getSummaryAccessPath(
  path: string,
  summaryMap: Map<string, SummaryDocLike>,
  symbolPathDocMap: Map<string, IndexedDocument>,
): string {
  return getSummarySource(path, summaryMap, symbolPathDocMap)?.path ?? `${path}/${SUMMARY_INDEX_FILE}`
}

function getSummarySource(
  path: string,
  summaryMap: Map<string, SummaryDocLike>,
  symbolPathDocMap: Map<string, IndexedDocument>,
): SummarySource | undefined {
  const summaryDoc = summaryMap.get(`${path}/${SUMMARY_INDEX_FILE}`)
  if (summaryDoc) {
    return {
      excerpt: summaryDoc.excerpt ?? '',
      path: summaryDoc.path,
    }
  }

  // Look up context.md via symbolPath-keyed map since documentMap keys are
  // origin-qualified (e.g. 'local::path') but callers use symbol tree paths.
  const contextDoc = symbolPathDocMap.get(`${path}/context.md`)
  if (contextDoc) {
    return {
      excerpt: extractExcerpt(contextDoc.content, contextDoc.title),
      path: contextDoc.path,
    }
  }

  return undefined
}

function filterStopWords(query: string): string {
  const words = query.toLowerCase().split(/\s+/)
  const filtered = removeStopwords(words)
  return filtered.length > 0 ? filtered.join(' ') : query
}

/**
 * Checks if any significant query term is completely unmatched across search results.
 * Uses MiniSearch's queryTerms property to identify which terms actually matched.
 * A "significant" term is one with length >= UNMATCHED_TERM_MIN_LENGTH (filters out
 * short generic words that are noisy for OOD detection).
 */
function hasUnmatchedSignificantTerms(queryTerms: string[], searchResults: Array<{queryTerms: string[]}>): boolean {
  const significantTerms = queryTerms.filter((t) => t.length >= UNMATCHED_TERM_MIN_LENGTH)
  if (significantTerms.length === 0) return false

  const allMatchedQueryTerms = new Set<string>()
  for (const result of searchResults.slice(0, 10)) {
    for (const term of result.queryTerms) {
      allMatchedQueryTerms.add(term)
    }
  }

  return significantTerms.some((t) => !allMatchedQueryTerms.has(t))
}

function extractTitle(content: string, fallbackTitle: string): string {
  const match = /^# (.+)$/m.exec(content)
  return match ? match[1].trim() : fallbackTitle
}

/**
 * Find the best semantic break point in a chunk slice.
 * Searches the last 30% of the text for break points with priority:
 * paragraph (\n\n) > sentence (. ? !) > line (\n).
 * Returns the character offset to break at, or -1 if no good break found.
 */
function findBreakPoint(slice: string): number {
  const searchStart = Math.floor(slice.length * 0.7)
  const searchSlice = slice.slice(searchStart)

  const paraBreak = searchSlice.lastIndexOf('\n\n')
  if (paraBreak !== -1) {
    return searchStart + paraBreak + 2
  }

  const sentEnd = Math.max(
    searchSlice.lastIndexOf('. '),
    searchSlice.lastIndexOf('.\n'),
    searchSlice.lastIndexOf('? '),
    searchSlice.lastIndexOf('?\n'),
    searchSlice.lastIndexOf('! '),
    searchSlice.lastIndexOf('!\n'),
  )
  if (sentEnd !== -1) {
    return searchStart + sentEnd + 2
  }

  const lineBreak = searchSlice.lastIndexOf('\n')
  if (lineBreak !== -1) {
    return searchStart + lineBreak + 1
  }

  return -1
}

/**
 * Chunk a document into overlapping pieces with smart break-point detection.
 * Inspired by QMD's chunking strategy — breaks at semantic boundaries
 * (paragraph > sentence > line > word) for coherent excerpts.
 */
function chunkDocument(content: string): {pos: number; text: string}[] {
  if (content.length <= CHUNK_SIZE_CHARS) {
    return [{pos: 0, text: content}]
  }

  const chunks: {pos: number; text: string}[] = []
  let charPos = 0

  while (charPos < content.length) {
    let endPos = Math.min(charPos + CHUNK_SIZE_CHARS, content.length)

    // Find best break point in last 30% of chunk
    if (endPos < content.length) {
      const breakOffset = findBreakPoint(content.slice(charPos, endPos))
      if (breakOffset !== -1) {
        endPos = charPos + breakOffset
      }
    }

    // Ensure forward progress
    if (endPos <= charPos) {
      endPos = Math.min(charPos + CHUNK_SIZE_CHARS, content.length)
    }

    chunks.push({pos: charPos, text: content.slice(charPos, endPos)})

    if (endPos >= content.length) break

    // Overlap with previous chunk
    charPos = endPos - CHUNK_OVERLAP_CHARS
    if (charPos <= chunks.at(-1)!.pos) {
      charPos = endPos
    }
  }

  return chunks
}

function extractExcerpt(content: string, query: string, maxLength: number = 800): string {
  // Strip ## Relations section and title heading
  const relationsMatch = /^## Relations\n([\S\s]*?)(?=\n## |\n# |$)/m.exec(content)
  let cleanContent = content
  if (relationsMatch) {
    cleanContent = content.replace(relationsMatch[0], '').trim()
  }

  cleanContent = cleanContent.replace(/^# .+$/m, '').trim()

  // Chunk the document into semantically coherent pieces
  const chunks = chunkDocument(cleanContent)

  // Score each chunk by query term density and pick the best
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2)

  let bestChunk = chunks[0]
  let bestScore = -1

  for (const chunk of chunks) {
    const chunkLower = chunk.text.toLowerCase()
    const score = queryTerms.reduce((acc, term) => acc + (chunkLower.includes(term) ? 1 : 0), 0)
    if (score > bestScore) {
      bestScore = score
      bestChunk = chunk
    }
  }

  let excerpt = bestChunk.text.trim()
  if (excerpt.length > maxLength) {
    excerpt = excerpt.slice(0, maxLength).trim() + '...'
  } else if (chunks.length > 1) {
    excerpt += '...'
  }

  return excerpt || cleanContent.slice(0, maxLength) + (cleanContent.length > maxLength ? '...' : '')
}

function stripMarkdownFrontmatter(content: string): string {
  return content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '').trim()
}

/**
 * Discover topic files in the context tree. The corpus is `<bv-topic>`
 * HTML; markdown topics are out of scope. The legacy `_index.md`
 * summary convention is still globbed because the summary frontmatter
 * pipeline (separate from topic-body indexing) hasn't migrated yet.
 */
async function findContextFilesWithMtime(
  fileSystem: IFileSystem,
  contextTreePath: string,
): Promise<Array<{mtime: number; path: string}>> {
  // Two parallel passes (one per extension) instead of brace expansion so
  // the discovery isn't coupled to whatever glob engine
  // `IFileSystem.globFiles` delegates to. Some engines don't expand
  // `{html,md}` and would silently drop one branch — caught here only as
  // a missing index entry, well after the daemon has cached the partial
  // corpus. Per-pass failures collapse to an empty result for that
  // branch only; the other pass still produces its files.
  const runPass = async (pattern: string) => {
    try {
      const globResult = await fileSystem.globFiles(pattern, {
        cwd: contextTreePath,
        includeMetadata: true,
        maxResults: MAX_CONTEXT_TREE_FILES,
        respectGitignore: false,
      })
      return globResult.files
    } catch {
      return []
    }
  }

  const passResults = await Promise.all([runPass('**/*.html'), runPass('**/*.md')])

  const seen = new Map<string, {mtime: number; path: string}>()
  for (const files of passResults) {
    for (const f of files) {
      let relativePath = f.path
      if (f.path.startsWith(contextTreePath)) {
        relativePath = f.path.slice(contextTreePath.length + 1)
      }

      seen.set(relativePath, {
        mtime: f.modified?.getTime() ?? 0,
        path: relativePath,
      })
    }
  }

  return [...seen.values()]
}

function isCacheValid(cache: CachedIndex, currentFiles: Array<{mtime: number; path: string}>): boolean {
  if (cache.fileMtimes.size !== currentFiles.length) {
    return false
  }

  for (const file of currentFiles) {
    const cachedMtime = cache.fileMtimes.get(file.path)
    if (cachedMtime === undefined || cachedMtime !== file.mtime) {
      return false
    }
  }

  return true
}

/**
 * Read and index documents from a single context tree origin.
 * Returns documents with origin-qualified IDs (<originKey>::<path>)
 * and summary docs keyed by origin-qualified paths.
 */
/**
 * Read the file from disk and split into the BM25 input (`indexedContent`)
 * plus per-format metadata. HTML topics route through the html-reader
 * which strips markup and returns entity-decoded inner text — that's
 * what the BM25 tokenizer sees, ensuring ranking parity with the
 * markdown corpus on the same content. Markdown is fed verbatim.
 */
async function readIndexableContent(
  fileSystem: IFileSystem,
  fullPath: string,
  filePath: string,
): Promise<null | {
  elements: ReturnType<typeof readHtmlTopicSync>['elements']
  format: 'html' | 'markdown'
  htmlTitleHint?: string
  indexedContent: string
  rawContent: string
}> {
  try {
    const {content} = await fileSystem.readFile(fullPath)
    if (getFormatForRead(filePath) === 'html') {
      const parsed = readHtmlTopicSync(content)
      // Concatenate the searchable subset of `<bv-topic>` attributes
      // into the BM25 input. The markdown corpus exposes the same
      // signals via YAML frontmatter (which the MD branch passes through
      // verbatim), so without this step a query for a term living only
      // in `summary=`/`tags=`/`keywords=`/`related=` would rank an HTML
      // topic strictly below the MD equivalent. `title` already carries
      // a 3x field boost via the `title` column and is intentionally
      // omitted here.
      const {keywords, related, summary, tags} = parsed.topicAttributes
      const indexedContent = [parsed.bodyText, summary, tags, keywords, related]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' ')
      return {
        elements: parsed.elements,
        format: 'html',
        htmlTitleHint: parsed.topicAttributes.title,
        indexedContent,
        rawContent: content,
      }
    }

    return {elements: [], format: 'markdown', indexedContent: content, rawContent: content}
  } catch {
    return null
  }
}

async function indexOriginDocuments(
  fileSystem: IFileSystem,
  origin: SearchOrigin,
  filesWithMtime: Array<{mtime: number; path: string}>,
): Promise<{
  documents: IndexedDocument[]
  /** Per-document element entries gathered for the structural-axis index. */
  elementsByDocId: Map<string, ReturnType<typeof readHtmlTopicSync>['elements']>
  fileMtimes: Map<string, number>
  summaryMap: Map<string, SummaryDocLike>
}> {
  // Partition files: _index.md → summaryFiles, .overview.md → overviewFiles (for cache
  // invalidation + sibling detection), other derived artifacts → skip, rest → indexable
  const summaryFiles: Array<{mtime: number; path: string}> = []
  const overviewFiles: Array<{mtime: number; path: string}> = []
  const indexableFiles: Array<{mtime: number; path: string}> = []

  // Track all known paths for sibling detection (e.g. .overview.md presence check)
  const knownPaths = new Set(filesWithMtime.map((f) => f.path))

  for (const file of filesWithMtime) {
    const fileName = file.path.split('/').at(-1) ?? ''
    if (fileName === SUMMARY_INDEX_FILE) {
      summaryFiles.push(file)
    } else if (file.path.endsWith(OVERVIEW_EXTENSION)) {
      // Track mtimes so cache invalidates when a new .overview.md appears; not BM25-indexed
      overviewFiles.push(file)
    } else if (!isDerivedArtifact(file.path)) {
      indexableFiles.push(file)
    }
    // .full.md, .abstract.md, and _manifest.json are skipped (isDerivedArtifact returns true)
  }

  const documentPromises = indexableFiles.map(async ({mtime, path: filePath}) => {
    const fullPath = join(origin.contextTreeRoot, filePath)
    const read = await readIndexableContent(fileSystem, fullPath, filePath)
    if (!read) return null

    const fallbackTitle = filePath.replace(/\.(html?|md)$/i, '').split('/').pop() ?? filePath
    // Trim before falling back: a `title=""` (or whitespace-only) attribute
    // survives the schema's `passthrough` permissiveness and would
    // otherwise leak into BM25's 3x-boosted `title` field.
    const title = read.format === 'html'
      ? (read.htmlTitleHint?.trim() || fallbackTitle)
      : extractTitle(read.rawContent, fallbackTitle)
    const qualifiedId = `${origin.originKey}::${filePath}`
    const symbolPath = getSymbolPath(origin, filePath)

    // Check if a .overview.md sibling exists (written by abstract
    // generation queue). The overview convention is markdown-only;
    // HTML topics don't get one until the queue learns the format.
    const overviewRelPath = filePath.replace(/\.(html?|md)$/i, OVERVIEW_EXTENSION)
    const overviewPath = knownPaths.has(overviewRelPath) ? overviewRelPath : undefined

    const doc: IndexedDocument = {
      // BM25 receives the entity-decoded innerText for HTML topics so
      // ranking parity with markdown is automatic. The raw HTML is
      // preserved as `rawContent` in the wrapper below for any consumer
      // that wants the source text (excerpt extraction, snippet
      // highlighting). Today only the BM25 index is wired.
      content: read.indexedContent,
      format: read.format,
      id: qualifiedId,
      mtime,
      origin: origin.origin,
      originContextTreeRoot: origin.contextTreeRoot,
      originKey: origin.originKey,
      ...(overviewPath !== undefined && {overviewPath}),
      path: filePath,
      symbolPath,
      title,
    }
    if (origin.alias) doc.originAlias = origin.alias

    return {doc, elements: read.elements}
  })

  const summaryPromises = summaryFiles.map(async ({path: filePath}) => {
    try {
      const fullPath = join(origin.contextTreeRoot, filePath)
      const {content} = await fileSystem.readFile(fullPath)
      const fm = parseSummaryFrontmatter(content)
      if (!fm) return null

      return {
        condensationOrder: fm.condensation_order,
        excerpt: stripMarkdownFrontmatter(content).slice(0, 400),
        path: getSymbolPath(origin, filePath),
        tokenCount: fm.token_count,
      } satisfies SummaryDocLike
    } catch {
      return null
    }
  })

  const [docResults, summaryResults] = await Promise.all([Promise.all(documentPromises), Promise.all(summaryPromises)])

  const documents: IndexedDocument[] = []
  const elementsByDocId = new Map<string, ReturnType<typeof readHtmlTopicSync>['elements']>()
  for (const result of docResults) {
    if (!result) continue
    documents.push(result.doc)
    if (result.elements.length > 0) {
      elementsByDocId.set(result.doc.id, result.elements)
    }
  }

  const fileMtimes = new Map<string, number>()
  for (const doc of documents) {
    fileMtimes.set(doc.id, doc.mtime)
  }

  for (const sf of summaryFiles) {
    fileMtimes.set(`${origin.originKey}::${sf.path}`, sf.mtime)
  }

  // Track .overview.md mtimes so the cache invalidates when a new overview is written
  for (const ov of overviewFiles) {
    fileMtimes.set(`${origin.originKey}::${ov.path}`, ov.mtime)
  }

  const summaryMap = new Map<string, SummaryDocLike>()
  for (const summary of summaryResults) {
    if (summary) {
      summaryMap.set(summary.path, summary)
    }
  }

  return {documents, elementsByDocId, fileMtimes, summaryMap}
}

async function buildFreshIndex(
  fileSystem: IFileSystem,
  contextTreePath: string,
  localFiles: Array<{mtime: number; path: string}>,
  sharedOrigins: SearchOrigin[],
  sourcesFileMtime?: number,
): Promise<CachedIndex> {
  const now = Date.now()

  // Build the local origin descriptor.
  // Note: `originKey: 'local'` is a string sentinel — shared origins use a 12-char
  // SHA-256 hex hash from `deriveOriginKey()`. Consumers comparing originKey should
  // treat 'local' as a reserved literal, not a hash.
  const localOrigin: SearchOrigin = {
    contextTreeRoot: contextTreePath,
    origin: 'local',
    originKey: 'local',
  }

  // Index local documents
  const localResult = await indexOriginDocuments(fileSystem, localOrigin, localFiles)

  // Index shared origin documents in parallel
  const sharedResults = await Promise.all(
    sharedOrigins.map(async (origin) => {
      try {
        const files = await findContextFilesWithMtime(fileSystem, origin.contextTreeRoot)
        const filtered = files.filter(
          (f) => !isDerivedArtifact(f.path) || f.path.split('/').at(-1) === SUMMARY_INDEX_FILE,
        )

        return indexOriginDocuments(fileSystem, origin, filtered)
      } catch {
        return {
          documents: [],
          elementsByDocId: new Map<string, ReturnType<typeof readHtmlTopicSync>['elements']>(),
          fileMtimes: new Map<string, number>(),
          summaryMap: new Map<string, SummaryDocLike>(),
        }
      }
    }),
  )

  // Merge all documents, fileMtimes, and summaryMaps
  const allDocuments: IndexedDocument[] = [...localResult.documents]
  const allElementsByDocId = new Map(localResult.elementsByDocId)
  const fileMtimes = new Map(localResult.fileMtimes)
  const summaryMap = new Map(localResult.summaryMap)

  for (const result of sharedResults) {
    allDocuments.push(...result.documents)
    for (const [key, elements] of result.elementsByDocId) {
      allElementsByDocId.set(key, elements)
    }

    for (const [key, mtime] of result.fileMtimes) {
      fileMtimes.set(key, mtime)
    }

    for (const [key, summary] of result.summaryMap) {
      summaryMap.set(key, summary)
    }
  }

  const documentMap = new Map<string, IndexedDocument>()
  const pathToDocumentId = new Map<string, string>()
  // Reverse lookup: symbolPath → document (for getSummarySource context.md fallback)
  const symbolPathDocMap = new Map<string, IndexedDocument>()
  for (const doc of allDocuments) {
    documentMap.set(doc.id, doc)
    pathToDocumentId.set(doc.symbolPath, doc.id)
    symbolPathDocMap.set(doc.symbolPath, doc)
  }

  const index = new MiniSearch<IndexedDocument>(MINISEARCH_OPTIONS)
  index.addAll(allDocuments)

  // Populate the structural-axis index from every HTML topic that
  // contributed elements. The index is the consumer for the
  // (currently unused) `elementHint` filter on `SearchOptions`; it
  // shares the BM25 index's lifecycle, rebuilt on the same triggers.
  const elementAxisIndex = new ElementAxisIndex()
  for (const [docId, elements] of allElementsByDocId) {
    elementAxisIndex.add(docId, elements)
  }

  const symbolDocumentMap = new Map<string, IndexedDocument>()
  for (const doc of allDocuments) {
    symbolDocumentMap.set(doc.id, {...doc, path: doc.symbolPath})
  }

  const symbolTree = buildSymbolTree(symbolDocumentMap, summaryMap)
  // Reference index only uses local docs — cross-project references are not tracked
  const referenceIndex = buildReferenceIndex(new Map(localResult.documents.map((doc) => [doc.id, doc])))

  return {
    contextTreePath,
    documentMap,
    elementAxisIndex,
    fileMtimes,
    index,
    lastValidatedAt: now,
    pathToDocumentId,
    referenceIndex,
    schemaVersion: INDEX_SCHEMA_VERSION,
    sharedOrigins,
    sourcesFileMtime,
    summaryMap,
    symbolPathDocMap,
    symbolTree,
  }
}

/**
 * Acquires the search index, using cached data when valid or building a fresh index.
 * Uses promise-based locking to prevent duplicate builds during parallel execution.
 *
 * Self-loads knowledge sources from `.brv/sources.json` during each validation
 * cycle, with mtime-based invalidation to detect source additions/removals.
 */
async function acquireIndex(
  state: IndexState,
  fileSystem: IFileSystem,
  contextTreePath: string,
  baseDirectory: string,
  ttlMs: number,
  onBeforeBuild?: (contextTreePath: string) => Promise<boolean>,
): Promise<CachedIndex | {error: true; result: SearchKnowledgeResult}> {
  const now = Date.now()

  // Fast path: TTL-based cache hit (no I/O needed)
  if (
    state.cachedIndex &&
    state.cachedIndex.contextTreePath === contextTreePath &&
    state.cachedIndex.schemaVersion === INDEX_SCHEMA_VERSION &&
    ttlMs > 0 &&
    now - state.cachedIndex.lastValidatedAt < ttlMs
  ) {
    return state.cachedIndex
  }

  // If another call is already building the index, wait for it
  if (state.buildingPromise) {
    return state.buildingPromise
  }

  // Create and store the build promise SYNCHRONOUSLY before any await
  // This prevents race conditions where multiple parallel calls all start building
  const emptyResult = (): CachedIndex => {
    const emptyIndex = new MiniSearch<IndexedDocument>(MINISEARCH_OPTIONS)

    return {
      contextTreePath: '',
      documentMap: new Map(),
      elementAxisIndex: new ElementAxisIndex(),
      fileMtimes: new Map(),
      index: emptyIndex,
      lastValidatedAt: 0,
      pathToDocumentId: new Map(),
      referenceIndex: {backlinks: new Map(), forwardLinks: new Map()},
      schemaVersion: INDEX_SCHEMA_VERSION,
      sharedOrigins: [],
      summaryMap: new Map(),
      symbolPathDocMap: new Map(),
      symbolTree: {root: [], symbolMap: new Map()},
    }
  }

  const buildPromise = (async (): Promise<CachedIndex> => {
    // Check if context tree exists (only if no cache or different path)
    if (!state.cachedIndex || state.cachedIndex.contextTreePath !== contextTreePath) {
      try {
        await fileSystem.listDirectory(contextTreePath)
      } catch {
        return emptyResult()
      }
    }

    // Self-load knowledge sources — mtime-based invalidation
    const loadedSources = loadSources(baseDirectory)
    const sourcesFileMtime = loadedSources?.mtime
    const sharedOrigins = loadedSources?.origins ?? []

    let allFiles = await findContextFilesWithMtime(fileSystem, contextTreePath)
    // Exclude non-indexable derived artifacts (.full.md) so that currentFiles
    // matches what buildFreshIndex tracks in fileMtimes. Without this filter,
    // isCacheValid() sees a size mismatch once archives exist, causing cache thrash.
    // _index.md is kept (tracked for summary staleness), .stub.md is kept (BM25 indexed).
    // Keep _index.md (summary tracking) and .overview.md (sibling detection for overviewPath).
    // .full.md, .abstract.md, and _manifest.json remain excluded.
    let localFiles = allFiles.filter(
      (f) =>
        !isDerivedArtifact(f.path) ||
        f.path.split('/').at(-1) === SUMMARY_INDEX_FILE ||
        f.path.endsWith(OVERVIEW_EXTENSION),
    )

    // Flush pending access hits before reusing a stale-enough cache entry.
    // The flush updates frontmatter on disk, so refresh mtimes before the cache-valid check.
    if (onBeforeBuild) {
      const wroteScoringUpdates = await onBeforeBuild(contextTreePath)
      if (wroteScoringUpdates) {
        allFiles = await findContextFilesWithMtime(fileSystem, contextTreePath)
        localFiles = allFiles.filter(
          (f) =>
            !isDerivedArtifact(f.path) ||
            f.path.split('/').at(-1) === SUMMARY_INDEX_FILE ||
            f.path.endsWith(OVERVIEW_EXTENSION),
        )
      }
    }

    // Qualify local file mtime keys with 'local::' prefix to match buildFreshIndex
    const qualifiedLocalFiles = localFiles.map((f) => ({mtime: f.mtime, path: `local::${f.path}`}))

    // Glob shared origin files for cache validation (detect edits in shared projects)
    const sharedFileArrays = await Promise.all(
      sharedOrigins.map(async (origin) => {
        try {
          const files = await findContextFilesWithMtime(fileSystem, origin.contextTreeRoot)
          const filtered = files.filter(
            (f) => !isDerivedArtifact(f.path) || f.path.split('/').at(-1) === SUMMARY_INDEX_FILE,
          )

          return filtered.map((f) => ({mtime: f.mtime, path: `${origin.originKey}::${f.path}`}))
        } catch {
          return []
        }
      }),
    )

    const allQualifiedFiles = [...qualifiedLocalFiles, ...sharedFileArrays.flat()]
    // Re-check cache validity: local files + shared files + sources-file mtime must match
    const sourcesFileChanged = state.cachedIndex?.sourcesFileMtime !== sourcesFileMtime
    if (
      !sourcesFileChanged &&
      state.cachedIndex &&
      state.cachedIndex.contextTreePath === contextTreePath &&
      state.cachedIndex.schemaVersion === INDEX_SCHEMA_VERSION &&
      isCacheValid(state.cachedIndex, allQualifiedFiles)
    ) {
      // Update timestamp atomically by creating a new object
      const updatedCache: CachedIndex = {
        ...state.cachedIndex,
        lastValidatedAt: Date.now(),
      }
      state.cachedIndex = updatedCache

      return updatedCache
    }

    // Build fresh index with local + shared origins
    const freshIndex = await buildFreshIndex(fileSystem, contextTreePath, localFiles, sharedOrigins, sourcesFileMtime)
    state.cachedIndex = freshIndex

    return freshIndex
  })()

  // Store promise IMMEDIATELY (synchronously) so parallel calls can wait on it
  state.buildingPromise = buildPromise

  try {
    const result = await buildPromise

    // Check for error signal (empty contextTreePath means listDirectory failed)
    if (result.contextTreePath === '') {
      return {
        error: true,
        result: {
          message: 'Context tree not initialized. Run /init to create it.',
          results: [],
          totalFound: 0,
        },
      }
    }

    return result
  } finally {
    // Clear the lock after completion (success or failure)
    state.buildingPromise = undefined
  }
}

/**
 * SearchKnowledgeService implementation.
 * Provides knowledge search functionality with caching and indexing.
 */
export class SearchKnowledgeService implements ISearchKnowledgeService {
  private readonly baseDirectory: string
  private readonly cacheTtlMs: number
  private readonly fileSystem: IFileSystem
  private readonly logger?: ILogger
  private readonly pendingAccessHits: Map<string, number> = new Map()
  private readonly runtimeSignalStore?: IRuntimeSignalStore
  private readonly state: IndexState = {
    buildingPromise: undefined,
    cachedIndex: undefined,
  }

  constructor(fileSystem: IFileSystem, config: SearchKnowledgeServiceConfig = {}) {
    this.fileSystem = fileSystem
    this.baseDirectory = config.baseDirectory ?? process.cwd()
    this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.logger = config.logger
    this.runtimeSignalStore = config.runtimeSignalStore
  }

  /**
   * Flush accumulated access hits to the runtime-signal sidecar.
   *
   * Post-commit-5 this no longer writes to markdown — ranking signals
   * live exclusively in the sidecar. The `contextTreePath` parameter is
   * retained for signature compatibility with the cache-invalidation
   * callback but is no longer used.
   *
   * Returns `true` when hits were processed so the caller knows to
   * refresh file mtimes (historical contract); with markdown writes
   * removed the refresh is harmless but kept for symmetry.
   */
  async flushAccessHits(_contextTreePath: string): Promise<boolean> {
    if (this.pendingAccessHits.size === 0) {
      return false
    }

    const hits = new Map(this.pendingAccessHits)
    this.pendingAccessHits.clear()

    await this.mirrorHitsToSignalStore(hits)
    return true
  }

  /**
   * Search the knowledge base for relevant topics.
   * Supports symbolic path queries, scoped search, kind/maturity filtering, and overview mode.
   *
   * @param query - Natural language query string or symbolic path (e.g. "auth/jwt")
   * @param options - Search options including symbolic filters
   * @returns Search results with matching topics, enriched with symbolic metadata
   */
  async search(query: string, options?: SearchOptions): Promise<SearchKnowledgeResult> {
    const limit = options?.limit ?? 10
    // Normalize scope: strip trailing slashes so "project/" and "project" both work.
    // The symbol tree stores paths without a trailing slash, and getSubtreeDocumentIds
    // does an exact node lookup, so "project/" would otherwise miss the subtree entirely
    // and silently fall back to global search via the block at the end of this method.
    const normalizedScope = options?.scope?.trim().replace(/\/+$/, '') || undefined
    const resolvedBaseDirectory = await realpath(this.baseDirectory).catch(() => this.baseDirectory)
    const contextTreePath = join(resolvedBaseDirectory, BRV_DIR, CONTEXT_TREE_DIR)

    // Acquire index with parallel-safe locking; flush pending access hits before any rebuild
    const indexResult = await acquireIndex(
      this.state,
      this.fileSystem,
      contextTreePath,
      this.baseDirectory,
      this.cacheTtlMs,
      (ctxPath: string) => this.flushAccessHits(ctxPath),
    )

    // Handle error case (context tree not initialized)
    if ('error' in indexResult) {
      return indexResult.result
    }

    const {documentMap, index, pathToDocumentId, referenceIndex, summaryMap, symbolPathDocMap, symbolTree} = indexResult

    if (documentMap.size === 0) {
      return {
        message: 'Context tree is empty. Use /curate to add knowledge.',
        results: [],
        totalFound: 0,
      }
    }

    // Overview mode: return tree structure instead of search results
    if (options?.overview) {
      return this.buildOverviewResult(symbolTree, referenceIndex, normalizedScope, options.overviewDepth)
    }

    // Load the runtime-signal sidecar map for the specific paths this query
    // touches: all document paths in the index plus their summary siblings.
    // This is O(k) per search instead of O(all entries). Entries are present
    // only for paths with stored signals — callers use `.has()` to distinguish
    // missing from default, and `.get(path) ?? defaults` for ergonomic
    // default-on-miss. On sidecar failure, degrade to BM25-only ranking.
    const signalsByPath = await this.loadSignalsByPath(documentMap, summaryMap)

    // Symbolic path resolution: try path-based query first
    if (isPathLikeQuery(query, symbolTree)) {
      const symbolicResult = this.trySymbolicSearch(
        query,
        symbolTree,
        referenceIndex,
        documentMap,
        index,
        limit,
        pathToDocumentId,
        summaryMap,
        symbolPathDocMap,
        signalsByPath,
        indexResult.elementAxisIndex,
        options,
      )

      if (symbolicResult) {
        return symbolicResult
      }
    }

    // Parse query for potential scope prefix (e.g. "auth jwt refresh" → scope=auth, text="jwt refresh")
    const parsed = parseSymbolicQuery(query, symbolTree)
    // Strip trailing slashes from scope so "auth/" resolves to the same
    // symbol-tree node as "auth". The symbol tree stores paths without
    // trailing slashes; a mismatch causes getSubtreeDocumentIds() to
    // return empty → unintended fallback to global search.
    const rawScope = options?.scope?.trim().replace(/\/+$/, '')
    const effectiveScope = (rawScope !== undefined && rawScope !== '' ? rawScope : undefined) ?? parsed.scopePath
    const effectiveQuery = parsed.scopePath ? parsed.textQuery : query

    // Run text-based MiniSearch (existing pipeline), optionally scoped to a subtree
    const textResult = this.runTextSearch(
      effectiveQuery || query,
      documentMap,
      index,
      limit,
      effectiveScope,
      pathToDocumentId,
      symbolTree,
      referenceIndex,
      summaryMap,
      symbolPathDocMap,
      signalsByPath,
      indexResult.elementAxisIndex,
      options,
    )

    // If scoped search returned nothing and we had a scope, fall back to global search
    if (textResult.results.length === 0 && effectiveScope && effectiveQuery) {
      return this.runTextSearch(
        query,
        documentMap,
        index,
        limit,
        undefined,
        pathToDocumentId,
        symbolTree,
        referenceIndex,
        summaryMap,
        symbolPathDocMap,
        signalsByPath,
        indexResult.elementAxisIndex,
        options,
      )
    }

    return textResult
  }

  private accumulateAccessHits(paths: string[]): void {
    for (const path of paths) {
      this.pendingAccessHits.set(path, (this.pendingAccessHits.get(path) ?? 0) + 1)
    }
  }

  /**
   * Build overview result showing the tree structure at configurable depth.
   */
  private buildOverviewResult(
    symbolTree: MemorySymbolTree,
    referenceIndex: ReferenceIndex,
    scope?: string,
    depth?: number,
  ): SearchKnowledgeResult {
    const entries = getSymbolOverview(symbolTree, scope, depth ?? 2)

    const results: SearchKnowledgeResult['results'] = entries.map((entry) => ({
      backlinkCount: referenceIndex.backlinks.get(entry.path)?.length ?? 0,
      excerpt: `${entry.kind} | ${entry.childCount} children | maturity: ${entry.maturity}`,
      path: entry.path,
      score: entry.importance / 100,
      symbolKind: entry.kind,
      symbolPath: entry.path,
      title: entry.name,
    }))

    const domainCount = entries.filter((e) => e.kind === 'domain').length
    const topicCount = entries.filter((e) => e.kind === 'topic').length

    return {
      message: `Knowledge tree overview (${domainCount} domains, ${topicCount} topics).`,
      results,
      totalFound: entries.length,
    }
  }

  /**
   * Enrich a search result with symbolic metadata and backlink info.
   * For archive stubs, extracts points_to path into archiveFullPath.
   */
  private enrichResult(
    result: {excerpt: string; id: string; path: string; score: number; title: string},
    symbolTree: MemorySymbolTree,
    referenceIndex: ReferenceIndex,
    documentMap: Map<string, IndexedDocument>,
  ): SearchKnowledgeResult['results'][number] {
    const doc = documentMap.get(result.id)
    const symbolPath = doc?.symbolPath ?? result.path
    const symbol = symbolTree.symbolMap.get(symbolPath)
    const backlinks = referenceIndex.backlinks.get(result.path)

    // Detect archive stubs and extract points_to for drill-down
    let archiveFullPath: string | undefined
    let symbolKind = symbol ? getSymbolKindLabel(symbol.kind) : undefined
    if (isArchiveStub(result.path)) {
      symbolKind = 'archive_stub'
      if (doc) {
        const stubFm = parseArchiveStubFrontmatter(doc.content)
        if (stubFm) {
          archiveFullPath = stubFm.points_to
        }
      }
    }

    // Origin metadata for shared-source results
    const origin = doc?.origin
    const originAlias = doc?.originAlias
    const originContextTreeRoot = doc?.origin === 'shared' ? doc.originContextTreeRoot : undefined
    const overviewPath = doc?.overviewPath
    const isContextSummary = doc?.path.endsWith('/context.md') || doc?.path === 'context.md'
    const summaryPath = isContextSummary
      ? doc?.path.slice(0, -'/context.md'.length) || doc?.path || result.path
      : result.path

    // Destructure to strip `id` from output — not part of SearchKnowledgeResult
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {id: _id, ...rest} = result

    return {
      ...rest,
      ...(archiveFullPath && {archiveFullPath}),
      ...(overviewPath && {overviewPath}),
      backlinkCount: backlinks?.length ?? 0,
      ...(doc && {format: doc.format}),
      ...(origin && {origin}),
      ...(originAlias && {originAlias}),
      ...(originContextTreeRoot && {originContextTreeRoot}),
      ...(isContextSummary && {path: summaryPath}),
      relatedPaths: backlinks?.slice(0, 3),
      symbolKind: isContextSummary ? 'summary' : symbolKind,
      symbolPath: isContextSummary ? summaryPath : symbol?.path,
    }
  }

  /**
   * Load the runtime-signal map for this search via `getMany`, limiting the
   * request to paths that this search could possibly rank: every indexed
   * document plus every summary sibling (parent-propagation can touch any
   * summary). The returned map contains entries only for paths with stored
   * signals; callers use `.has()` / `.get()` to distinguish missing from
   * default. Returns an empty map on sidecar failure so ranking degrades to
   * BM25 alone rather than erroring out mid-query.
   */
  private async loadSignalsByPath(
    documentMap: Map<string, IndexedDocument>,
    summaryMap: Map<string, SummaryDocLike>,
  ): Promise<Map<string, RuntimeSignals>> {
    if (!this.runtimeSignalStore) return new Map()

    const paths = new Set<string>()
    for (const doc of documentMap.values()) paths.add(doc.path)
    for (const summary of summaryMap.values()) paths.add(summary.path)

    try {
      return await this.runtimeSignalStore.getMany([...paths])
    } catch (error) {
      this.logger?.warn(
        `SearchKnowledgeService: sidecar getMany failed, falling back to BM25-only ranking: ${error instanceof Error ? error.message : String(error)}`,
      )
      return new Map()
    }
  }

  /**
   * Mirror a batch of access-hit bumps into the runtime-signal sidecar.
   *
   * Matches the markdown flush semantics above:
   *   - `recordAccessHits` bumps `importance` by `ACCESS_IMPORTANCE_BONUS * count`
   *     and `accessCount` by `count`.
   *   - `determineTier` recomputes `maturity` from the new importance.
   * Both steps run inside `update`'s atomic read-modify-write callback so
   * same-path contention within the process does not lose bumps.
   * `updatedAt` is never mirrored — it is a content timestamp, not a signal.
   */
  private async mirrorHitsToSignalStore(hits: Map<string, number>): Promise<void> {
    const store = this.runtimeSignalStore
    if (!store) return

    const updates = new Map(
      [...hits.entries()].map(([relPath, count]) => [
        relPath,
        (current: RuntimeSignals): RuntimeSignals => {
          const bumped = recordAccessHits(current, count)
          return {
            ...current,
            accessCount: bumped.accessCount,
            importance: bumped.importance,
            maturity: determineTier(bumped.importance, current.maturity),
          }
        },
      ]),
    )

    try {
      await store.batchUpdate(updates)
    } catch (error) {
      // Best-effort — sidecar failure must not break the flush. The sidecar
      // will re-sync on the next bump for these paths; the warn makes the
      // fail-open visible to operators.
      warnSidecarFailure(
        this.logger,
        'search-knowledge-flush',
        'batchUpdate',
        `${updates.size} path(s)`,
        error,
      )
    }
  }

  /**
   * Run the standard text-based MiniSearch pipeline, optionally scoped to a subtree.
   */
  private runTextSearch(
    query: string,
    documentMap: Map<string, IndexedDocument>,
    index: MiniSearch<IndexedDocument>,
    limit: number,
    scopePath: string | undefined,
    pathToDocumentId: Map<string, string>,
    symbolTree: MemorySymbolTree,
    referenceIndex: ReferenceIndex,
    summaryMap: Map<string, SummaryDocLike>,
    symbolPathDocMap: Map<string, IndexedDocument>,
    signalsByPath: Map<string, RuntimeSignals>,
    elementAxisIndex: ElementAxisIndex,
    options?: SearchOptions,
  ): SearchKnowledgeResult {
    const filteredQuery = filterStopWords(query)
    const filteredWords = filteredQuery.split(/\s+/).filter((w) => w.length >= 2)

    // Compose the optional element-shape pre-filter from the search
    // call. When present, only documents containing the requested
    // `<bv-*>` (with optional attribute=value match) are eligible for
    // BM25 ranking. Today no caller supplies this hint; it's wired so
    // the structural-selector grammar can plug in without reshaping
    // the search service signature.
    let elementHintIds: Set<string> | undefined
    if (options?.elementHint) {
      const hint = options.elementHint
      const matching = 'attribute' in hint
        ? elementAxisIndex.findByAttribute(hint.tag, hint.attribute, hint.value)
        : elementAxisIndex.findByTag(hint.tag)
      elementHintIds = new Set(matching)
    }

    // Build scope filter if a subtree is specified
    let scopeFilter: ((result: {id: string}) => boolean) | undefined
    if (scopePath) {
      const subtreePaths = getSubtreeDocumentIds(symbolTree, scopePath)
      const subtreeQualifiedIds = new Set<string>()

      for (const symbolPath of subtreePaths) {
        const docId = pathToDocumentId.get(symbolPath)
        if (docId) {
          subtreeQualifiedIds.add(docId)
        }
      }

      if (subtreeQualifiedIds.size > 0) {
        scopeFilter = (result) => subtreeQualifiedIds.has(result.id)
      }
    }

    // Compose scope + element-hint filters into a single MiniSearch
    // predicate. Only documents passing both filters proceed to BM25.
    const composedFilter: ((result: {id: string}) => boolean) | undefined = scopeFilter || elementHintIds
      ? (result) => {
          if (scopeFilter && !scopeFilter(result)) return false
          if (elementHintIds && !elementHintIds.has(result.id)) return false
          return true
        }
      : undefined

    // AND-first strategy: for multi-word queries, try AND for concentrated scores.
    // If AND returns no results, fall back to OR to ensure no regression.
    let rawResults: Array<{id: string; queryTerms: string[]; score: number}>
    let andSearchFailed = false
    const searchOpts = composedFilter ? {filter: composedFilter} : {}

    if (filteredWords.length >= 2) {
      rawResults = index.search(filteredQuery, {combineWith: 'AND', ...searchOpts})
      if (rawResults.length === 0) {
        andSearchFailed = true
        rawResults = index.search(filteredQuery, {combineWith: 'OR', ...searchOpts})
      }
    } else {
      rawResults = index.search(filteredQuery, {combineWith: 'OR', ...searchOpts})
    }

    // Normalize BM25 scores to [0, 1) then blend with importance + recency via compound scoring.
    // Decay is computed lazily from file mtime — no disk writes during search.
    // Local results get a configurable score boost to prefer local knowledge over shared.
    //
    // Runtime signals (importance / recency / maturity) come from the sidecar
    // `signalsByPath` map. Paths with no sidecar entry fall back to defaults —
    // matches the pre-migration behaviour where missing-frontmatter files used
    // applyDefaultScoring().
    const now = Date.now()
    const searchResults = rawResults.map((r) => {
      const doc = documentMap.get(r.id)
      const signals = (doc && signalsByPath.get(doc.path)) ?? createDefaultRuntimeSignals()
      const daysSince = doc ? Math.max(0, (now - doc.mtime) / 86_400_000) : 0
      const decayed = applyDecay(signals, daysSince)
      const bm25 = normalizeScore(r.score)
      let finalScore = compoundScore(bm25, decayed)

      // Local score boost: prefer local results over shared when scores are close
      if (doc?.origin === 'local') {
        finalScore = Math.min(finalScore + SHARED_SOURCE_LOCAL_SCORE_BOOST, 1)
      }

      return {
        ...r,
        bm25Score: bm25,
        score: finalScore,
      }
    })
    searchResults.sort((a, b) => b.score - a.score)

    const results: SearchKnowledgeResult['results'] = []
    const propagationInputs: Array<{bm25Score: number; path: string}> = []

    let scoreFloor: number | undefined

    if (searchResults.length > 0) {
      // OOD detection: if the best result scores below the minimum floor,
      // the query has no meaningful match in the knowledge base.
      // Only apply for corpora with enough documents for reliable BM25 scoring.
      if (documentMap.size >= 50 && searchResults[0].score < MINIMUM_RELEVANCE_SCORE) {
        return {
          message: 'No matching knowledge found for this query. The topic may not be covered in the context tree.',
          results: [],
          totalFound: 0,
        }
      }

      // Term-based OOD: when AND search failed, check if significant query terms
      // are completely absent from the corpus. If unmatched terms exist and the
      // score is below the trusted threshold, the query is about an uncovered topic.
      if (
        andSearchFailed &&
        documentMap.size >= 50 &&
        searchResults[0].score < UNMATCHED_TERM_SCORE_THRESHOLD &&
        hasUnmatchedSignificantTerms(filteredWords, searchResults)
      ) {
        return {
          message: 'No matching knowledge found for this query. The topic may not be covered in the context tree.',
          results: [],
          totalFound: 0,
        }
      }

      const topScore = searchResults[0].score
      scoreFloor = topScore * SCORE_GAP_RATIO
      const resultLimit = Math.min(limit, searchResults.length)

      for (let i = 0; i < resultLimit; i++) {
        const result = searchResults[i]

        // Score-gap filter: skip results too far below the top score
        if (result.score < scoreFloor) break

        const document = documentMap.get(result.id)

        if (document) {
          const enriched = this.enrichResult(
            {
              excerpt: extractExcerpt(document.content, query),
              id: result.id,
              path: document.path,
              score: Math.round(result.score * 100) / 100,
              title: document.title,
            },
            symbolTree,
            referenceIndex,
            documentMap,
          )

          // Apply kind/maturity filters if specified
          if (options?.includeKinds && enriched.symbolKind && !options.includeKinds.includes(enriched.symbolKind)) {
            continue
          }

          if (options?.excludeKinds && enriched.symbolKind && options.excludeKinds.includes(enriched.symbolKind)) {
            continue
          }

          if (options?.minMaturity && enriched.symbolKind) {
            const docMaturity =
              enriched.symbolKind === 'summary'
                ? (() => {
                    const summaryDoc = getSummarySource(enriched.path, summaryMap, symbolPathDocMap)
                    return (
                      (summaryDoc && signalsByPath.get(summaryDoc.path)?.maturity) ??
                      symbolTree.symbolMap.get(enriched.path)?.metadata.maturity ??
                      'draft'
                    )
                  })()
                : (signalsByPath.get(document.path)?.maturity ??
                  symbolTree.symbolMap.get(document.symbolPath)?.metadata.maturity ??
                  'draft')
            if ((MATURITY_TIER_RANK[docMaturity] ?? 1) < (MATURITY_TIER_RANK[options.minMaturity] ?? 1)) {
              continue
            }
          }

          results.push(enriched)
          propagationInputs.push({
            bm25Score: result.bm25Score,
            path: document.symbolPath,
          })
        }
      }
    }

    // Propagate scores upward to parent domain/topic nodes (hierarchical retrieval)
    const propagated = propagateScoresToParents(
      propagationInputs,
      symbolTree,
      summaryMap,
      symbolPathDocMap,
      signalsByPath,
    )
    for (const p of propagated) {
      // Apply local score boost to propagated summaries so they stay competitive
      // with boosted direct BM25 hits (the boost was already applied to direct hits above)
      p.score = Math.min(p.score + SHARED_SOURCE_LOCAL_SCORE_BOOST, 1)

      if (scoreFloor !== undefined && p.score < scoreFloor) continue
      if (options?.includeKinds && p.symbolKind && !options.includeKinds.includes(p.symbolKind)) continue
      if (options?.excludeKinds && p.symbolKind && options.excludeKinds.includes(p.symbolKind)) continue
      if (options?.minMaturity && p.symbolKind === 'summary') {
        const summaryDoc = getSummarySource(p.path, summaryMap, symbolPathDocMap)
        const summaryMaturity = (summaryDoc && signalsByPath.get(summaryDoc.path)?.maturity) ?? 'draft'
        if ((MATURITY_TIER_RANK[summaryMaturity] ?? 1) < (MATURITY_TIER_RANK[options.minMaturity] ?? 1)) continue
      }

      results.push(p)
    }

    if (propagated.length > 0) {
      results.sort((a, b) => b.score - a.score)
      // Trim back to the caller-requested limit after propagated entries are merged in.
      if (results.length > limit) results.splice(limit)
    }

    // Accumulate access hits for returned results (flushed during next index rebuild).
    // Synthetic 'summary' results carry folder-style paths (e.g. 'auth') that are not
    // real files; map them to their _index.md so flushAccessHits can read and update them.
    if (results.length > 0) {
      this.accumulateAccessHits(
        results.map((r) =>
          r.symbolKind === 'summary' ? getSummaryAccessPath(r.path, summaryMap, symbolPathDocMap) : r.path,
        ),
      )
    }

    return {
      message:
        results.length > 0
          ? `Found ${searchResults.length} result(s). Use read_file to view full content.`
          : 'No matching knowledge found. Try different search terms or check available topics with /query.',
      results,
      totalFound: searchResults.length,
    }
  }

  /**
   * Try to resolve the query as a symbolic path. Returns null if no path match found.
   */
  private trySymbolicSearch(
    query: string,
    symbolTree: MemorySymbolTree,
    referenceIndex: ReferenceIndex,
    documentMap: Map<string, IndexedDocument>,
    index: MiniSearch<IndexedDocument>,
    limit: number,
    pathToDocumentId: Map<string, string>,
    summaryMap: Map<string, SummaryDocLike>,
    symbolPathDocMap: Map<string, IndexedDocument>,
    signalsByPath: Map<string, RuntimeSignals>,
    elementAxisIndex: ElementAxisIndex,
    options?: SearchOptions,
  ): null | SearchKnowledgeResult {
    const pathMatches = matchMemoryPath(symbolTree, query.split(/\s+/)[0].includes('/') ? query.split(/\s+/)[0] : query)

    if (pathMatches.length === 0) {
      return null
    }

    const topMatch = pathMatches[0].matchedSymbol

    // If the matched symbol is a leaf Context, return it directly
    if (topMatch.kind === MemorySymbolKind.Context) {
      const docId = pathToDocumentId.get(topMatch.path)
      const doc = docId ? documentMap.get(docId) : undefined
      if (!doc) {
        return null
      }

      const result = this.enrichResult(
        {excerpt: extractExcerpt(doc.content, query), id: doc.id, path: doc.path, score: 1, title: doc.title},
        symbolTree,
        referenceIndex,
        documentMap,
      )

      if (doc.origin === 'local') {
        this.accumulateAccessHits([doc.path])
      }

      return {
        message: `Found exact match: ${topMatch.path}`,
        results: [result],
        totalFound: 1,
      }
    }

    // Matched a folder node (Domain/Topic/Subtopic) — check for remaining text query
    const queryParts = query.trim().split(/\s+/)
    const pathPart = queryParts[0].includes('/') ? queryParts[0] : topMatch.name
    const textPart = query.slice(query.indexOf(pathPart) + pathPart.length).trim()

    if (textPart) {
      // Scoped search: search text within the matched subtree
      return this.runTextSearch(
        textPart,
        documentMap,
        index,
        limit,
        topMatch.path,
        pathToDocumentId,
        symbolTree,
        referenceIndex,
        summaryMap,
        symbolPathDocMap,
        signalsByPath,
        elementAxisIndex,
        options,
      )
    }

    // No text part — return all children of the matched node
    const subtreeIds = getSubtreeDocumentIds(symbolTree, topMatch.path)
    const results: SearchKnowledgeResult['results'] = []
    const accessHitPaths: string[] = []
    const summaryDoc = getSummarySource(topMatch.path, summaryMap, symbolPathDocMap)

    if (summaryDoc) {
      results.push({
        backlinkCount: 0,
        excerpt: summaryDoc.excerpt,
        path: topMatch.path,
        score: 1,
        symbolKind: 'summary',
        symbolPath: topMatch.path,
        title: topMatch.name,
      })
      accessHitPaths.push(summaryDoc.path)
    }

    for (const symbolPath of subtreeIds) {
      if (results.length >= limit) break

      const docId = pathToDocumentId.get(symbolPath)
      const doc = docId ? documentMap.get(docId) : undefined
      if (!doc) continue

      results.push(
        this.enrichResult(
          {excerpt: extractExcerpt(doc.content, query), id: doc.id, path: doc.path, score: 0.9, title: doc.title},
          symbolTree,
          referenceIndex,
          documentMap,
        ),
      )
      accessHitPaths.push(doc.path)
    }

    if (accessHitPaths.length > 0) {
      this.accumulateAccessHits(accessHitPaths)
    }

    return {
      message: `Found ${results.length} entries under ${topMatch.path}. Use read_file to view full content.`,
      results,
      totalFound: results.length,
    }
  }
}

/**
 * Factory function to create a SearchKnowledgeService instance.
 *
 * @param fileSystem - File system service
 * @param config - Optional configuration
 * @returns SearchKnowledgeService instance
 */
export function createSearchKnowledgeService(
  fileSystem: IFileSystem,
  config?: SearchKnowledgeServiceConfig,
): ISearchKnowledgeService {
  return new SearchKnowledgeService(fileSystem, config)
}
