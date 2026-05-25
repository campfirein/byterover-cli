import type {LlmUsage} from './llm-usage.js'

export type CurateLogOperation = {
  additionalFilePaths?: string[]
  confidence?: 'high' | 'low'
  filePath?: string
  impact?: 'high' | 'low'
  message?: string
  needsReview?: boolean
  path: string
  /** Semantic summary of the file's content before this operation (for review UI). */
  previousSummary?: string
  reason?: string
  /** Local review status. Set to 'pending' when needsReview=true; updated to 'approved'/'rejected' by the review UI. */
  reviewStatus?: 'approved' | 'pending' | 'rejected'
  status: 'failed' | 'success'
  /** Semantic summary of the file's content after this operation (for review UI). */
  summary?: string
  type: 'ADD' | 'DELETE' | 'MERGE' | 'UPDATE' | 'UPSERT'
}

export type CurateLogSummary = {
  added: number
  deleted: number
  failed: number
  merged: number
  updated: number
}

/**
 * Curate-side latency tiers . All optional for back-compat with
 * pre-telemetry entries. No `searchMs` — curate has no BM25 search phase.
 */
export type CurateLogTiming = {
  /** Sum of LLM-call durations across pre-compaction + agent loop + summary cascade. */
  llmMs?: number
  /** Full executor entry → return wall-clock. */
  totalMs?: number
}

/**
 * Telemetry payload supplied by `CurateExecutor` at completion. Lives in
 * the domain layer so both the executor interface and the log-handler can
 * reference it without crossing the `core → infra` boundary.
 */
export type CurateUsageRecord = {
  format?: 'html' | 'markdown'
  timing?: CurateLogTiming
  usage?: LlmUsage
}

type CurateLogBase = {
  /** Tokens written to cache on first call (Anthropic `cache_creation_input_tokens`). */
  cacheCreationTokens?: number
  /** Tokens read from prompt cache. */
  cachedInputTokens?: number
  /**
   * Format mode of the curate output. `'html'` when `useHtmlContextTree` is
   * on, else `'markdown'`. Settled at task start, not derived from output.
   *.
   */
  format?: 'html' | 'markdown'
  id: string
  input: {
    context?: string
    files?: string[]
    folders?: string[]
  }
  /** Tokens consumed for the prompt across all curate sub-phases. */
  inputTokens?: number
  operations: CurateLogOperation[]
  /** Tokens emitted for the completion across all curate sub-phases. */
  outputTokens?: number
  startedAt: number
  summary: CurateLogSummary
  taskId: string
  /** Per-task latency breakdown. */
  timing?: CurateLogTiming
}

export type CurateLogEntry =
  | (CurateLogBase & {completedAt: number; error: string; status: 'error'})
  | (CurateLogBase & {completedAt: number; response?: string; status: 'completed'})
  | (CurateLogBase & {completedAt: number; status: 'cancelled'})
  | (CurateLogBase & {status: 'processing'})
