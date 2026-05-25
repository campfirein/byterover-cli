/**
 * Mistral Provider Module
 *
 * Direct access to Mistral AI models via @ai-sdk/mistral.
 */

import {createMistral} from '@ai-sdk/mistral'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const mistralProvider: ProviderModule = {
  apiKeyUrl: 'https://console.mistral.ai/api-keys',
  authType: 'api-key',
  baseUrl: 'https://api.mistral.ai/v1',
  category: 'popular',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createMistral({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'mistral-large-latest',
  description: 'Mistral AI models',
  envVars: ['MISTRAL_API_KEY'],
  id: 'mistral',
  name: 'Mistral',
  priority: 8,

  providerType: 'openai',
}
