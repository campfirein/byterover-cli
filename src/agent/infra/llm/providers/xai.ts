/**
 * xAI (Grok) Provider Module
 *
 * Direct access to Grok models via @ai-sdk/xai.
 */

import {createXai} from '@ai-sdk/xai'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const xaiProvider: ProviderModule = {
  apiKeyUrl: 'https://console.x.ai',
  authType: 'api-key',
  baseUrl: 'https://api.x.ai/v1',
  category: 'popular',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createXai({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'grok-3',
  description: 'Grok models by xAI',
  envVars: ['XAI_API_KEY'],
  id: 'xai',
  name: 'xAI (Grok)',
  priority: 6,

  providerType: 'openai',
}
