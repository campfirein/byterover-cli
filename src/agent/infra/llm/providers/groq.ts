/**
 * Groq Provider Module
 *
 * Fast inference on open models via @ai-sdk/groq.
 */

import {createGroq} from '@ai-sdk/groq'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const groqProvider: ProviderModule = {
  apiKeyUrl: 'https://console.groq.com/keys',
  authType: 'api-key',
  baseUrl: 'https://api.groq.com/openai/v1',
  category: 'popular',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createGroq({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'openai/gpt-oss-120b',
  description: 'Fast inference on open models',
  envVars: ['GROQ_API_KEY'],
  id: 'groq',
  name: 'Groq',
  priority: 7,

  providerType: 'openai',
}
