/**
 * LLM Model Registry - Single Source of Truth for Model Metadata.
 *
 * This registry provides centralized model information including:
 * - Context window sizes (maxInputTokens)
 * - Character-per-token ratios for estimation
 * - Supported file types for multimodal input
 * - Model capabilities
 *
 * Following patterns from Dexto's LLM registry.
 */

import {
  type LLMProvider,
  type ModelCapabilities,
  type ModelInfo,
  PROVIDER_TYPES,
  type ProviderInfo,
  type SupportedFileType,
} from './types.js'

/** Default fallback for unknown models */
export const DEFAULT_MAX_INPUT_TOKENS = 128_000
export const DEFAULT_CHARS_PER_TOKEN = 4

/**
 * LLM Model Registry
 *
 * IMPORTANT: supportedFileTypes is the SINGLE SOURCE OF TRUTH for file upload capabilities:
 * - Empty array [] = Model does NOT support file uploads
 * - Specific types ['image', 'pdf'] = Model supports ONLY those file types
 */
export const LLM_REGISTRY: Record<LLMProvider, ProviderInfo> = {
  claude: {
    defaultModel: '',
    models: [
      // Claude 4.x series
      {
        capabilities: {
          acceptsSamplingParameters: false,
          supportsAudio: false,
          supportsImages: true,
          supportsPdf: true,
          supportsStreaming: true,
        },
        charsPerToken: 3.5,
        displayName: 'Claude Opus 4.7',
        maxInputTokens: 200_000,
        maxOutputTokens: 128_000,
        name: 'claude-opus-4-7',
        supportedFileTypes: ['image', 'pdf'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude Opus 4.6',
        maxInputTokens: 200_000,
        maxOutputTokens: 128_000,
        name: 'claude-opus-4-6',
        supportedFileTypes: ['image', 'pdf'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude Sonnet 4.6',
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        name: 'claude-sonnet-4-6',
        supportedFileTypes: ['image', 'pdf'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude Haiku 4.5',
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        name: 'claude-haiku-4-5-20251001',
        supportedFileTypes: ['image', 'pdf'],
      },
      // Claude 3.5 series
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude 3.5 Sonnet (Oct 2024)',
        maxInputTokens: 200_000,
        maxOutputTokens: 8192,
        name: 'claude-3-5-sonnet-20241022',
        supportedFileTypes: ['image', 'pdf'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude 3.5 Sonnet (Jun 2024)',
        maxInputTokens: 200_000,
        maxOutputTokens: 8192,
        name: 'claude-3-5-sonnet-20240620',
        supportedFileTypes: ['image', 'pdf'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude 3.5 Haiku',
        maxInputTokens: 200_000,
        maxOutputTokens: 8192,
        name: 'claude-3-5-haiku-20241022',
        supportedFileTypes: ['image', 'pdf'],
      },
      // Claude 3 series
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude 3 Opus',
        maxInputTokens: 200_000,
        maxOutputTokens: 4096,
        name: 'claude-3-opus-20240229',
        supportedFileTypes: ['image', 'pdf'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude 3 Sonnet',
        maxInputTokens: 200_000,
        maxOutputTokens: 4096,
        name: 'claude-3-sonnet-20240229',
        supportedFileTypes: ['image', 'pdf'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: true, supportsStreaming: true},
        charsPerToken: 3.5,
        displayName: 'Claude 3 Haiku',
        maxInputTokens: 200_000,
        maxOutputTokens: 4096,
        name: 'claude-3-haiku-20240307',
        supportedFileTypes: ['image', 'pdf'],
      },
    ],
    supportedFileTypes: ['image', 'pdf'],
  },
  gemini: {
    defaultModel: 'gemini-3-flash-preview',
    models: [
      // Gemini 3.1 series
      {
        capabilities: {
          supportsAudio: true,
          supportsImages: true,
          supportsMultimodalFunctionResponse: true,
          supportsPdf: true,
          supportsStreaming: true,
          supportsThinking: true,
        },
        charsPerToken: 4,
        displayName: 'Gemini 3.1 Flash Lite',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 8192,
        name: 'gemini-3.1-flash-lite-preview',
        pricing: {inputPerM: 0.075, outputPerM: 0.3},
        supportedFileTypes: ['image', 'pdf', 'audio'],
      },
      // Gemini 3 series (Preview)
      {
        capabilities: {
          supportsAudio: true,
          supportsImages: true,
          supportsMultimodalFunctionResponse: true,
          supportsPdf: true,
          supportsStreaming: true,
          supportsThinking: true,
        },
        charsPerToken: 4,
        default: true,
        displayName: 'Gemini 3 Flash (Preview)',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 8192,
        name: 'gemini-3-flash-preview',
        pricing: {inputPerM: 0.075, outputPerM: 0.3},
        supportedFileTypes: ['image', 'pdf', 'audio'],
      },
      {
        capabilities: {
          supportsAudio: true,
          supportsImages: true,
          supportsMultimodalFunctionResponse: true,
          supportsPdf: true,
          supportsStreaming: true,
          supportsThinking: true,
        },
        charsPerToken: 4,
        displayName: 'Gemini 3 Pro (Preview)',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 8192,
        name: 'gemini-3-pro-preview',
        pricing: {inputPerM: 1.25, outputPerM: 5},
        supportedFileTypes: ['image', 'pdf', 'audio'],
      },
      // Gemini 2.5 series
      {
        capabilities: {
          supportsAudio: true,
          supportsImages: true,
          supportsPdf: true,
          supportsStreaming: true,
          supportsThinking: true,
        },
        charsPerToken: 4,
        displayName: 'Gemini 2.5 Flash',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 8192,
        name: 'gemini-2.5-flash',
        pricing: {inputPerM: 0.075, outputPerM: 0.3},
        supportedFileTypes: ['image', 'pdf', 'audio'],
      },
      {
        capabilities: {
          supportsAudio: true,
          supportsImages: true,
          supportsPdf: true,
          supportsStreaming: true,
          supportsThinking: true,
        },
        charsPerToken: 4,
        displayName: 'Gemini 2.5 Pro',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 8192,
        name: 'gemini-2.5-pro',
        pricing: {inputPerM: 1.25, outputPerM: 5},
        supportedFileTypes: ['image', 'pdf', 'audio'],
      },
      // Gemini 1.5 series
      {
        capabilities: {
          supportsAudio: true,
          supportsImages: true,
          supportsPdf: true,
          supportsStreaming: true,
          supportsThinking: false,
        },
        charsPerToken: 4,
        displayName: 'Gemini 1.5 Pro',
        maxInputTokens: 2_000_000,
        maxOutputTokens: 8192,
        name: 'gemini-1.5-pro',
        pricing: {inputPerM: 1.25, outputPerM: 5},
        supportedFileTypes: ['image', 'pdf', 'audio'],
      },
    ],
    supportedFileTypes: ['image', 'pdf', 'audio'],
  },

  openai: {
    defaultModel: '',
    models: [
      // GPT-4.1 series (1M+ context)
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-4.1',
        maxInputTokens: 1_047_576,
        maxOutputTokens: 32_768,
        name: 'gpt-4.1',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-4.1 Mini',
        maxInputTokens: 1_047_576,
        maxOutputTokens: 32_768,
        name: 'gpt-4.1-mini',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-4.1 Nano',
        maxInputTokens: 1_047_576,
        maxOutputTokens: 32_768,
        name: 'gpt-4.1-nano',
        supportedFileTypes: ['image'],
      },
      // GPT-4o series
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-4o',
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        name: 'gpt-4o',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-4o Mini',
        maxInputTokens: 128_000,
        maxOutputTokens: 16_384,
        name: 'gpt-4o-mini',
        supportedFileTypes: ['image'],
      },
      // GPT-4 Turbo
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-4 Turbo',
        maxInputTokens: 128_000,
        maxOutputTokens: 4096,
        name: 'gpt-4-turbo',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-4 Turbo Preview',
        maxInputTokens: 128_000,
        maxOutputTokens: 4096,
        name: 'gpt-4-turbo-preview',
        supportedFileTypes: ['image'],
      },
      // GPT-5 series (400K context)
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5 Mini',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5-mini',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5 Nano',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5-nano',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5 Codex',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5-codex',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5 Pro',
        maxInputTokens: 400_000,
        maxOutputTokens: 272_000,
        name: 'gpt-5-pro',
        supportedFileTypes: ['image'],
      },
      // GPT-5.1 series
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.1',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.1',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.1 Codex',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.1-codex',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.1 Codex Mini',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.1-codex-mini',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.1 Codex Max',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.1-codex-max',
        supportedFileTypes: ['image'],
      },
      // GPT-5.2 series
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.2',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.2',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.2 Pro',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.2-pro',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.2 Codex',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.2-codex',
        supportedFileTypes: ['image'],
      },
      // GPT-5.3 series
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'GPT-5.3 Codex',
        maxInputTokens: 400_000,
        maxOutputTokens: 128_000,
        name: 'gpt-5.3-codex',
        supportedFileTypes: ['image'],
      },
      // o1 series (200K context)
      {
        capabilities: {supportsAudio: false, supportsImages: false, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'o1',
        maxInputTokens: 200_000,
        maxOutputTokens: 100_000,
        name: 'o1',
        supportedFileTypes: [],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: false, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'o1 Mini',
        maxInputTokens: 128_000,
        maxOutputTokens: 65_536,
        name: 'o1-mini',
        supportedFileTypes: [],
      },
      // o3 series (200K context)
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'o3',
        maxInputTokens: 200_000,
        maxOutputTokens: 100_000,
        name: 'o3',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: false},
        charsPerToken: 4,
        displayName: 'o3 Pro',
        maxInputTokens: 200_000,
        maxOutputTokens: 100_000,
        name: 'o3-pro',
        supportedFileTypes: ['image'],
      },
      {
        capabilities: {supportsAudio: false, supportsImages: false, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'o3 Mini',
        maxInputTokens: 200_000,
        maxOutputTokens: 100_000,
        name: 'o3-mini',
        supportedFileTypes: [],
      },
      // o4 series (200K context)
      {
        capabilities: {supportsAudio: false, supportsImages: true, supportsPdf: false, supportsStreaming: true},
        charsPerToken: 4,
        displayName: 'o4 Mini',
        maxInputTokens: 200_000,
        maxOutputTokens: 100_000,
        name: 'o4-mini',
        supportedFileTypes: ['image'],
      },
    ],
    supportedFileTypes: ['image'],
  },
}

