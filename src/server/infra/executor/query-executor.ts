import {join, relative} from 'node:path'

import type {ICipherAgent} from '../../../agent/core/interfaces/i-cipher-agent.js'
import type {IFileSystem} from '../../../agent/core/interfaces/i-file-system.js'
import type {ISearchKnowledgeService, SearchKnowledgeResult} from '../../../agent/infra/sandbox/tools-sdk.js'
import type {LlmUsage} from '../../core/domain/entities/llm-usage.js'
import type {QueryLogMatchedDoc, QueryLogTiming} from '../../core/domain/entities/query-log-entry.js'
import type {
  IQueryExecutor,
  QueryExecuteOptions,
  QueryExecutorResult,
  QueryToolModeMatchedDoc,
  QueryToolModeOptions,
  QueryToolModeResult,
} from '../../core/interfaces/executor/i-query-executor.js'
import type {IFormatDetector} from '../../core/interfaces/render/i-format-detector.js'

import {ABSTRACT_EXTENSION, BRV_DIR, CONTEXT_FILE_EXTENSION, CONTEXT_TREE_DIR} from '../../constants.js'
import {
  TIER_DIRECT_SEARCH,
  TIER_EXACT_CACHE,
  TIER_FULL_AGENTIC,
  TIER_FUZZY_CACHE,
  TIER_OPTIMIZED_LLM,
} from '../../core/domain/entities/query-log-entry.js'
import {loadSources} from '../../core/domain/source/source-schema.js'
import {isDerivedArtifact} from '../context-tree/derived-artifact.js'
import {FileContextTreeManifestService} from '../context-tree/file-context-tree-manifest-service.js'
import {ExtensionAwareFormatDetector} from '../render/format/extension-aware-format-detector.js'
import {renderHtmlTopicForLlm} from '../render/reader/html-renderer.js'
import {
  canRespondDirectly,
  type DirectSearchResult,
  formatDirectResponse,
  formatNotFoundResponse,
} from './direct-search-responder.js'
import {QueryResultCache} from './query-result-cache.js'

/** Attribution footer appended to all query responses */
const ATTRIBUTION_FOOTER = '\n\n---\nSource: ByteRover Knowledge Base'

/** Map search results to the matchedDocs shape for QueryExecutorResult. */
function buildMatchedDocs(sr: SearchKnowledgeResult | undefined): QueryLogMatchedDoc[] {
  return (sr?.results ?? []).map((r) => ({path: r.path, score: r.score, title: r.title}))
}

/** Minimum normalized score to consider a result high-confidence for pre-fetching */
const SMART_ROUTING_SCORE_THRESHOLD = 0.7

/** Maximum number of documents to pre-fetch and inject into the prompt */
const SMART_ROUTING_MAX_DOCS = 5

/**
 * Optional dependencies for QueryExecutor.
 * All fields are optional — without them, the executor falls back to the original behavior.
 */
export interface QueryExecutorDeps {
  /** Base directory for manifest service (e.g., project path) */
  baseDirectory?: string
  /** Enable query result caching (default: false) */
  enableCache?: boolean
  /** File system for reading full document content and computing fingerprints */
  fileSystem?: IFileSystem
  /**
   * Format-mode detector for `QueryExecutorResult.format`. Defaults to
   * {@link ExtensionAwareFormatDetector} — inspects each `matchedDoc.path`
   * extension and reports `'html'` if any HTML doc is in the recall, else
   * `'markdown'`. The legacy {@link MarkdownOnlyFormatDetector} stub is kept
   * around for tests that pin pre-migration behaviour but should not be
   * wired as the production default.
   */
  formatDetector?: IFormatDetector
  /** Search service for pre-fetching relevant context before calling the LLM */
  searchService?: ISearchKnowledgeService
}

/**
 * QueryExecutor - Executes query tasks with an injected CipherAgent.
 *
 * This is NOT a UseCase (which orchestrates business logic).
 * It's an Executor that wraps agent.execute() with query-specific options.
 *
 * Architecture:
 * - AgentProcess injects the long-lived CipherAgent
 * - Event streaming is handled by agent-process (subscribes to agentEventBus)
 * - Transport handles task lifecycle (task:started, task:completed, task:error)
 * - Executor focuses solely on query execution
 *
 * Tiered response strategy (fastest to slowest):
 * - Tier 0: Exact cache hit (0ms)
 * - Tier 1: Fuzzy cache match via Jaccard similarity (~50ms)
 * - Tier 2: Direct search response without LLM (~100-200ms)
 * - Tier 3: Optimized single LLM call with pre-fetched context (<5s)
 * - Tier 4: Full agentic loop fallback (8-15s)
 */
