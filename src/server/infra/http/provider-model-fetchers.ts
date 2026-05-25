/**
 * Provider Model Fetcher Implementations
 *
 * Implements IProviderModelFetcher for each supported LLM provider:
 * - AnthropicModelFetcher: Uses @anthropic-ai/sdk
 * - OpenAIModelFetcher: Uses openai SDK
 * - GoogleModelFetcher: Uses @google/genai SDK
 * - OpenAICompatibleModelFetcher: Generic for xAI/Groq/Mistral (REST API)
 * - OpenRouterModelFetcher: Wraps existing OpenRouterApiClient
 */

import {createAnthropic} from '@ai-sdk/anthropic'
import {createOpenAI} from '@ai-sdk/openai'
import Anthropic from '@anthropic-ai/sdk'
import {GoogleGenAI} from '@google/genai'
import {APICallError, generateText} from 'ai'
import axios, {isAxiosError} from 'axios'
import OpenAI from 'openai'

import type {
  FetchModelsOptions,
  IProviderModelFetcher,
  ProviderModelInfo,
} from '../../core/interfaces/i-provider-model-fetcher.js'

import {getModelsDevClient as getModelsDevClientDefault, type ModelsDevClient} from './models-dev-client.js'
import {ProxyConfig} from './proxy-config.js'

// ============================================================================
// Cache helper
// ============================================================================

interface ModelCache {
  models: ProviderModelInfo[]
  timestamp: number
}

const DEFAULT_CACHE_TTL = 60 * 60 * 1000 // 1 hour

// ============================================================================
// Anthropic Model Fetcher
// ============================================================================

/**
 * Known Anthropic model pricing (per million tokens, USD).
 * Anthropic API doesn't expose pricing, so we maintain a static lookup.
 * Falls back to pattern-based matching for unlisted models.
 */
interface AnthropicModelMeta {
  contextLength: number
  inputPerM: number
  outputPerM: number
}

const ANTHROPIC_KNOWN_MODELS: Readonly<Record<string, AnthropicModelMeta>> = {
  'claude-3-5-haiku-20241022': {contextLength: 200_000, inputPerM: 0.8, outputPerM: 4},
  'claude-3-5-sonnet-20240620': {contextLength: 200_000, inputPerM: 3, outputPerM: 15},
  'claude-3-5-sonnet-20241022': {contextLength: 200_000, inputPerM: 3, outputPerM: 15},
  'claude-3-haiku-20240307': {contextLength: 200_000, inputPerM: 0.25, outputPerM: 1.25},
  'claude-3-opus-20240229': {contextLength: 200_000, inputPerM: 15, outputPerM: 75},
  'claude-3-sonnet-20240229': {contextLength: 200_000, inputPerM: 3, outputPerM: 15},
  'claude-haiku-4-5-20251001': {contextLength: 200_000, inputPerM: 1, outputPerM: 5},
  'claude-opus-4-5-20251101': {contextLength: 200_000, inputPerM: 5, outputPerM: 25},
  'claude-opus-4-6': {contextLength: 200_000, inputPerM: 5, outputPerM: 25},
  'claude-sonnet-4-5-20250929': {contextLength: 200_000, inputPerM: 3, outputPerM: 15},
}

/**
 * Get pricing and context length for an Anthropic model.
 * Checks exact match first, then falls back to tier-based pattern matching.
 */
function getAnthropicModelMeta(modelId: string): AnthropicModelMeta {
  // Exact match
  const known = ANTHROPIC_KNOWN_MODELS[modelId]
  if (known) return known

  // Pattern-based fallback by model tier
  const id = modelId.toLowerCase()
  if (id.includes('opus')) {
    return {contextLength: 200_000, inputPerM: 15, outputPerM: 75}
  }

  if (id.includes('sonnet')) {
    return {contextLength: 200_000, inputPerM: 3, outputPerM: 15}
  }

  if (id.includes('haiku')) {
    return {contextLength: 200_000, inputPerM: 1, outputPerM: 5}
  }

  // Unknown model tier
  return {contextLength: 200_000, inputPerM: 0, outputPerM: 0}
}

