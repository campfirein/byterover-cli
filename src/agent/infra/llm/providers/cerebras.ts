/**
 * Cerebras Provider Module
 *
 * Fast inference on Cerebras hardware via @ai-sdk/cerebras.
 */

import {createCerebras} from '@ai-sdk/cerebras'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const cerebrasProvider: ProviderModule = {
  apiKeyUrl: 'https://cloud.cerebras.ai/platform',
  authType: 'api-key',
  baseUrl: 'https://api.cerebras.ai/v1',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createCerebras({
      apiKey: config.apiKey!,
      headers: {
        'X-Cerebras-3rd-Party-Integration': 'byterover-cli',
      },
    })

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'gpt-oss-120b',
  description: 'Fast inference on Cerebras hardware',
  envVars: ['CEREBRAS_API_KEY'],
  id: 'cerebras',
  name: 'Cerebras',
  priority: 14,

  providerType: 'openai',
}