export class QueryExecutor implements IQueryExecutor {
  private static readonly FINGERPRINT_CACHE_TTL_MS = 30_000
  /** Default tool-mode limit when the CLI flag is not passed. Matches `--limit` default in `query.ts`. */
  private static readonly TOOL_MODE_DEFAULT_LIMIT = 10
  /**
   * Upper bound for tool-mode retrieval. Mirrors the CLI's `--limit`
   * max. The cache always stores up to this many matches so callers
   * with different `--limit` values can reuse the same cache entry
   * (sliced down on read).
   */
  private static readonly TOOL_MODE_MAX_LIMIT = 50
  private readonly baseDirectory?: string
  private readonly cache?: QueryResultCache
  private cachedFingerprint?: {expiresAt: number; sourceValidityHash: string; value: string; worktreeRoot?: string}
  private readonly fileSystem?: IFileSystem
  private readonly formatDetector: IFormatDetector
  private readonly searchService?: ISearchKnowledgeService
  /**
   * Dedicated cache for tool-mode envelopes. Separate instance from
   * `cache` because the stored shape differs (JSON-serialised
   * QueryToolModeResult vs LLM-synthesised response strings) — sharing
   * a Map would let a Tier-0 read in one path return data of the wrong
   * shape from the other.
   */
  private readonly toolModeCache?: QueryResultCache

  constructor(deps?: QueryExecutorDeps) {
    this.baseDirectory = deps?.baseDirectory
    this.fileSystem = deps?.fileSystem
    this.formatDetector = deps?.formatDetector ?? new ExtensionAwareFormatDetector()
    this.searchService = deps?.searchService
    if (deps?.enableCache) {
      this.cache = new QueryResultCache()
      this.toolModeCache = new QueryResultCache()
    }
  }

  /**
   * Tool-mode query: deterministic retrieval, no LLM. Runs Tier 0 / 1
   * cache, then Tier-2-style BM25 retrieval WITHOUT the
   * `canRespondDirectly` confidence gate — the calling agent decides
   * whether the matches are useful, not byterover. `supplementEntitySearches`
   * fires on thin queries (totalFound < 3) for richer recall.
   *
   * Wire contract: bundled SKILL.md (section 1, "Tool mode — run
   * query without an LLM provider"). Renaming any returned field is
   * breaking for tool consumers.
   */
  public async executeToolMode(options: QueryToolModeOptions): Promise<QueryToolModeResult> {
    return this.executeToolModeInternal(options)
  }

