// ── Single source of truth: runtime arrays → derived types ───────────────────
// Tiers originate from QueryExecutor (src/server/infra/executor/query-executor.ts).
// Statuses track the entry lifecycle. Both are domain concepts.

/** Valid resolution tiers. Add/remove here — the type updates automatically. */
export const QUERY_LOG_TIERS = [0, 1, 2, 3, 4] as const
export type QueryLogTier = (typeof QUERY_LOG_TIERS)[number]

export type TierKey = `tier${QueryLogTier}`

/** Named tier constants — single source of truth for tier assignments in QueryExecutor. */
export const TIER_EXACT_CACHE: QueryLogTier = 0
export const TIER_FUZZY_CACHE: QueryLogTier = 1
export const TIER_DIRECT_SEARCH: QueryLogTier = 2
export const TIER_OPTIMIZED_LLM: QueryLogTier = 3
export const TIER_FULL_AGENTIC: QueryLogTier = 4

/** Human-readable labels for each resolution tier (used in detail view). */
export const QUERY_LOG_TIER_LABELS: Record<QueryLogTier, string> = {
  [TIER_DIRECT_SEARCH]: 'direct search',
  [TIER_EXACT_CACHE]: 'exact cache hit',
  [TIER_FULL_AGENTIC]: 'full agentic',
  [TIER_FUZZY_CACHE]: 'fuzzy cache match',
  [TIER_OPTIMIZED_LLM]: 'optimized LLM',
}

/** Abbreviated tier labels for summary display. */
export const QUERY_LOG_TIER_SHORT_LABELS: Record<QueryLogTier, string> = {
  [TIER_DIRECT_SEARCH]: 'direct',
  [TIER_EXACT_CACHE]: 'exact',
  [TIER_FULL_AGENTIC]: 'agentic',
  [TIER_FUZZY_CACHE]: 'fuzzy',
  [TIER_OPTIMIZED_LLM]: 'LLM',
}

/** Tiers considered cache hits for cache-hit-rate calculation. */
export const CACHE_TIERS = [TIER_EXACT_CACHE, TIER_FUZZY_CACHE] as const satisfies readonly QueryLogTier[]

export type ByTier = Record<TierKey, number> & {unknown: number}

// Single `as` contained here — TS cannot prove loop exhaustiveness over template literal keys.
export function emptyByTier(): ByTier {
  const obj: Record<string, number> = {}
  for (const t of QUERY_LOG_TIERS) {
    obj[`tier${t}`] = 0
  }

  obj.unknown = 0
  return obj as ByTier
}

/** Valid query log statuses. Add/remove here — the type updates automatically. */
export const QUERY_LOG_STATUSES = ['cancelled', 'completed', 'error', 'processing'] as const
export type QueryLogStatus = (typeof QUERY_LOG_STATUSES)[number]

// ── Entity types ─────────────────────────────────────────────────────────────

export type QueryLogMatchedDoc = {
  path: string
  score: number
  title: string
}

export type QueryLogSearchMetadata = {
  cacheFingerprint?: string
  resultCount: number
  topScore: number
  totalFound: number
}

/**
 * Per-recall latency tiers. All optional for back-compat with
 * pre-telemetry entries. `durationMs` is kept for legacy readers; new
 * consumers should prefer `totalMs` (the canonical name going forward).
 */
export type QueryLogTiming = {
  /** @deprecated Prefer `totalMs`. Kept for back-compat with old entries. */
  durationMs?: number
  /** Sum of LLM-call durations (Tier 3/4 only; undefined when no LLM call ran). */
  llmMs?: number
  /** BM25 search wall-clock (Tier 2/3/4 only; undefined for cache hits). */
  searchMs?: number
  /** Full executor entry → return wall-clock. */
  totalMs?: number
}

type QueryLogBase = {
  /** Tokens written to cache on first call (Anthropic `cache_creation_input_tokens`). */
  cacheCreationTokens?: number
  /** Tokens read from prompt cache (Anthropic `cache_read_input_tokens`, Gemini `cachedContentTokenCount`). */
  cachedInputTokens?: number
  /**
   * Format mode of the docs the recall touched. `'html'` if any retrieved
   * file is HTML, otherwise `'markdown'`. Undefined when no files were
   * retrieved (Tier 0/1 cache hits, Tier 4 LLM-only)..
   */
  format?: 'html' | 'markdown'
  id: string
  /** Tokens consumed for the prompt (Anthropic `input_tokens`). */
  inputTokens?: number
  matchedDocs: QueryLogMatchedDoc[]
  /** Tokens emitted for the completion (Anthropic `output_tokens`). */
  outputTokens?: number
  query: string
  searchMetadata?: QueryLogSearchMetadata
  startedAt: number
  taskId: string
  tier?: QueryLogTier
  timing?: QueryLogTiming
}

export type QueryLogEntry =
  | (QueryLogBase & {completedAt: number; error: string; status: 'error'})
  | (QueryLogBase & {completedAt: number; response?: string; status: 'completed'})
  | (QueryLogBase & {completedAt: number; status: 'cancelled'})
  | (QueryLogBase & {status: 'processing'})
