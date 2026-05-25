import type {LlmUsage} from '../../../server/core/domain/entities/llm-usage.js'

/**
 * Discriminator for {@link extractUsage}. Each provider's response shape uses
 * different field names; per-provider mapping is the most likely bug surface
 * for token-extraction.
 */
export type ProviderType = 'aiSdk' | 'anthropic' | 'google' | 'openai'

/**
 * Pure function: convert a provider's raw `usage` payload into the canonical
 * {@link LlmUsage} shape. Returns `undefined` when the raw
 * payload does not carry both `inputTokens` and `outputTokens` numerically —
 * partial / malformed payloads are treated as absent rather than coerced.
 */
export function extractUsage(rawUsage: unknown, providerType: ProviderType): LlmUsage | undefined {
  if (!isObject(rawUsage)) return undefined

  switch (providerType) {
    case 'aiSdk': {
      const inputTokens = asNumber(rawUsage.inputTokens)
      const outputTokens = asNumber(rawUsage.outputTokens)
      if (inputTokens === undefined || outputTokens === undefined) return undefined
      return buildUsage({
        cacheCreationTokens: asNumber(rawUsage.cacheCreationTokens),
        cachedInputTokens: asNumber(rawUsage.cachedInputTokens),
        inputTokens,
        outputTokens,
      })
    }

    case 'anthropic': {
      const inputTokens = asNumber(rawUsage.input_tokens)
      const outputTokens = asNumber(rawUsage.output_tokens)
      if (inputTokens === undefined || outputTokens === undefined) return undefined
      return buildUsage({
        cacheCreationTokens: asNumber(rawUsage.cache_creation_input_tokens),
        cachedInputTokens: asNumber(rawUsage.cache_read_input_tokens),
        inputTokens,
        outputTokens,
      })
    }

    case 'google': {
      const inputTokens = asNumber(rawUsage.promptTokenCount)
      const outputTokens = asNumber(rawUsage.candidatesTokenCount)
      if (inputTokens === undefined || outputTokens === undefined) return undefined
      return buildUsage({
        cachedInputTokens: asNumber(rawUsage.cachedContentTokenCount),
        inputTokens,
        outputTokens,
      })
    }

    case 'openai': {
      const inputTokens = asNumber(rawUsage.prompt_tokens)
      const outputTokens = asNumber(rawUsage.completion_tokens)
      if (inputTokens === undefined || outputTokens === undefined) return undefined
      const details = rawUsage.prompt_tokens_details
      const cachedInputTokens = isObject(details) ? asNumber(details.cached_tokens) : undefined
      return buildUsage({cachedInputTokens, inputTokens, outputTokens})
    }
  }
}

type UsageParts = {
  cacheCreationTokens?: number
  cachedInputTokens?: number
  inputTokens: number
  outputTokens: number
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function buildUsage(parts: UsageParts): LlmUsage {
  return {
    ...(parts.cacheCreationTokens !== undefined && {cacheCreationTokens: parts.cacheCreationTokens}),
    ...(parts.cachedInputTokens !== undefined && {cachedInputTokens: parts.cachedInputTokens}),
    inputTokens: parts.inputTokens,
    outputTokens: parts.outputTokens,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}