  public async executeWithAgent(agent: ICipherAgent, options: QueryExecuteOptions): Promise<QueryExecutorResult> {
    const startTime = Date.now()
    const {query, taskId, usageAggregator, worktreeRoot} = options
    const workspaceScope = this.deriveWorkspaceScope(worktreeRoot)
    // Mutable holders so prefer-const rule sees the bindings as never-reassigned
    // (we mutate properties rather than rebinding).
    const searchClock: {endMs?: number; startMs?: number} = {}
    const llmClock: {endMs?: number; startMs?: number} = {}

    // Start search early — runs in parallel with fingerprint computation (independent operations)
    if (this.searchService) {
      searchClock.startMs = Date.now()
    }

    const searchPromise = this.searchService?.search(query, {limit: SMART_ROUTING_MAX_DOCS, scope: workspaceScope})
    // Prevent unhandled rejection if we return early (cache hit) while search is still pending
    searchPromise?.catch(() => {})

    const buildTiming = (): QueryLogTiming & {durationMs: number} => {
      const totalMs = Date.now() - startTime
      // Prefer aggregator.getLlmMs() (sum of per-call LLM durations from
      // llmservice:usage events) over the executeOnSession wall-clock measured
      // by `llmClock`. The aggregator counts only the LLM-call portion, while
      // `llmClock` includes tool execution + other non-LLM work — overstates
      // LLM latency for paths that run tools. Fall back to the wall-clock
      // measurement when no aggregator is wired (tests, future call sites).
      const aggregatorLlmMs = usageAggregator?.getLlmMs()
      const llmClockMs = llmClock.startMs !== undefined && llmClock.endMs !== undefined
        ? llmClock.endMs - llmClock.startMs
        : undefined
      const llmMs = aggregatorLlmMs !== undefined && aggregatorLlmMs > 0 ? aggregatorLlmMs : llmClockMs
      return {
        durationMs: totalMs,
        ...(searchClock.startMs !== undefined && searchClock.endMs !== undefined && {searchMs: searchClock.endMs - searchClock.startMs}),
        ...(llmMs !== undefined && {llmMs}),
        totalMs,
      }
    }

    const usageOrUndefined = (): LlmUsage | undefined => {
      if (!usageAggregator) return undefined
      const totals = usageAggregator.getTotals()
      return totals.inputTokens === 0 && totals.outputTokens === 0 ? undefined : totals
    }

    // === Tier 0: Exact cache hit (0ms) ===
    let fingerprint: string | undefined
    if (this.cache && this.fileSystem) {
      fingerprint = await this.computeContextTreeFingerprint(worktreeRoot)
      const cached = this.cache.get(query, fingerprint)
      if (cached) {
        return {
          matchedDocs: [],
          response: cached + ATTRIBUTION_FOOTER,
          tier: TIER_EXACT_CACHE,
          timing: buildTiming(),
        }
      }
    }

    // === Tier 1: Fuzzy cache match (~50ms) ===
    if (this.cache && fingerprint) {
      const fuzzyHit = this.cache.findSimilar(query, fingerprint)
      if (fuzzyHit) {
        return {
          matchedDocs: [],
          response: fuzzyHit + ATTRIBUTION_FOOTER,
          tier: TIER_FUZZY_CACHE,
          timing: buildTiming(),
        }
      }
    }

    // Await search result (already started in parallel with fingerprint computation)
    let searchResult: SearchKnowledgeResult | undefined
    try {
      searchResult = await searchPromise
    } catch {
      // Search failed, proceed without pre-fetched context
    }

    // Supplementary entity-based searches for better multi-session recall
    if (this.searchService && searchResult && searchResult.totalFound < 3) {
      searchResult = await this.supplementEntitySearches(query, searchResult, workspaceScope)
    }

    searchClock.endMs = Date.now()

    // === OOD short-circuit: no results means topic not covered ===
    if (searchResult && searchResult.results.length === 0) {
      const response = formatNotFoundResponse(query)
      if (this.cache && fingerprint) {
        this.cache.set(query, response, fingerprint)
      }

      // Route through formatDetector with empty docs so an HTML-aware detector
      // can still report `'markdown'` (or whatever the default is) instead of
      // this branch silently bypassing the detector with `undefined`.
      return {
        format: this.formatDetector.detect([]),
        matchedDocs: [],
        response: response + ATTRIBUTION_FOOTER,
        searchMetadata: {resultCount: 0, topScore: 0, totalFound: 0},
        tier: TIER_DIRECT_SEARCH,
        timing: buildTiming(),
      }
    }

    // === Tier 2: Direct search response (~100-200ms) ===
    if (searchResult && this.fileSystem) {
      const directResult = await this.tryDirectSearchResponse(query, searchResult)
      if (directResult) {
        if (this.cache && fingerprint) {
          this.cache.set(query, directResult, fingerprint)
        }

        const directDocs = buildMatchedDocs(searchResult)
        return {
          format: this.formatDetector.detect(directDocs),
          matchedDocs: directDocs,
          response: directResult + ATTRIBUTION_FOOTER,
          searchMetadata: {
            cacheFingerprint: fingerprint,
            resultCount: searchResult.results.length,
            topScore: searchResult.results[0]?.score ?? 0,
            totalFound: searchResult.totalFound,
          },
          tier: TIER_DIRECT_SEARCH,
          timing: buildTiming(),
        }
      }
    }

    // === Tier 3/4: LLM call with RLM pattern (variable-based search results) ===
    let prefetchedContext: string | undefined
    if (searchResult && this.fileSystem) {
      prefetchedContext = this.buildPrefetchedContext(searchResult)
    }

    // Lazy manifest rebuild: provides broad structural awareness for LLM
    let manifestContext: string | undefined
    if (this.baseDirectory) {
      try {
        const manifestService = new FileContextTreeManifestService({baseDirectory: this.baseDirectory})
        let manifest = await manifestService.readManifestIfFresh(this.baseDirectory)
        if (!manifest) {
          manifest = await manifestService.buildManifest(this.baseDirectory)
        }

        if (manifest) {
          const resolved = await manifestService.resolveForInjection(manifest, query, this.baseDirectory)
          if (resolved.length > 0) {
            manifestContext = resolved.map((e) => `[${e.type} ${e.path}]\n${e.content}`).join('\n\n---\n\n')
          }
        }
      } catch {
        // Fail-open: proceed without manifest context
      }
    }

    // Create per-task session for parallel isolation (own sandbox + history + LLM service)
    const taskSessionId = await agent.createTaskSession(taskId, 'query', {userFacing: true})

    // Task-scoped variable names for sandbox injection (RLM pattern).
    // Replace hyphens with underscores: UUIDs have hyphens which are invalid in JS identifiers,
    // so the LLM uses underscores when writing code-exec calls — matching curate-executor pattern.
    const taskIdSafe = taskId.replaceAll('-', '_')
    const resultsVar = `__query_results_${taskIdSafe}`
    const metaVar = `__query_meta_${taskIdSafe}`

    // Compute metadata for LLM guidance
    const metadata = {
      hasPreFetched: Boolean(prefetchedContext),
      resultCount: searchResult?.results.length ?? 0,
      topScore: searchResult?.results[0]?.score ?? 0,
      totalFound: searchResult?.totalFound ?? 0,
    }

    // Inject search results + metadata into the TASK session's sandbox
    agent.setSandboxVariableOnSession(taskSessionId, resultsVar, searchResult?.results ?? [])
    agent.setSandboxVariableOnSession(taskSessionId, metaVar, metadata)

    // Inject workspace scope so agent follow-up searches are workspace-aware
    const scopeVar = workspaceScope ? `__query_scope_${taskIdSafe}` : undefined
    if (scopeVar && workspaceScope) {
      agent.setSandboxVariableOnSession(taskSessionId, scopeVar, workspaceScope)
    }

    const prompt = this.buildQueryPrompt(query, {
      manifestContext,
      metadata,
      metaVar,
      prefetchedContext,
      resultsVar,
      scopeVar,
    })

    // Query-optimized LLM overrides: tokens and lower temperature
    const queryOverrides = prefetchedContext
      ? {maxIterations: 50, maxTokens: 1024, temperature: 0.3}
      : {maxIterations: 50, maxTokens: 2048, temperature: 0.5}

    try {
      llmClock.startMs = Date.now()
      const response = await agent.executeOnSession(taskSessionId, prompt, {
        executionContext: {commandType: 'query', ...queryOverrides},
        taskId,
      })
      llmClock.endMs = Date.now()

      // Store in cache for future Tier 0/1 hits
      if (this.cache && fingerprint) {
        this.cache.set(query, response, fingerprint)
      }

      const tier = prefetchedContext ? TIER_OPTIMIZED_LLM : TIER_FULL_AGENTIC
      const llmDocs = buildMatchedDocs(searchResult)
      return {
        format: this.formatDetector.detect(llmDocs),
        matchedDocs: llmDocs,
        response: response + ATTRIBUTION_FOOTER,
        searchMetadata: {
          cacheFingerprint: fingerprint,
          resultCount: searchResult?.results.length ?? 0,
          topScore: searchResult?.results[0]?.score ?? 0,
          totalFound: searchResult?.totalFound ?? 0,
        },
        tier,
        timing: buildTiming(),
        ...(usageOrUndefined() !== undefined && {usage: usageOrUndefined()}),
      }
    } finally {
      // Clean up entire task session (sandbox + history) in one call
      await agent.deleteTaskSession(taskSessionId)
    }
  }

