/**
 * MiniMax Provider Module
 *
 * Access to MiniMax models via their OpenAI-compatible API.
 */

import {createOpenAICompatible} from '@ai-sdk/openai-compatible'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const minimaxProvider: ProviderModule = {
  apiKeyUrl: 'https://platform.minimax.io',
  authType: 'api-key',
  baseUrl: 'https://api.minimax.io/v1',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createOpenAICompatible({
      apiKey: config.apiKey!,
      baseURL: 'https://api.minimax.io/v1',
      name: 'minimax',
    })

    return new AiSdkContentGenerator({
      model: provider.chatModel(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'MiniMax-M2.7',
  description: 'MiniMax AI models',
  envVars: ['MINIMAX_API_KEY'],
  id: 'minimax',
  name: 'MiniMax',
  priority: 16,

  providerType: 'openai',
}
