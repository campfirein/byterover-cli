/**
 * Perplexity Provider Module
 *
 * Web search-augmented inference via @ai-sdk/perplexity.
 */

import {createPerplexity} from '@ai-sdk/perplexity'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const perplexityProvider: ProviderModule = {
  apiKeyUrl: 'https://www.perplexity.ai/settings/api',
  authType: 'api-key',
  baseUrl: 'https://api.perplexity.ai',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createPerplexity({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'sonar-pro',
  description: 'Web search-augmented inference',
  envVars: ['PERPLEXITY_API_KEY'],
  id: 'perplexity',
  name: 'Perplexity',
  priority: 13,

  providerType: 'openai',
}