// ============================================================================
// Registry Helper Functions
// ============================================================================

/**
 * Get model information from the registry.
 * @param provider - LLM provider
 * @param model - Model name
 * @returns ModelInfo or undefined if not found
 */
export function getModelInfo(provider: LLMProvider, model: string): ModelInfo | undefined {
  const providerInfo = LLM_REGISTRY[provider]
  if (!providerInfo) return undefined
  return providerInfo.models.find((m) => m.name === model)
}

/**
 * Get model info with fallback for unknown models.
 * @param provider - LLM provider
 * @param model - Model name
 * @returns ModelInfo (falls back to default values for unknown models)
 */
export function getModelInfoWithFallback(provider: LLMProvider, model: string): ModelInfo {
  const info = getModelInfo(provider, model)
  if (info) return info

  // Fallback for unknown models
  const providerInfo = LLM_REGISTRY[provider]
  return {
    capabilities: {
      supportsAudio: false,
      supportsImages: true, // Assume basic image support
      supportsPdf: provider === 'claude' || provider === 'gemini',
      supportsStreaming: true,
    },
    charsPerToken: DEFAULT_CHARS_PER_TOKEN,
    displayName: model,
    maxInputTokens: DEFAULT_MAX_INPUT_TOKENS,
    name: model,
    supportedFileTypes: providerInfo?.supportedFileTypes ?? [],
  }
}