/**
 * Fetches models from Anthropic using the official SDK.
 */
export class AnthropicModelFetcher implements IProviderModelFetcher {
  private cache: ModelCache | undefined
  private readonly cacheTtlMs: number

  constructor(cacheTtlMs = DEFAULT_CACHE_TTL) {
    this.cacheTtlMs = cacheTtlMs
  }

  async fetchModels(apiKey: string, options?: FetchModelsOptions): Promise<ProviderModelInfo[]> {
    const forceRefresh = options?.forceRefresh ?? false
    if (!forceRefresh && this.cache && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.models
    }

    const client = new Anthropic({apiKey})
    const models: ProviderModelInfo[] = []

    // Anthropic models.list() returns a paginated list
    for await (const model of client.models.list()) {
      const meta = getAnthropicModelMeta(model.id)
      models.push({
        contextLength: meta.contextLength,
        description: model.display_name,
        id: model.id,
        isFree: false,
        name: model.display_name,
        pricing: {inputPerM: meta.inputPerM, outputPerM: meta.outputPerM},
        provider: 'Anthropic',
      })
    }

    this.cache = {models, timestamp: Date.now()}
    return models
  }

  async validateApiKey(apiKey: string): Promise<{error?: string; isValid: boolean}> {
    try {
      const provider = createAnthropic({apiKey})
      await generateText({
        maxOutputTokens: 1,
        maxRetries: 0,
        messages: [{content: 'hi', role: 'user'}],
        model: provider('claude-haiku-4-5-20251001'),
      })

      return {isValid: true}
    } catch (error: unknown) {
      return handleAiSdkValidationError(error)
    }
  }
}

// ============================================================================
// OpenAI Model Fetcher
// ============================================================================

/**
 * Strict allowlist of model IDs permitted for OAuth-connected OpenAI (Codex).
 * Only models verified to work with the ChatGPT Codex endpoint are included.
 *
 * NOT supported (Bad Request on chatgpt.com/backend-api/codex):
 * - codex-mini-latest: standard API model, not a Codex endpoint model
 * - o4-mini: reasoning model, not supported by the Codex endpoint
 * - gpt-5.3-codex-spark: reported unsupported (GitHub openai/codex#13469)
 */
export const CODEX_ALLOWED_MODELS = new Set([
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2',
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.4-mini',
])

/**
 * Fallback Codex models used when models.dev is unreachable and no disk cache exists.
 */
export const CODEX_FALLBACK_MODELS: readonly ProviderModelInfo[] = [
  {
    contextLength: 400_000,
    id: 'gpt-5.3-codex',
    isFree: false,
    name: 'GPT-5.3 Codex',
    pricing: {inputPerM: 0, outputPerM: 0},
    provider: 'OpenAI',
  },
  {
    contextLength: 200_000,
    id: 'gpt-5.1-codex-mini',
    isFree: false,
    name: 'GPT-5.1 Codex Mini',
    pricing: {inputPerM: 0, outputPerM: 0},
    provider: 'OpenAI',
  },
]

/**
 * Fetches models from OpenAI using the official SDK.
 * For OAuth-connected providers, fetches from models.dev and filters to Codex-allowed models.
 */
export class OpenAIModelFetcher implements IProviderModelFetcher {
  private cache: ModelCache | undefined
  private readonly cacheTtlMs: number
  private readonly getModelsDevClient: () => ModelsDevClient

  constructor(options?: {cacheTtlMs?: number; modelsDevClient?: ModelsDevClient}) {
    this.cacheTtlMs = options?.cacheTtlMs ?? DEFAULT_CACHE_TTL
    const injectedClient = options?.modelsDevClient
    this.getModelsDevClient = injectedClient ? () => injectedClient : () => getModelsDevClientDefault()
  }