  /**
   * Empty-envelope helper for executeToolMode early-return (no
   * search service wired). Search-throw failures now propagate to
   * the daemon and surface via outer `success: false` instead, so
   * this only runs on the "tool mode not fully provisioned" path.
   */
  private buildEmptyToolModeEnvelope(startTime: number): QueryToolModeResult {
    return {
      matchedDocs: [],
      metadata: {
        cacheHit: null,
        durationMs: Date.now() - startTime,
        skippedSharedCount: 0,
        tier: TIER_DIRECT_SEARCH,
        topScore: 0,
        totalFound: 0,
      },
      status: 'no-matches',
    }
  }

  /**
   * Build pre-fetched context string from search results for LLM prompt injection.
   * Synchronous — uses already-fetched search results (no additional I/O for excerpts).
   * Full document reads happen only for high-confidence results.
   */
  private buildPrefetchedContext(searchResult: SearchKnowledgeResult): string | undefined {
    if (searchResult.totalFound === 0) return undefined

    const highConfidenceResults = searchResult.results.filter((r) => r.score >= SMART_ROUTING_SCORE_THRESHOLD)

    if (highConfidenceResults.length === 0) return undefined

    const sections = highConfidenceResults.map((r) => {
      const source =
        r.origin === 'shared' && r.originAlias ? `[${r.originAlias}]:${r.path}` : `.brv/context-tree/${r.path}`

      return `### ${r.title}\n**Source**: ${source}\n\n${r.excerpt}`
    })

    return sections.join('\n\n---\n\n')
  }

