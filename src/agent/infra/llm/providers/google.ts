/**
 * Google Gemini API Provider Module
 *
 * Direct access to Gemini models via @ai-sdk/google (API key auth).
 */

import {createGoogleGenerativeAI} from '@ai-sdk/google'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

export const googleProvider: ProviderModule = {
  apiKeyUrl: 'https://aistudio.google.com/apikey',
  authType: 'api-key',
  category: 'popular',
  createGenerator(config: GeneratorFactoryConfig) {
    const provider = createGoogleGenerativeAI({apiKey: config.apiKey!})

    return new AiSdkContentGenerator({
      model: provider(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'gemini-3-flash-preview',
  description: 'Gemini models by Google',
  envVars: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  id: 'google',
  name: 'Google Gemini',
  priority: 4,

  providerType: 'gemini',
}
