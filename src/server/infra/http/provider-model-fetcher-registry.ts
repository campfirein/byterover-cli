/**
 * Provider Model Fetcher Registry
 *
 * Maps provider IDs to their model fetcher implementations.
 * Lazily instantiated singletons for each provider.
 */

import type {IProviderModelFetcher} from '../../core/interfaces/i-provider-model-fetcher.js'

import {PROVIDER_REGISTRY} from '../../core/domain/entities/provider-registry.js'
import {FileProviderConfigStore} from '../storage/file-provider-config-store.js'
import {
  AnthropicModelFetcher,
  ChatBasedModelFetcher,
  GoogleModelFetcher,
  OpenAICompatibleModelFetcher,
  OpenAIModelFetcher,
  OpenRouterModelFetcher,
  RequestyModelFetcher,
} from './provider-model-fetchers.js'

/**
 * Singleton instances of model fetchers, lazily created.
 */
const fetchers = new Map<string, IProviderModelFetcher>()

/**
 * Get or create a model fetcher for a provider.
 *
 * @param providerId - Provider identifier (e.g., 'anthropic', 'openai', 'google')
 * @returns IProviderModelFetcher instance, or undefined if provider doesn't support model fetching
 */
export async function getModelFetcher(providerId: string): Promise<IProviderModelFetcher | undefined> {
  // ByteRover internal doesn't support model fetching
  if (providerId === 'byterover') return undefined

  // OpenAI Compatible: always read fresh config (baseUrl is user-configured and may change)
  if (providerId === 'openai-compatible') {
    const configStore = new FileProviderConfigStore()
    const config = await configStore.read()
    const baseUrl = config.getBaseUrl('openai-compatible')
    if (baseUrl) {
      return new OpenAICompatibleModelFetcher(baseUrl, 'OpenAI Compatible')
    }

    return undefined
  }

  // Return cached instance
  if (fetchers.has(providerId)) {
    return fetchers.get(providerId)
  }

  // Create fetcher based on provider ID
  let fetcher: IProviderModelFetcher | undefined

  switch (providerId) {
    case 'anthropic': {
      fetcher = new AnthropicModelFetcher()

      break
    }

    case 'cerebras': // falls through
    case 'cohere': // falls through
    case 'deepinfra': // falls through
    case 'deepseek': // falls through
    case 'groq': // falls through
    case 'mistral': // falls through
    case 'togetherai': // falls through
    case 'xai': {
      const provider = PROVIDER_REGISTRY[providerId]
      if (provider?.baseUrl) {
        fetcher = new OpenAICompatibleModelFetcher(provider.baseUrl, provider.name)
      }

      break
    }

    case 'glm': {
      fetcher = new ChatBasedModelFetcher(
        'https://api.z.ai/api/paas/v4',
        'GLM (Z.AI)',
        ['glm-4.7', 'glm-4.6', 'glm-4.5', 'glm-4.5-flash'],
      )

      break
    }

    case 'glm-coding-plan': {
      fetcher = new ChatBasedModelFetcher(
        'https://api.z.ai/api/coding/paas/v4',
        'GLM Coding Plan (Z.AI)',
        ['glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-5-turbo', 'glm-4.5', 'glm-4.5-flash'],
      )

      break
    }

    case 'google': {
      fetcher = new GoogleModelFetcher()

      break
    }

    case 'minimax': {
      fetcher = new ChatBasedModelFetcher(
        'https://api.minimax.io/v1',
        'MiniMax',
        ['MiniMax-M2.7', 'MiniMax-M2.6', 'MiniMax-M2.5', 'MiniMax-M2', 'MiniMax-M2-Stable'],
      )

      break
    }

    case 'moonshot': {
      fetcher = new ChatBasedModelFetcher(
        'https://api.moonshot.ai/v1',
        'Moonshot AI (Kimi)',
        ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-turbo-preview', 'kimi-k2-thinking-turbo'],
      )

      break
    }

    case 'openai': {
      fetcher = new OpenAIModelFetcher()

      break
    }

    case 'openrouter': {
      fetcher = new OpenRouterModelFetcher()

      break
    }

    case 'requesty': {
      fetcher = new RequestyModelFetcher()

      break
    }

    case 'perplexity': {
      fetcher = new ChatBasedModelFetcher(
        'https://api.perplexity.ai',
        'Perplexity',
        ['sonar-pro', 'sonar', 'sonar-reasoning-pro', 'sonar-reasoning', 'sonar-deep-research', 'r1-1776'],
      )

      break
    }

    case 'vercel': {
      fetcher = new ChatBasedModelFetcher(
        'https://api.v0.dev/v1',
        'Vercel',
        ['v0-1.5-md', 'v0-1.5-lg', 'v0-1.0-md'],
      )

      break
    }
  }

  if (fetcher) {
    fetchers.set(providerId, fetcher)
  }

  return fetcher
}

/**
 * Validate an API key for a specific provider.
 * Convenience function that gets the right fetcher and validates.
 *
 * @param apiKey - API key to validate
 * @param providerId - Provider identifier
 * @param authMethod - How this provider is authenticated (OAuth providers skip validation)
 * @returns Validation result, or {isValid: false} if no fetcher exists
 */
export async function validateApiKey(
  apiKey: string,
  providerId: string,
  authMethod?: 'api-key' | 'oauth',
): Promise<{error?: string; isValid: boolean}> {
  // OAuth tokens are validated via the token exchange flow, not API key validation
  if (authMethod === 'oauth') {
    return {isValid: true}
  }

  const fetcher = await getModelFetcher(providerId)
  if (!fetcher) {
    return {error: `No model fetcher available for provider: ${providerId}`, isValid: false}
  }

  return fetcher.validateApiKey(apiKey)
}