  /**
   * Build a query prompt using RLM pattern (variable references, not embedded data).
   *
   * Search results are pre-loaded into sandbox variables. The prompt references
   * variable names so the LLM accesses results via code_exec, not via the prompt.
   *
   * @param query - User query
   * @param options - Prompt options with variable names and metadata
   */
  private buildQueryPrompt(
    query: string,
    options: {
      manifestContext?: string
      metadata: {hasPreFetched: boolean; resultCount: number; topScore: number; totalFound: number}
      metaVar: string
      prefetchedContext?: string
      resultsVar: string
      scopeVar?: string
    },
  ): string {
    const {manifestContext, metadata, metaVar, prefetchedContext, resultsVar, scopeVar} = options
    const groundingRules = `### Grounding Rules (CRITICAL)
- ONLY use information from the curated knowledge base (local .brv/context-tree/ plus any read-only shared sources)
- If no relevant knowledge is found, respond: "This topic is not covered in the knowledge base."
- Do NOT extrapolate, infer, or generate information beyond what is explicitly stated in sources
- Every claim MUST be traceable to a specific source file
- When uncertain, say "Based on available knowledge..." and note the limitation`

    const responseFormat = `### Response Format
- **Summary**: Direct answer (2-3 sentences)
- **Details**: Key findings with explanations
- **Sources**: Use .brv/context-tree/... for local knowledge and [alias]:path for shared sources
- **Gaps**: Note any aspects not covered`

    const manifestSection = manifestContext
      ? `\n## Structural Context (from manifest)\nThe following provides broad structural awareness of the knowledge base:\n\n${manifestContext}\n`
      : ''

    // When workspace scope is active, instruct the agent to pass it to follow-up searches
    const scopeGuidance = scopeVar
      ? `\nFor any follow-up \`tools.searchKnowledge()\` calls, pass \`{ scope: ${scopeVar} }\` to scope results to the current workspace.`
      : ''

    if (prefetchedContext) {
      return `## User Query
${query}

## Pre-fetched Context
The following relevant knowledge was found in the context tree:

${prefetchedContext}
${manifestSection}
## Search Results Variable
Additional search results: \`${resultsVar}\` (${metadata.resultCount} results, top score: ${metadata.topScore.toFixed(2)})
Metadata: \`${metaVar}\`

## Instructions

Answer the user's question using the pre-fetched context above.
If the pre-fetched context does not directly address the user's query topic, respond that the topic is not covered in the knowledge base. Do not attempt to answer from tangentially related content.
If the context is insufficient but relevant, use \`code_exec\` with \`silent: true\` to read additional documents from the search results variable. Use \`setFinalResult(answer)\` when done.${scopeGuidance}

${groundingRules}

${responseFormat}`
    }

    return `## User Query
${query}
${manifestSection}
## Search Results Variable
Search results: \`${resultsVar}\` (${metadata.resultCount} results, top score: ${metadata.topScore.toFixed(2)})
Metadata: \`${metaVar}\`

## Instructions

Use \`code_exec\` to examine the search results in \`${resultsVar}\`, read relevant documents with \`tools.readFile()\`, and synthesize an answer.
Use \`silent: true\` for data-loading code_exec calls. Use \`setFinalResult(answer)\` to return the final answer immediately.${scopeGuidance}

${groundingRules}

${responseFormat}`
  }

  /**
   * Read + render content for each match in a search result. Skips
   * shared-source matches in v1 (their context-tree root may live
   * outside `<projectRoot>/.brv/` and isn't covered by the
   * path-safety checks). Files that vanished or are unreadable are
   * dropped silently — a stale BM25 index shouldn't fail the query.
   *
   * Returns the skipped-shared count alongside matches so callers can
   * surface it in `metadata.skippedSharedCount` — calling agents need
   * a way to detect when their tool-mode recall is incomplete vs
   * genuinely empty.
   */
  private async buildToolModeMatches(
    searchResult: SearchKnowledgeResult,
  ): Promise<{matchedDocs: QueryToolModeMatchedDoc[]; skippedSharedCount: number}> {
    if (!this.fileSystem) return {matchedDocs: [], skippedSharedCount: 0}

    const allResults = searchResult.results ?? []
    const localResults = allResults.filter((r) => !r.origin || r.origin === 'local')
    const skippedSharedCount = allResults.length - localResults.length
    const enriched = await Promise.all(
      localResults.map(async (result) => {
        const ctBase = result.originContextTreeRoot ?? join(BRV_DIR, CONTEXT_TREE_DIR)
        const ctPath = join(ctBase, result.path)
        try {
          const {content: raw} = await this.fileSystem!.readFile(ctPath)
          const format: 'html' | 'markdown' = result.format === 'html' ? 'html' : 'markdown'
          let rendered = raw
          if (format === 'html') {
            try {
              rendered = renderHtmlTopicForLlm(raw)
            } catch {
              // Renderer is forgiving by contract; fall back to raw bytes on the rare throw.
            }
          }

          return {
            format,
            path: result.path,
            // eslint-disable-next-line camelcase
            rendered_md: rendered,
            score: result.score,
            title: result.title ?? result.path,
          }
        } catch {
          // Stale BM25 index: file vanished or unreadable. Drop the
          // match silently — implicit undefined return is filtered out
          // by the typeguard below.
        }
      }),
    )

    return {
      matchedDocs: enriched.filter((m): m is QueryToolModeMatchedDoc => m !== undefined),
      skippedSharedCount,
    }
  }

