import type {ICipherAgent} from '../../../../agent/core/interfaces/i-cipher-agent.js'
import type {LlmUsage} from '../../domain/entities/llm-usage.js'
import type {
  QueryLogMatchedDoc,
  QueryLogSearchMetadata,
  QueryLogTier,
  QueryLogTiming,
} from '../../domain/entities/query-log-entry.js'
import type {IUsageAggregator} from '../telemetry/i-usage-aggregator.js'

/**
 * Options for executing query with an injected agent.
 * Agent uses its default session (Single-Session pattern).
 */
export interface QueryExecuteOptions {
  /** Query content to search in context tree */
  query: string
  /** Task ID for event routing (required for concurrent task isolation) */
  taskId: string
  /**
   * Optional per-task usage aggregator. When provided, the executor reads
   * its rolled-up totals at completion and writes them to the result. The
   * caller is responsible for subscribing the aggregator to the agent's
   * `llmservice:usage` event stream (TODO: agent-process integration).
   *
   */
  usageAggregator?: IUsageAggregator
  /** Stable workspace root for scoping search and cache isolation */
  worktreeRoot?: string
}

/**
 * Structured result from QueryExecutor containing the response string
 * plus metadata about how the query was resolved.
 *
 * Consumed by QueryLogHandler (ENG-1893) to persist
 * query log entries with telemetry (token counts, latency tiers, format).
 */
export type QueryExecutorResult = {
  /**
   * Format mode of the docs the recall touched. `'html'` if any retrieved
   * file is HTML, otherwise `'markdown'`. Undefined when no files were
   * retrieved (Tier 0/1 cache hits, Tier 4 LLM-only).
   */
  format?: 'html' | 'markdown'
  /** Documents matched during search (empty for cache hits) */
  matchedDocs: QueryLogMatchedDoc[]
  /** The response string (includes attribution footer) */
  response: string
  /** Search statistics (undefined for cache-only tiers 0/1) */
  searchMetadata?: QueryLogSearchMetadata
  /** Resolution tier: 0=exact cache, 1=fuzzy cache, 2=direct search, 3=optimized LLM, 4=full agentic */
  tier: QueryLogTier
  /**
   * Wall-clock timing. `durationMs` mirrors `totalMs` for back-compat;
   * `searchMs` / `llmMs` / `totalMs` are the canonical fields.
   */
  timing: QueryLogTiming & {durationMs: number}
  /**
   * Token usage rolled up across all sub-LLM calls in the recall.
   * Undefined for tiers that ran no LLM call (Tier 0/1/2).
   */
  usage?: LlmUsage
}

/**
 * IQueryExecutor - Executes query tasks with an injected CipherAgent.
 *
 * This is NOT a UseCase (which orchestrates business logic).
 * It's an Executor that wraps agent.execute() with query-specific options.
 *
 * Architecture:
 * - AgentProcess injects the long-lived CipherAgent
 * - Event streaming is handled by agent-process (subscribes to agentEventBus)
 * - Executor focuses solely on query execution
 */
export interface IQueryExecutor {
  /**
   * Execute query in tool mode. Skips Tier 3/4 LLM dispatch — runs Tier
   * 0/1 cache + Tier-2-style retrieval (without the `canRespondDirectly`
   * threshold gate), returns rendered topic content for the calling
   * agent to synthesise from. No LLM provider required.
   *
   * Wire contract documented in the bundled SKILL.md (section 1,
   * "Tool mode — run query without an LLM provider"). Renaming any
   * field on the return type is a breaking change for tool consumers.
   */
  executeToolMode(options: QueryToolModeOptions): Promise<QueryToolModeResult>

  /**
   * Execute query with an injected agent.
   *
   * @param agent - Long-lived CipherAgent (managed by caller)
   * @param options - Execution options (query)
   * @returns Structured result with response, tier, timing, and search metadata
   */
  executeWithAgent(agent: ICipherAgent, options: QueryExecuteOptions): Promise<QueryExecutorResult>
}

/**
 * Options for tool-mode query.
 */
export type QueryToolModeOptions = {
  /** Max matches to return. Defaults to 10. Bounded 1-50 by the CLI flag. */
  limit?: number
  /** User question, verbatim. */
  query: string
  /** Stable workspace root for scoping search and cache isolation. */
  worktreeRoot?: string
}

/**
 * One retrieved doc returned to the calling agent. `rendered_md` is
 * snake_case to match the JSON wire envelope; renaming is a breaking
 * change.
 */
export type QueryToolModeMatchedDoc = {
  format: 'html' | 'markdown'
  path: string
  rendered_md: string
  score: number
  title: string
}

/**
 * Observability + cache signals carried alongside the matches.
 */
export type QueryToolModeMetadata = {
  /**
   * Which cache layer served the response. `null` when retrieval ran
   * fresh (no cache hit) or when the cache is disabled.
   */
  cacheHit?: 'exact' | 'fuzzy' | null
  durationMs: number
  /**
   * Number of matches the BM25 search returned that were dropped
   * because they originated from a shared source (origin !== 'local').
   * v1 of tool mode is local-only; this surfaces when a calling agent's
   * recall is incomplete so it can fall back to `brv search` for
   * cross-project context.
   */
  skippedSharedCount: number
  /** 0 = exact cache, 1 = fuzzy cache, 2 = direct search (no LLM). */
  tier: number
  topScore: number
  totalFound: number
}

/**
 * Wire envelope returned by every tool-mode query call. One-shot:
 * `done`/`continuation`-style states don't exist for query.
 *
 * - `status: 'ok'` — retrieval ran and produced one or more matches.
 * - `status: 'no-matches'` — retrieval ran cleanly but BM25 found
 *   nothing. EXPECTED outcome; outer envelope `success: true`.
 *
 * Dispatch / connection failures surface via the outer CLI envelope's
 * `success: false`.
 */
export type QueryToolModeResult = {
  matchedDocs: QueryToolModeMatchedDoc[]
  metadata: QueryToolModeMetadata
  status: 'no-matches' | 'ok'
}