  async fetchModels(apiKey: string, options?: FetchModelsOptions): Promise<ProviderModelInfo[]> {
    // OAuth-connected OpenAI: fetch from models.dev, filter to Codex models
    if (options?.authMethod === 'oauth') {
      return this.fetchCodexModels(options.forceRefresh ?? false)
    }

    const forceRefresh = options?.forceRefresh ?? false
    if (!forceRefresh && this.cache && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.models
    }

    const client = new OpenAI({apiKey})
    const models: ProviderModelInfo[] = []

    // Fetch all models and filter for chat-capable ones
    for await (const model of client.models.list()) {
      // Filter: only include GPT, O-series, and chat models
      const id = model.id.toLowerCase()
      if (
        id.startsWith('gpt-') ||
        id.startsWith('o1') ||
        id.startsWith('o3') ||
        id.startsWith('o4') ||
        id.startsWith('chatgpt')
      ) {
        const pricing = this.estimatePricing(model.id)
        models.push({
          contextLength: this.estimateContextLength(model.id),
          id: model.id,
          isFree: false,
          name: model.id,
          pricing,
          provider: 'OpenAI',
        })
      }
    }

    // Sort by ID for consistent ordering
    models.sort((a, b) => a.id.localeCompare(b.id))

    this.cache = {models, timestamp: Date.now()}
    return models
  }

  async validateApiKey(apiKey: string): Promise<{error?: string; isValid: boolean}> {
    try {
      const provider = createOpenAI({apiKey})
      await generateText({
        maxOutputTokens: 1,
        maxRetries: 0,
        messages: [{content: 'hi', role: 'user'}],
        model: provider.responses('gpt-4o-mini'),
      })

      return {isValid: true}
    } catch (error: unknown) {
      return handleAiSdkValidationError(error)
    }
  }

  private estimateContextLength(modelId: string): number {
    const id = modelId.toLowerCase()
    if (id.includes('gpt-4.1')) return 1_047_576
    if (id.includes('gpt-4o')) return 128_000
    if (id.includes('gpt-4-turbo')) return 128_000
    if (id.includes('gpt-4')) return 8192
    if (id.includes('o1') || id.includes('o3') || id.includes('o4')) return 200_000

    return 128_000
  }

  private estimatePricing(modelId: string): {inputPerM: number; outputPerM: number} {
    const id = modelId.toLowerCase()
    if (id.includes('gpt-4.1-mini')) return {inputPerM: 0.4, outputPerM: 1.6}
    if (id.includes('gpt-4.1-nano')) return {inputPerM: 0.1, outputPerM: 0.4}
    if (id.includes('gpt-4.1')) return {inputPerM: 2, outputPerM: 8}
    if (id.includes('gpt-4o-mini')) return {inputPerM: 0.15, outputPerM: 0.6}
    if (id.includes('gpt-4o')) return {inputPerM: 2.5, outputPerM: 10}
    if (id.includes('gpt-4-turbo')) return {inputPerM: 10, outputPerM: 30}
    if (id.includes('gpt-4')) return {inputPerM: 30, outputPerM: 60}
    if (id.includes('o4-mini')) return {inputPerM: 1.1, outputPerM: 4.4}
    if (id.includes('o3-mini')) return {inputPerM: 1.1, outputPerM: 4.4}
    if (id.includes('o3')) return {inputPerM: 10, outputPerM: 40}
    if (id.includes('o1-mini')) return {inputPerM: 3, outputPerM: 12}
    if (id.includes('o1')) return {inputPerM: 15, outputPerM: 60}

    return {inputPerM: 0, outputPerM: 0}
  }

