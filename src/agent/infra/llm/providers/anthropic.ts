/**
 * Anthropic Provider Module
 *
 * Direct access to Claude models via @ai-sdk/anthropic.
 */

import {createAnthropic} from '@ai-sdk/anthropic'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {modelAcceptsSamplingParameters} from '../../../core/domain/llm/registry.js'
import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const anthropicProvider: ProviderModule = {
  apiKeyUrl: 'https://console.anthropic.com/settings/keys',
  authType: 'api-key',
  baseUrl: 'https://api.anthropic.com',
  category: 'popular',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createAnthropic({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      charsPerToken: 3.5,
      excludeSamplingParameters: !modelAcceptsSamplingParameters(config.model),
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'claude-sonnet-4-5-20250929',
  description: 'Claude models by Anthropic',
  envVars: ['ANTHROPIC_API_KEY'],
  id: 'anthropic',
  name: 'Anthropic',
  priority: 2,

  providerType: 'claude',
}