/**
 * Get characters per token ratio for a model.
 * @param provider - LLM provider
 * @param model - Model name
 * @returns Characters per token ratio
 */
export function getCharsPerToken(provider: LLMProvider, model: string): number {
  const info = getModelInfo(provider, model)
  return info?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN
}

/**
 * Get maximum input tokens for a model.
 * @param provider - LLM provider
 * @param model - Model name
 * @returns Maximum input tokens
 */
export function getMaxInputTokensForModel(provider: LLMProvider, model: string): number {
  const info = getModelInfo(provider, model)
  return info?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS
}

/**
 * Check if a model is valid for a provider.
 * @param provider - LLM provider
 * @param model - Model name
 * @returns true if the model is in the registry
 */
export function isValidProviderModel(provider: LLMProvider, model: string): boolean {
  return getModelInfo(provider, model) !== undefined
}

/**
 * Get supported models for a provider.
 * @param provider - LLM provider
 * @returns Array of model names
 */
export function getSupportedModels(provider: LLMProvider): string[] {
  const providerInfo = LLM_REGISTRY[provider]
  if (!providerInfo) return []
  return providerInfo.models.map((m) => m.name)
}

/**
 * Get the default model for a provider.
 * @param provider - LLM provider
 * @returns Default model name
 */
export function getDefaultModelForProvider(provider: LLMProvider): string {
  const providerInfo = LLM_REGISTRY[provider]
  return providerInfo?.defaultModel ?? ''
}

