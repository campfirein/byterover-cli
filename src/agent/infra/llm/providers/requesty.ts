/**
 * Requesty Provider Module
 *
 * Access 300+ models via the Requesty router using its OpenAI-compatible API.
 * Requesty exposes an OpenAI-shaped endpoint at https://router.requesty.ai/v1,
 * so it is wired through @ai-sdk/openai-compatible.
 */

import {createOpenAICompatible} from '@ai-sdk/openai-compatible'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

const REQUESTY_BASE_URL = 'https://router.requesty.ai/v1'

export const requestyProvider: ProviderModule = {
  apiKeyUrl: 'https://app.requesty.ai/api-keys',
  authType: 'api-key',
  baseUrl: REQUESTY_BASE_URL,
  category: 'popular',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createOpenAICompatible({
      apiKey: config.apiKey || '',
      baseURL: config.baseUrl || REQUESTY_BASE_URL,
      headers: {
        'HTTP-Referer': config.httpReferer ?? 'https://byterover.dev',
        'X-Title': config.siteName ?? 'byterover-cli',
        ...config.headers,
      },
      name: 'requesty',
    })

    return new AiSdkContentGenerator({
      model: provider.chatModel(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'openai/gpt-4o-mini',
  description: 'Access 300+ models via the Requesty router',
  envVars: ['REQUESTY_API_KEY'],
  id: 'requesty',
  name: 'Requesty',
  priority: 1.5,

  providerType: 'openai',
}
