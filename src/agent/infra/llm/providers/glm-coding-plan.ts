/**
 * GLM Coding Plan (Z.AI) Provider Module
 *
 * Same Z.AI account as the standard `glm` provider but routes through the
 * coding-plan endpoint so subscription quota is consumed instead of
 * pay-per-token billing.
 */

import {createOpenAICompatible} from '@ai-sdk/openai-compatible'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const glmCodingPlanProvider: ProviderModule = {
  apiKeyUrl: 'https://z.ai/manage-apikey/apikey-list',
  authType: 'api-key',
  baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  category: 'other',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createOpenAICompatible({
      apiKey: config.apiKey!,
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
      name: 'glm-coding-plan',
    })

    return new AiSdkContentGenerator({
      model: provider.chatModel(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'glm-4.7',
  description: 'GLM models on the Z.AI Coding Plan subscription',
  envVars: ['ZHIPU_API_KEY'],
  id: 'glm-coding-plan',
  name: 'GLM Coding Plan (Z.AI)',
  priority: 17.5,

  providerType: 'openai',
}