/**
 * Infer provider from model name.
 * @param model - Model name
 * @returns LLMProvider or undefined if not found
 */
export function getProviderFromModel(model: string): LLMProvider | undefined {
  // Check each provider's models
  for (const provider of PROVIDER_TYPES) {
    if (getModelInfo(provider, model)) {
      return provider
    }
  }

  // Fallback: infer from model name prefix
  const lowerModel = model.toLowerCase()
  if (lowerModel.startsWith('claude')) return 'claude'
  if (lowerModel.startsWith('gemini')) return 'gemini'
  if (lowerModel.startsWith('gpt') || lowerModel.startsWith('o1') || lowerModel.startsWith('o3') || lowerModel.startsWith('o4')) return 'openai'
  if (lowerModel.includes('/')) return 'openai' // OpenRouter uses provider/model format, but underlying API is OpenAI-compatible

  return undefined
}

/**
 * Get supported file types for a model.
 * @param provider - LLM provider
 * @param model - Model name
 * @returns Array of supported file types
 */
export function getSupportedFileTypesForModel(
  provider: LLMProvider,
  model: string
): SupportedFileType[] {
  const info = getModelInfo(provider, model)
  if (info) return info.supportedFileTypes

  // Fallback to provider-level defaults
  const providerInfo = LLM_REGISTRY[provider]
  return providerInfo?.supportedFileTypes ?? []
}

/**
 * Check if a model supports a specific file type.
 * @param provider - LLM provider
 * @param model - Model name
 * @param fileType - File type to check
 * @returns true if the model supports the file type
 */
export function modelSupportsFileType(
  provider: LLMProvider,
  model: string,
  fileType: SupportedFileType
): boolean {
  const supportedTypes = getSupportedFileTypesForModel(provider, model)
  return supportedTypes.includes(fileType)
}

/**
 * Get model capabilities.
 * @param provider - LLM provider
 * @param model - Model name
 * @returns ModelCapabilities
 */
export function getModelCapabilities(provider: LLMProvider, model: string): ModelCapabilities {
  const info = getModelInfoWithFallback(provider, model)
  return info.capabilities
}

/**
 * Get effective max input tokens considering config override.
 * @param provider - LLM provider
 * @param model - Model name
 * @param configuredMax - Optional configured max from user
 * @returns Effective max input tokens (min of model limit and configured limit)
 */
export function getEffectiveMaxInputTokens(
  provider: LLMProvider,
  model: string,
  configuredMax?: number
): number {
  const modelInfo = getModelInfo(provider, model)
  if (modelInfo) {
    // Model is known — registry is authoritative; configuredMax can only reduce it (user-defined cap)
    if (configuredMax === undefined) return modelInfo.maxInputTokens
    return Math.min(modelInfo.maxInputTokens, configuredMax)
  }

  // Model is unknown (e.g. new OpenRouter model not yet in registry).
  // Trust configuredMax when provided — it comes from an authoritative source like the OpenRouter API.
  return configuredMax ?? DEFAULT_MAX_INPUT_TOKENS
}