  /**
   * Fetch Codex models from models.dev, filtered by allowlist.
   * Falls back to CODEX_FALLBACK_MODELS if models.dev is unavailable.
   */
  private async fetchCodexModels(forceRefresh?: boolean): Promise<ProviderModelInfo[]> {
    const client = this.getModelsDevClient()
    const allModels = await client.getModelsForProvider('openai', forceRefresh)

    if (allModels.length === 0) {
      return [...CODEX_FALLBACK_MODELS]
    }

    // Strict allowlist only — dynamic "codex in name" matching is too broad
    // (e.g. codex-mini-latest, gpt-5.3-codex-spark cause Bad Request)
    const codexModels = allModels.filter((m) => CODEX_ALLOWED_MODELS.has(m.id))

    if (codexModels.length === 0) {
      return [...CODEX_FALLBACK_MODELS]
    }

    // Zero out costs (included in ChatGPT subscription)
    return codexModels.map((m) => ({
      ...m,
      isFree: false,
      pricing: {inputPerM: 0, outputPerM: 0},
    }))
  }
}

// ============================================================================
// Google Model Fetcher
// ============================================================================

/**
 * Fetches models from Google using the @google/genai SDK.
 */
export class GoogleModelFetcher implements IProviderModelFetcher {
  private cache: ModelCache | undefined
  private readonly cacheTtlMs: number

  constructor(cacheTtlMs = DEFAULT_CACHE_TTL) {
    this.cacheTtlMs = cacheTtlMs
  }

  async fetchModels(apiKey: string, options?: FetchModelsOptions): Promise<ProviderModelInfo[]> {
    const forceRefresh = options?.forceRefresh ?? false
    if (!forceRefresh && this.cache && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.models
    }

    const client = new GoogleGenAI({apiKey})
    const models: ProviderModelInfo[] = []

    // Google GenAI SDK list models
    const pager = await client.models.list()
    for (const model of pager.page) {
      // Filter for generateContent-capable models (chat/completion models)
      if (!model.supportedActions?.includes('generateContent')) continue

      const id = model.name?.replace('models/', '') ?? ''
      models.push({
        contextLength: model.inputTokenLimit ?? 1_000_000,
        description: model.description ?? undefined,
        id,
        isFree: false,
        name: model.displayName ?? id,
        pricing: {inputPerM: 0, outputPerM: 0}, // Google doesn't expose pricing via API
        provider: 'Google',
      })
    }

    this.cache = {models, timestamp: Date.now()}
    return models
  }

  async validateApiKey(apiKey: string): Promise<{error?: string; isValid: boolean}> {
    try {
      const client = new GoogleGenAI({apiKey})
      await client.models.list()
      return {isValid: true}
    } catch (error: unknown) {
      return handleSdkValidationError(error)
    }
  }
}

// ============================================================================
// OpenAI-Compatible Model Fetcher (xAI, Groq, Mistral)
// ============================================================================

/**
 * Generic model fetcher for OpenAI-compatible APIs.
 * Works with xAI (Grok), Groq, and Mistral.
 */
export class OpenAICompatibleModelFetcher implements IProviderModelFetcher {
  private readonly baseUrl: string
  private cache: ModelCache | undefined
  private readonly cacheTtlMs: number
  private readonly providerName: string

  constructor(baseUrl: string, providerName: string, cacheTtlMs = DEFAULT_CACHE_TTL) {
    this.baseUrl = baseUrl
    this.providerName = providerName
    this.cacheTtlMs = cacheTtlMs
  }

