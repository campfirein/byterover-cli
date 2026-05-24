/**
 * Provider Module Types
 *
 * Defines the ProviderModule interface — the core abstraction for LLM providers.
 * Each provider is a self-contained module (data + factory) following opencode's pattern.
 */

import type {IContentGenerator} from '../../../core/interfaces/i-content-generator.js'

/**
 * Provider authentication type.
 */
export type ProviderAuthType = 'api-key' | 'internal'

/**
 * Internal provider type determines formatter/tokenizer selection.
 * - 'claude': Uses ClaudeMessageFormatter + ClaudeTokenizer
 * - 'gemini': Uses GeminiMessageFormatter + GeminiTokenizer
 * - 'openai': Uses OpenRouterMessageFormatter + OpenRouterTokenizer
 */
export type ProviderType = 'claude' | 'gemini' | 'openai'

/**
 * Configuration passed to provider generator factories.
 * Each provider uses the fields relevant to it.
 */
export interface GeneratorFactoryConfig {
  /** API key for key-based auth providers */
  readonly apiKey?: string
  /** API base URL (for OpenAI-compatible providers) */
  readonly baseUrl?: string
  /** Custom HTTP headers */
  readonly headers?: Record<string, string>
  /** ByteRover internal HTTP config (kept for backward compat) */
  readonly httpConfig?: Record<string, unknown>
  /** HTTP Referer header (for OpenRouter) */
  readonly httpReferer?: string
  /** Maximum tokens in the response */
  readonly maxTokens: number
  /** Model identifier */
  readonly model: string
  /**
   * Per-request abort timeout in ms for direct AI SDK providers.
   * Sourced from `llm.requestTimeoutMs`. Flows to AiSdkContentGenerator's
   * AbortSignal helper; ignored by ByteRover (which has its own
   * transport-layer timeout).
   */
  readonly requestTimeoutMs?: number
  /** Site name (for OpenRouter) */
  readonly siteName?: string
  /** Temperature for randomness */
  readonly temperature: number
  /** Request timeout in milliseconds (legacy: used only by the ByteRover transport-layer timeout) */
  readonly timeout?: number
}

/**
 * Self-contained provider module.
 *
 * Each provider exports a ProviderModule that contains all its metadata
 * and a factory function to create its IContentGenerator.
 * This follows opencode's pattern of providers as "data + factory".
 */
export interface ProviderModule {
  /** URL where users can get an API key */
  readonly apiKeyUrl?: string
  /** Provider authentication type */
  readonly authType: ProviderAuthType
  /** API base URL (for OpenAI-compatible providers) */
  readonly baseUrl?: string
  /** Category for grouping in UI */
  readonly category: 'other' | 'popular'
  /** Factory: create an IContentGenerator for this provider */
  createGenerator(config: GeneratorFactoryConfig): IContentGenerator
  /** Default model to use when first connected */
  readonly defaultModel: string
  /** Short description */
  readonly description: string
  /** Environment variable names for API key auto-detection */
  readonly envVars: readonly string[]
  /** Unique provider identifier */
  readonly id: string
  /** Display name */
  readonly name: string
  /** Priority for display order (lower = higher priority) */
  readonly priority: number

  /** Internal provider type — determines formatter/tokenizer selection */
  readonly providerType: ProviderType
}