  /**
   * Compute a context tree fingerprint cheaply using file mtimes.
   * Used for cache invalidation — if any file in the context tree changes,
   * the fingerprint changes and cached results are invalidated.
   *
   * Includes worktreeRoot in the hash so different workspaces produce
   * different fingerprints, preventing cross-workspace cache bleed.
   */
  private async computeContextTreeFingerprint(worktreeRoot?: string): Promise<string> {
    // Fast path: return cached fingerprint if still valid (avoids globFiles I/O)
    // Invalidate if worktreeRoot changed or knowledge source validity changed
    if (
      this.cachedFingerprint &&
      Date.now() < this.cachedFingerprint.expiresAt &&
      this.cachedFingerprint.worktreeRoot === worktreeRoot &&
      this.cachedFingerprint.sourceValidityHash === this.computeSourceValidityHash()
    ) {
      return this.cachedFingerprint.value
    }

    try {
      const contextTreePath = join(BRV_DIR, CONTEXT_TREE_DIR)
      const globResult = await this.fileSystem!.globFiles(`**/*${CONTEXT_FILE_EXTENSION}`, {
        cwd: contextTreePath,
        includeMetadata: true,
        maxResults: 10_000,
        respectGitignore: false,
      })

      // Filter out non-searchable derived artifacts (_index.md, _manifest.json, .full.md).
      // Stubs (.stub.md) are intentionally kept — archive/restore should invalidate cache.
      // Summary-only churn does NOT invalidate cache (summaries are derivative content).
      const files = globResult.files
        .filter((f) => !isDerivedArtifact(f.path))
        .map((f) => ({
          mtime: f.modified?.getTime() ?? 0,
          path: worktreeRoot ? `${worktreeRoot}:${f.path}` : f.path,
        }))

      // Include shared source state in fingerprint so edits in shared
      // projects invalidate cached query answers.
      const loaded = this.baseDirectory ? loadSources(this.baseDirectory) : undefined
      if (loaded) {
        // sources-file mtime detects source additions/removals
        if (loaded.mtime) {
          files.push({mtime: loaded.mtime, path: '__sources.json__'})
        }

        // Glob each shared context tree for file-level change detection
        const sharedResults = await Promise.all(
          loaded.origins.map(async (origin) => {
            try {
              const sharedGlob = await this.fileSystem!.globFiles(`**/*${CONTEXT_FILE_EXTENSION}`, {
                cwd: origin.contextTreeRoot,
                includeMetadata: true,
                maxResults: 10_000,
                respectGitignore: false,
              })

              return sharedGlob.files
                .filter((f) => !isDerivedArtifact(f.path))
                .map((f) => ({mtime: f.modified?.getTime() ?? 0, path: `shared:${origin.originKey}:${f.path}`}))
            } catch {
              // Broken source — skip
              return []
            }
          }),
        )
        files.push(...sharedResults.flat())
      }

      // Include .abstract.md siblings so newly-written abstracts invalidate the cache.
      // They are excluded by isDerivedArtifact() above, so we append them separately.
      const abstractFiles = globResult.files
        .filter((f) => f.path.endsWith(ABSTRACT_EXTENSION))
        .map((f) => ({
          mtime: f.modified?.getTime() ?? 0,
          path: f.path,
        }))

      const fingerprint = QueryResultCache.computeFingerprint([...files, ...abstractFiles])
      this.cachedFingerprint = {
        expiresAt: Date.now() + QueryExecutor.FINGERPRINT_CACHE_TTL_MS,
        sourceValidityHash: this.computeSourceValidityHash(),
        value: fingerprint,
        worktreeRoot,
      }
      return fingerprint
    } catch {
      return 'unknown'
    }
  }

  /**
   * Lightweight hash of currently valid shared source keys.
   * Used by the fingerprint cache fast path to detect when a source target
   * becomes broken (directory deleted) within the TTL window.
   * Cost: one readFileSync + existsSync per source — sub-millisecond for typical setups.
   */
  private computeSourceValidityHash(): string {
    if (!this.baseDirectory) return ''
    const loaded = loadSources(this.baseDirectory)
    if (!loaded) return 'no-sources'

    return loaded.origins
      .map((o) => o.originKey)
      .sort()
      .join(',')
  }

  /**
   * Derive a workspace scope for search from the worktreeRoot.
   * Returns the relative path from projectRoot to worktreeRoot,
   * or undefined if they are the same (no scoping needed).
   *
   * KNOWN LIMITATION: Workspace scoping only works if the curated context
   * tree has a subtree matching the workspace relative path (e.g., 'packages/api').
   * Since the context tree is organized semantically by the LLM (topic-based),
   * not by directory structure, scope filtering typically has 0 matches and
   * falls through to unscoped search. A proper fix requires tagging curated
   * files with source workspace metadata during curation.
   */
  private deriveWorkspaceScope(worktreeRoot?: string): string | undefined {
    if (!worktreeRoot || !this.baseDirectory) return undefined
    if (worktreeRoot === this.baseDirectory) return undefined
    const rel = relative(this.baseDirectory, worktreeRoot)

    return rel || undefined
  }

