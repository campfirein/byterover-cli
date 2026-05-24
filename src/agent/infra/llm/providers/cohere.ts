/**
 * Cohere Provider Module
 *
 * Command models by Cohere via @ai-sdk/cohere.
 */

import {createCohere} from '@ai-sdk/cohere'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const cohereProvider: ProviderModule = {
  apiKeyUrl: 'https://dashboard.cohere.com/api-keys',
  authType: 'api-key',
  baseUrl: 'https://api.cohere.com/v2',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createCohere({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'command-a-03-2025',
  description: 'Command models by Cohere',
  envVars: ['COHERE_API_KEY'],
  id: 'cohere',
  name: 'Cohere',
  priority: 11,

  providerType: 'openai',
}
