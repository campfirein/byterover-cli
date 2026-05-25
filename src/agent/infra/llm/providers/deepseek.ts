/**
 * DeepSeek Provider Module
 *
 * Access to DeepSeek V3 (deepseek-chat) and R1 (deepseek-reasoner) via their
 * OpenAI-compatible API. The reasoner model streams thinking through the
 * native `reasoning_content` field rather than `<think>` tags — see
 * model-capabilities.ts for the parser routing.
 */

import {createOpenAICompatible} from '@ai-sdk/openai-compatible'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const deepseekProvider: ProviderModule = {
  apiKeyUrl: 'https://platform.deepseek.com/api_keys',
  authType: 'api-key',
  baseUrl: 'https://api.deepseek.com/v1',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createOpenAICompatible({
      apiKey: config.apiKey!,
      baseURL: 'https://api.deepseek.com/v1',
      name: 'deepseek',
    })

    return new AiSdkContentGenerator({
      model: provider.chatModel(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'deepseek-chat',
  description: 'DeepSeek V3 and R1 reasoning models',
  envVars: ['DEEPSEEK_API_KEY'],
  id: 'deepseek',
  name: 'DeepSeek',
  priority: 19,

  providerType: 'openai',
}