  async fetchModels(apiKey: string, options?: FetchModelsOptions): Promise<ProviderModelInfo[]> {
    const forceRefresh = options?.forceRefresh ?? false
    if (!forceRefresh && this.cache && Date.now() - this.cache.timestamp < this.cacheTtlMs) {
      return this.cache.models
    }

    const response = await axios.get(`${this.baseUrl}/models`, {
      headers: {Authorization: `Bearer ${apiKey}`},
      httpAgent: ProxyConfig.getProxyAgent(),
      httpsAgent: ProxyConfig.getProxyAgent(),
      proxy: false,
      timeout: 30_000,
    })

    // Handle different response formats:
    // - OpenAI/DeepInfra: {data: [{id, ...}, ...]}
    // - Together AI: [{id, ...}, ...] (top-level array)
    // - Cohere: {models: [{name, ...}, ...]}
    const responseData = response.data
    const modelList: Array<Record<string, unknown>> = Array.isArray(responseData)
      ? responseData
      : (responseData.data ?? responseData.models ?? [])

    const uniqueModels = new Map<string, ProviderModelInfo>()
    for (const model of modelList) {
      const id = String(model.id ?? model.name ?? '')
      if (!id) continue
      if (uniqueModels.has(id)) continue
      uniqueModels.set(id, {
        contextLength: typeof model.context_length === 'number' ? model.context_length : 128_000,
        id,
        isFree: false,
        name: id,
        pricing: {inputPerM: 0, outputPerM: 0},
        provider: this.providerName,
      })
    }

    const models: ProviderModelInfo[] = [...uniqueModels.values()]

    // Sort by ID
    models.sort((a, b) => a.id.localeCompare(b.id))

    this.cache = {models, timestamp: Date.now()}
    return models
  }

  async validateApiKey(apiKey: string): Promise<{error?: string; isValid: boolean}> {
    try {
      await axios.get(`${this.baseUrl}/models`, {
        headers: {Authorization: `Bearer ${apiKey}`},
        httpAgent: ProxyConfig.getProxyAgent(),
        httpsAgent: ProxyConfig.getProxyAgent(),
        proxy: false,
        timeout: 15_000,
      })
      return {isValid: true}
    } catch (error) {
      if (isAxiosError(error)) {
        if (error.response?.status === 401) {
          return {error: 'Invalid API key', isValid: false}
        }

        if (error.response?.status === 403) {
          return {error: 'API key does not have required permissions', isValid: false}
        }

        return {error: `API error: ${error.response?.statusText ?? error.message}`, isValid: false}
      }

      return {error: error instanceof Error ? error.message : 'Unknown error', isValid: false}
    }
  }
}

// ============================================================================
// Chat-based Model Fetcher (Perplexity, Vercel, etc.)
// ============================================================================

/* eslint-disable camelcase */
/**
 * Model fetcher for providers that lack a /models endpoint.
 * Validates API keys by making a minimal chat completion request.
 * Model listing returns a static list of known models.
 */
export class ChatBasedModelFetcher implements IProviderModelFetcher {
  private readonly baseUrl: string
  private readonly knownModels: ProviderModelInfo[]

  constructor(baseUrl: string, providerName: string, knownModels: string[]) {
    this.baseUrl = baseUrl
    this.knownModels = knownModels.map((id) => ({
      contextLength: 128_000,
      id,
      isFree: false,
      name: id,
      pricing: {inputPerM: 0, outputPerM: 0},
      provider: providerName,
    }))
  }

  async fetchModels(_apiKey: string, _options?: FetchModelsOptions): Promise<ProviderModelInfo[]> {
    return this.knownModels
  }

  async validateApiKey(apiKey: string): Promise<{error?: string; isValid: boolean}> {
    // Iterate through known models so a single missing model on a tier (e.g.
    // GLM Coding Plan doesn't yet serve the latest glm-4.7) doesn't
    // misclassify a valid key as invalid. We accept the key as soon as ANY
    // model responds successfully, OR returns a non-auth error like 429/5xx
    // (which still proves the key passed auth).
    const candidates = this.knownModels.length > 0 ? this.knownModels : [{id: 'default'}]
    let lastNonAuthError: unknown

    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await axios.post(
          `${this.baseUrl}/chat/completions`,
          {
            max_tokens: 1,
            messages: [{content: 'hi', role: 'user'}],
            model: candidate.id,
          },
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            httpAgent: ProxyConfig.getProxyAgent(),
            httpsAgent: ProxyConfig.getProxyAgent(),
            proxy: false,
            timeout: 15_000,
          },
        )

