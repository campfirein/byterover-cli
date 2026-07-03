/**
 * Provider Module Registry
 *
 * Central registry mapping provider IDs to their ProviderModule implementations.
 * Following opencode's pattern: the service layer calls getProviderModule(id) and
 * uses its createGenerator() factory without knowing provider internals.
 */

import type {IContentGenerator} from '../../../core/interfaces/i-content-generator.js'
import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {anthropicProvider} from './anthropic.js'
import {byteroverProvider} from './byterover.js'
import {cerebrasProvider} from './cerebras.js'
import {cohereProvider} from './cohere.js'
import {deepinfraProvider} from './deepinfra.js'
import {deepseekProvider} from './deepseek.js'
import {glmCodingPlanProvider} from './glm-coding-plan.js'
import {glmProvider} from './glm.js'
import {googleProvider} from './google.js'
import {groqProvider} from './groq.js'
import {minimaxProvider} from './minimax.js'
import {mistralProvider} from './mistral.js'
import {moonshotProvider} from './moonshot.js'
import {openaiCompatibleProvider} from './openai-compatible.js'
import {openaiProvider} from './openai.js'
import {openrouterProvider} from './openrouter.js'
import {perplexityProvider} from './perplexity.js'
import {requestyProvider} from './requesty.js'
import {togetheraiProvider} from './togetherai.js'
import {vercelProvider} from './vercel.js'
import {xaiProvider} from './xai.js'

/**
 * Registry of all available provider modules.
 * Sorted alphabetically by key for linting compliance.
 */
const PROVIDER_MODULES: Readonly<Record<string, ProviderModule>> = {
  anthropic: anthropicProvider,
  byterover: byteroverProvider,
  cerebras: cerebrasProvider,
  cohere: cohereProvider,
  deepinfra: deepinfraProvider,
  deepseek: deepseekProvider,
  glm: glmProvider,
  'glm-coding-plan': glmCodingPlanProvider,
  google: googleProvider,
  groq: groqProvider,
  minimax: minimaxProvider,
  mistral: mistralProvider,
  moonshot: moonshotProvider,
  openai: openaiProvider,
  'openai-compatible': openaiCompatibleProvider,
  openrouter: openrouterProvider,
  perplexity: perplexityProvider,
  requesty: requestyProvider,
  togetherai: togetheraiProvider,
  vercel: vercelProvider,
  xai: xaiProvider,
}

/**
 * Get a provider module by ID.
 */
export function getProviderModule(id: string): ProviderModule | undefined {
  return PROVIDER_MODULES[id]
}

/**
 * List all provider modules sorted by priority.
 */
export function listProviderModules(): ProviderModule[] {
  return Object.values(PROVIDER_MODULES).sort((a, b) => a.priority - b.priority)
}

/**
 * Create an IContentGenerator for a provider using the registry.
 *
 * @throws Error if the provider ID is not found in the registry.
 */
export function createGeneratorForProvider(
  id: string,
  config: GeneratorFactoryConfig,
): IContentGenerator {
  const providerModule = PROVIDER_MODULES[id]
  if (!providerModule) {
    throw new Error(`Unknown provider: ${id}`)
  }

  return providerModule.createGenerator(config)
}

// Re-export types
export type {GeneratorFactoryConfig, ProviderAuthType, ProviderModule, ProviderType} from './types.js'
