/**
 * Canonical LLM token usage record. Field names mirror the de facto
 * LLM-provider standard (Anthropic `input_tokens` / `cache_read_input_tokens` /
 * `cache_creation_input_tokens`). Persisted on `QueryLogEntry` and
 * `CurateLogEntry`; consumed by the brv-bench harness without renaming.
 */
export type LlmUsage = {
  /** Tokens written to cache on first call (Anthropic `cache_creation_input_tokens`). */
  cacheCreationTokens?: number
  /** Tokens read from prompt cache (Anthropic `cache_read_input_tokens`, Gemini `cachedContentTokenCount`). */
  cachedInputTokens?: number
  /** Tokens consumed for the prompt (Anthropic `input_tokens`, OpenAI `prompt_tokens`). */
  inputTokens: number
  /** Tokens emitted for the completion (Anthropic `output_tokens`, OpenAI `completion_tokens`). */
  outputTokens: number
}

/** Identity element for `addUsage`. */
export const ZERO_USAGE: LlmUsage = {inputTokens: 0, outputTokens: 0}

/**
 * Sum two LlmUsage records. Cache fields are present in the result iff at least
 * one operand has them — this keeps the on-disk shape minimal when no provider
 * in the rollup reported caching.
 */
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  const cacheCreationTokens =
    a.cacheCreationTokens === undefined && b.cacheCreationTokens === undefined
      ? undefined
      : (a.cacheCreationTokens ?? 0) + (b.cacheCreationTokens ?? 0)
  const cachedInputTokens =
    a.cachedInputTokens === undefined && b.cachedInputTokens === undefined
      ? undefined
      : (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0)

  return {
    ...(cacheCreationTokens !== undefined && {cacheCreationTokens}),
    ...(cachedInputTokens !== undefined && {cachedInputTokens}),
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  }
}