        return {isValid: true}
      } catch (error) {
        if (isAxiosError(error)) {
          if (error.response?.status === 401) {
            return {error: 'Invalid API key', isValid: false}
          }

          if (error.response?.status === 403) {
            return {error: 'API key does not have required permissions', isValid: false}
          }

          // 400/404 may mean "model not available on this tier" — try next.
          if (error.response?.status === 400 || error.response?.status === 404) {
            lastNonAuthError = error
            continue
          }

          // Axios errors that are not 401/403/400/404 (e.g. 429, 5xx, or
          // network-level errors with no response like ECONNREFUSED) are
          // treated as "key accepted" — either auth was passed (429/5xx) or
          // we can't determine otherwise (no response). Optimistic: prefer a
          // false-positive valid over a false-negative invalid.
          return {isValid: true}
        }

        lastNonAuthError = error
      }
    }

    // Every candidate model returned 400/404 or a non-axios error and none
    // gave us a positive auth signal. Treat the key as inconclusive — but
    // since 401/403 was never observed, surface the last error so the user
    // can see the real cause (often a model-availability issue, not auth).
    return {
      error: lastNonAuthError instanceof Error ? lastNonAuthError.message : 'Validation failed for all known models',
      isValid: false,
    }
  }
}

// ============================================================================
// OpenRouter Model Fetcher (wraps existing client)
// ============================================================================

import {getOpenRouterApiClient, type NormalizedModel} from './openrouter-api-client.js'

/**
 * Model fetcher that wraps the existing OpenRouterApiClient.
 * Adapts NormalizedModel to ProviderModelInfo.
 */
export class OpenRouterModelFetcher implements IProviderModelFetcher {
  async fetchModels(apiKey: string, options?: FetchModelsOptions): Promise<ProviderModelInfo[]> {
    const client = getOpenRouterApiClient()
    const models = await client.fetchModels(apiKey, options?.forceRefresh ?? false)
    return models.map((m: NormalizedModel) => ({
      contextLength: m.contextLength,
      description: m.description,
      id: m.id,
      isFree: m.isFree,
      name: m.name,
      pricing: m.pricing,
      provider: m.provider,
    }))
  }

  async validateApiKey(apiKey: string): Promise<{error?: string; isValid: boolean}> {
    const client = getOpenRouterApiClient()
    return client.validateApiKey(apiKey)
  }
}

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Handle AI SDK validation errors.
 * Uses APICallError.statusCode for reliable HTTP status-based detection
 * instead of fragile string matching on error messages.
 *
 * Only 401/403 mean the key is invalid. Other HTTP errors (429 rate limit,
 * 404 model not found, 500 server error) indicate the key was accepted
 * but the test request failed for another reason — key is valid.
 */
function handleAiSdkValidationError(error: unknown): {error?: string; isValid: boolean} {
  // AI SDK throws APICallError with statusCode for HTTP-level errors
  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401) {
      return {error: 'Invalid API key', isValid: false}
    }

    if (error.statusCode === 403) {
      return {error: 'API key does not have required permissions', isValid: false}
    }

    // 429, 404, 500, etc. — key authenticated fine, request failed for other reasons
    return {isValid: true}
  }

  // Non-API errors (network, timeout, etc.) — can't determine key validity
  if (error instanceof Error) {
    return {error: error.message, isValid: false}
  }

  return {error: 'Unknown error', isValid: false}
}

/**
 * Handle SDK validation errors consistently across providers.
 */
function handleSdkValidationError(error: unknown): {error: string; isValid: boolean} {
  if (error instanceof Error) {
    const message = error.message.toLowerCase()
    if (
      message.includes('401') ||
      message.includes('unauthorized') ||
      message.includes('invalid api key') ||
      message.includes('authentication')
    ) {
      return {error: `Authentication failed: ${error.message}`, isValid: false}
    }

    if (message.includes('403') || message.includes('forbidden') || message.includes('permission')) {
      return {error: `Permission denied: ${error.message}`, isValid: false}
    }

    return {error: error.message, isValid: false}
  }

  return {error: 'Unknown error', isValid: false}
}