  private async executeToolModeInternal(options: QueryToolModeOptions): Promise<QueryToolModeResult> {
    const startTime = Date.now()
    const {limit = QueryExecutor.TOOL_MODE_DEFAULT_LIMIT, query, worktreeRoot} = options
    const workspaceScope = this.deriveWorkspaceScope(worktreeRoot)

    // === Tier 0: Exact cache hit ===
    //
    // Cache entries always hold up to `TOOL_MODE_MAX_LIMIT` matches.
    // We slice down to the caller's `limit` on read so calls with
    // different `--limit` values share one cache entry — a `--limit 50`
    // request followed by `--limit 1` returns the same top doc.
    let fingerprint: string | undefined
    if (this.toolModeCache && this.fileSystem) {
      fingerprint = await this.computeContextTreeFingerprint(worktreeRoot)
      const cached = this.toolModeCache.get(query, fingerprint)
      if (cached) {
        const overlaid = this.overlayCachedEnvelope(cached, 'exact', TIER_EXACT_CACHE, startTime, limit)
        if (overlaid) return overlaid
      }
    }

    // === Tier 1: Fuzzy cache hit ===
    if (this.toolModeCache && fingerprint) {
      const fuzzy = this.toolModeCache.findSimilar(query, fingerprint)
      if (fuzzy) {
        const overlaid = this.overlayCachedEnvelope(fuzzy, 'fuzzy', TIER_FUZZY_CACHE, startTime, limit)
        if (overlaid) return overlaid
      }
    }

    // === Tier 2: BM25 retrieval + supplement + render ===
    if (!this.searchService) {
      return this.buildEmptyToolModeEnvelope(startTime)
    }

    // Always retrieve at MAX_LIMIT so the cache entry serves smaller
    // subsequent requests without re-fetching. Slicing happens after
    // the cache write.
    //
    // searchService.search() throws on transport-level failures (index
    // unavailable, malformed payload, etc.). DON'T swallow into an
    // empty envelope — that would conflate "broken retrieval" with
    // "genuinely no matches" and let the calling agent synthesise
    // around an outage. Let the throw propagate; the daemon catches
    // it and emits task:error, which the CLI maps to outer
    // `success: false`.
    let searchResult: SearchKnowledgeResult = await this.searchService.search(query, {
      limit: QueryExecutor.TOOL_MODE_MAX_LIMIT,
      scope: workspaceScope,
    })

    if (searchResult.totalFound < 3) {
      searchResult = await this.supplementEntitySearches(query, searchResult, workspaceScope)
    }

    const {matchedDocs: allMatches, skippedSharedCount} = await this.buildToolModeMatches(searchResult)
    const topScore = allMatches[0]?.score ?? 0
    const status: QueryToolModeResult['status'] = allMatches.length === 0 ? 'no-matches' : 'ok'
    const totalFound = searchResult.totalFound ?? allMatches.length

    // Cache the FULL envelope (up to TOOL_MODE_MAX_LIMIT matches) so
    // subsequent calls with a smaller `--limit` slice down on read.
    // `durationMs` here is a placeholder — overlayCachedEnvelope
    // overwrites it with the cache-read latency.
    if (this.toolModeCache && fingerprint && status === 'ok') {
      const fullEnvelope: QueryToolModeResult = {
        matchedDocs: allMatches,
        metadata: {cacheHit: null, durationMs: 0, skippedSharedCount, tier: TIER_DIRECT_SEARCH, topScore, totalFound},
        status,
      }
      this.toolModeCache.set(query, JSON.stringify(fullEnvelope), fingerprint)
    }

    return {
      matchedDocs: allMatches.slice(0, limit),
      metadata: {
        cacheHit: null,
        durationMs: Date.now() - startTime,
        skippedSharedCount,
        tier: TIER_DIRECT_SEARCH,
        topScore,
        totalFound,
      },
      status,
    }
  }

  /**
   * Extract key entities from a query for supplementary searches.
   * Simple heuristic: split query, filter stopwords, keep significant terms.
   */
  private extractQueryEntities(query: string): string[] {
    const stopwords = new Set([
      'a',
      'about',
      'an',
      'and',
      'by',
      'did',
      'do',
      'does',
      'for',
      'from',
      'how',
      'in',
      'is',
      'my',
      'of',
      'or',
      'our',
      'that',
      'the',
      'their',
      'this',
      'to',
      'was',
      'were',
      'what',
      'when',
      'where',
      'which',
      'who',
      'with',
    ])
    const words = query.toLowerCase().split(/\s+/)

    return words.filter((w) => w.length >= 3 && !stopwords.has(w))
  }

