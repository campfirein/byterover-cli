/**
 * OpenAI Compatible Provider Module
 *
 * Generic catch-all for any OpenAI-compatible endpoint.
 * Supports local LLMs (Ollama, LM Studio, llama.cpp, vLLM, LocalAI)
 * and any other service exposing an OpenAI-compatible API.
 */

import {createOpenAICompatible} from '@ai-sdk/openai-compatible'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const openaiCompatibleProvider: ProviderModule = {
  authType: 'api-key',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createOpenAICompatible({
      apiKey: config.apiKey || '',
      baseURL: config.baseUrl || 'http://localhost:11434/v1',
      name: 'openai-compatible',
    })

    return new AiSdkContentGenerator({
      model: provider.chatModel(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'llama3',
  description: 'Connect any OpenAI-compatible endpoint (Ollama, LM Studio, etc.)',
  envVars: ['OPENAI_COMPATIBLE_API_KEY'],
  id: 'openai-compatible',
  name: 'OpenAI Compatible',
  priority: 20,

  providerType: 'openai',
}
