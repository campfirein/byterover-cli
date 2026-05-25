/**
 * DeepInfra Provider Module
 *
 * Affordable inference on open models via @ai-sdk/deepinfra.
 */

import {createDeepInfra} from '@ai-sdk/deepinfra'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const deepinfraProvider: ProviderModule = {
  apiKeyUrl: 'https://deepinfra.com/dash/api_keys',
  authType: 'api-key',
  baseUrl: 'https://api.deepinfra.com/v1/openai',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createDeepInfra({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  description: 'Affordable inference on open models',
  envVars: ['DEEPINFRA_API_KEY'],
  id: 'deepinfra',
  name: 'DeepInfra',
  priority: 10,

  providerType: 'openai',
}