/**
 * Resolve a user-facing provider ID (e.g. 'anthropic', 'openrouter', 'google-vertex')
 * to a registry provider type ('claude' | 'gemini' | 'openai').
 *
 * Used by both AgentLLMService (tokenizer/formatter selection) and CipherAgent
 * (registry-clamped maxInputTokens for map tools).
 */
export function resolveRegistryProvider(
  model: string,
  explicitProvider?: string,
): LLMProvider {
  // 1. Explicit provider mapping takes priority.
  //
  // Every list below must stay in sync with the `providerType` declared on
  // the matching provider module in src/agent/infra/llm/providers/. A missing
  // entry on the OpenAI side routes the provider through Gemini formatter /
  // tokenizer / registry, fires a "Model not supported" warning, and corrupts
  // context-length lookups (root cause of ENG-2897). Sync is verified by a
  // regression test that cross-checks each list against PROVIDER_MODULES at
  // test time — both for the openai list AND for the claude / gemini lists,
  // so a future drift on any side fails loudly rather than relying on the
  // terminal fallback below.
  if (explicitProvider) {
    if (explicitProvider === 'anthropic') return 'claude'
    if (
      explicitProvider === 'byterover' ||
      explicitProvider === 'google' ||
      explicitProvider === 'google-vertex'
    ) {
      return 'gemini'
    }

    if (
      [
        'cerebras',
        'cohere',
        'deepinfra',
        'deepseek',
        'glm',
        'glm-coding-plan',
        'groq',
        'minimax',
        'mistral',
        'moonshot',
        'openai',
        'openai-compatible',
        'openrouter',
        'perplexity',
        'togetherai',
        'vercel',
        'xai',
      ].includes(explicitProvider)
    ) {
      return 'openai'
    }
  }

  // 2. Use registry to detect provider from model name
  const registryProvider = getProviderFromModel(model)
  if (registryProvider) return registryProvider

  // 3. Fallback to string prefix matching for unknown models
  const lowerModel = model.toLowerCase()
  if (lowerModel.startsWith('claude')) return 'claude'
  if (
    lowerModel.startsWith('gpt') ||
    lowerModel.startsWith('o1') ||
    lowerModel.startsWith('o3') ||
    lowerModel.startsWith('o4')
  ) {
    return 'openai'
  }

  return 'gemini'
}

/**
 * Check if OpenRouter accepts any model (custom models).
 * OpenRouter can route to many models not in our registry.
 * @param provider - LLM provider
 * @returns true if provider accepts arbitrary models
 */
export function acceptsAnyModel(provider: LLMProvider): boolean {
  // OpenAI provider type accepts arbitrary models (OpenRouter, direct OpenAI, xAI, etc.)
  return provider === 'openai'
}

/**
 * Strip an OpenRouter-style `provider/` prefix from a model id.
 * Returns the input unchanged if no slash is present.
 */
function stripRouterPrefix(modelId: string): string {
  const slash = modelId.lastIndexOf('/')
  return slash === -1 ? modelId : modelId.slice(slash + 1)
}

/**
 * Check whether a model accepts the sampling parameters `temperature`, `top_p`,
 * and `top_k`.
 *
 * Some models (e.g. Claude Opus 4.7) reject any non-default value with a 400
 * error — callers must omit these parameters entirely when this returns false.
 *
 * Handles both bare model ids (`claude-opus-4-7`) and OpenRouter-style prefixed
 * ids (`anthropic/claude-opus-4-7`). Unknown models default to true so we don't
 * regress arbitrary OpenRouter-routed models.
 */
export function modelAcceptsSamplingParameters(modelId: string): boolean {
  const bare = stripRouterPrefix(modelId)

  for (const provider of PROVIDER_TYPES) {
    const info = getModelInfo(provider, bare)
    if (info) {
      return info.capabilities.acceptsSamplingParameters !== false
    }
  }

  // Family-level fallback: catches date-suffixed snapshots not yet in the registry
  // (e.g. `claude-opus-4-7-20260101`). Extend this list as new families deprecate
  // sampling params.
  if (bare.startsWith('claude-opus-4-7')) return false

  return true
}