  /**
   * Parse a cached tool-mode envelope JSON string, slice its
   * `matchedDocs` to the caller's `limit`, and overlay cacheHit + tier
   * + durationMs onto its metadata. Returns undefined when parse
   * fails (corrupt cache entry) so the caller can fall through to
   * fresh retrieval instead of crashing.
   *
   * Slicing is what lets one cache entry serve different `--limit`
   * values — the cached envelope always holds up to
   * `TOOL_MODE_MAX_LIMIT` matches, and we trim down on read. `topScore`
   * and `totalFound` are kept from the cached envelope intentionally:
   * `topScore` survives the slice (matchedDocs[0] is the same), and
   * `totalFound` reports the corpus count which is independent of the
   * caller's display limit.
   */
  private overlayCachedEnvelope(
    cached: string,
    cacheHit: 'exact' | 'fuzzy',
    tier: number,
    startTime: number,
    limit: number,
  ): QueryToolModeResult | undefined {
    try {
      const parsed = JSON.parse(cached) as QueryToolModeResult
      return {
        ...parsed,
        matchedDocs: parsed.matchedDocs.slice(0, limit),
        metadata: {
          ...parsed.metadata,
          cacheHit,
          durationMs: Date.now() - startTime,
          tier,
        },
      }
    } catch {
      return undefined
    }
  }

  /**
   * Run supplementary entity-based searches to improve recall.
   * Extracts key entities from the query and searches for each independently,
   * then merges unique results (by path) into the original search result.
   *
   * @param query - Original user query
   * @param searchResult - Initial search result to supplement
   * @returns Merged search result with additional entity-based matches
   */
  private async supplementEntitySearches(
    query: string,
    searchResult: SearchKnowledgeResult,
    scope?: string,
  ): Promise<SearchKnowledgeResult> {
    const entities = this.extractQueryEntities(query)
    if (entities.length <= 1) return searchResult

    try {
      const entitySearches = await Promise.allSettled(
        entities.slice(0, 3).map((entity) => this.searchService!.search(entity, {limit: 3, scope})),
      )

      // Collect existing paths to deduplicate
      const existingPaths = new Set(
        searchResult.results.map((r) => `${r.originAlias ?? r.origin ?? 'local'}::${r.path}`),
      )
      const supplementary = []

      for (const settled of entitySearches) {
        if (settled.status === 'fulfilled' && settled.value.results) {
          for (const result of settled.value.results) {
            const resultKey = `${result.originAlias ?? result.origin ?? 'local'}::${result.path}`
            if (!existingPaths.has(resultKey)) {
              existingPaths.add(resultKey)
              supplementary.push(result)
            }
          }
        }
      }

      if (supplementary.length === 0) return searchResult

      return {
        ...searchResult,
        results: [...searchResult.results, ...supplementary],
        totalFound: searchResult.totalFound + supplementary.length,
      }
    } catch {
      return searchResult
    }
  }

  /**
   * Attempt to produce a direct response from search results without LLM.
   * Returns formatted response if high-confidence dominant match found, undefined otherwise.
   *
   * Uses higher thresholds than smart routing (score >= 8, 2x dominance)
   * to ensure only clearly answerable queries bypass the LLM.
   */
  private async tryDirectSearchResponse(
    query: string,
    searchResult: SearchKnowledgeResult,
  ): Promise<string | undefined> {
    try {
      if (searchResult.totalFound === 0) return undefined

      // Build full results with content
      const fullResults: DirectSearchResult[] = await Promise.all(
        searchResult.results
          .filter((r) => r.score >= SMART_ROUTING_SCORE_THRESHOLD)
          .slice(0, SMART_ROUTING_MAX_DOCS)
          .map(async (result) => {
            let content = result.excerpt
            try {
              // Use originContextTreeRoot for shared results, local context tree for local
              const ctBase = result.originContextTreeRoot ?? join(BRV_DIR, CONTEXT_TREE_DIR)
              const ctPath = join(ctBase, result.path)
              const {content: fullContent} = await this.fileSystem!.readFile(ctPath)
              // HTML topics: render the typed-element document as a
              // markdown-like string before handing it to the response
              // formatter. Shipping raw `<bv-topic>...</bv-topic>` markup
              // here would burn the 5000-char content budget on tags
              // (`direct-search-responder.ts:11`) and force any
              // downstream LLM consumer to re-parse the document. The
              // renderer preserves bv-* element semantics (severity,
              // subject/value, decision id) without the markup tax.
              if (result.format === 'html') {
                try {
                  content = renderHtmlTopicForLlm(fullContent)
                } catch {
                  // Renderer is forgiving by contract — but if anything
                  // throws, fall back to the raw bytes so we don't
                  // blank the response on a single malformed topic.
                  content = fullContent
                }
              } else {
                content = fullContent
              }
            } catch {
              // Use excerpt if full read fails
            }

            // Include source attribution in path for shared results
            const displayPath =
              result.origin === 'shared' && result.originAlias ? `[${result.originAlias}]:${result.path}` : result.path

            return {content, path: displayPath, score: result.score, title: result.title}
          }),
      )

      if (!canRespondDirectly(fullResults)) return undefined

      return formatDirectResponse(query, fullResults)
    } catch {
      return undefined
    }
  }
}
