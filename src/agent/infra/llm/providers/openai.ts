/**
 * OpenAI Provider Module
 *
 * Direct access to GPT models via @ai-sdk/openai.
 * Supports both standard OpenAI API and ChatGPT OAuth (Codex) endpoint.
 */

import {createOpenAI} from '@ai-sdk/openai'

import type {GeneratorFactoryConfig, ProviderModule} from './types.js'

import {CHATGPT_OAUTH_BASE_URL} from '../../../../shared/constants/oauth.js'
import {AiSdkContentGenerator} from '../generators/ai-sdk-content-generator.js'

/**
 * Custom fetch wrapper for the ChatGPT OAuth endpoint.
 *
 * The ChatGPT OAuth Responses API has stricter requirements than the standard
 * OpenAI API — certain fields are required and others are rejected:
 * - `instructions` is required (system prompt — defaults to empty)
 * - `store` must be false
 * - `max_output_tokens` is not supported (must be omitted)
 * - `id` fields on input items are rejected
 */
/* eslint-disable n/no-unsupported-features/node-builtins */
export function createChatGptOAuthFetch(): typeof globalThis.fetch {
  return async (input, init) => {
    if (init?.method === 'POST' && init.body) {
      if (typeof init.body !== 'string') {
        return globalThis.fetch(input, init)
      }

      let body: Record<string, unknown>
      try {
        body = JSON.parse(init.body)
      } catch {
        return globalThis.fetch(input, init)
      }

      // The AI SDK sends systemPrompt as input[0] with role "system" or "developer".
      // The ChatGPT OAuth Responses endpoint expects it in top-level `instructions`.
      if (!body.instructions && Array.isArray(body.input) && body.input.length > 0) {
        const first = body.input[0]
        if (typeof first === 'object' && first !== null) {
          const record = first as Record<string, unknown>
          if ((record.role === 'system' || record.role === 'developer') && typeof record.content === 'string') {
            body.instructions = record.content
            body.input.splice(0, 1)
          }
        }
      }

      if (!body.instructions) {
        body.instructions = ''
      }

      body.store = false
      delete body.max_output_tokens

      if (Array.isArray(body.input)) {
        for (const item of body.input) {
          if (typeof item === 'object' && item !== null && 'id' in item) {
            const record: Record<string, unknown> = item
            delete record.id
          }
        }
      }

      init = {...init, body: JSON.stringify(body)}
    }

    return globalThis.fetch(input, init)
  }
}
/* eslint-enable n/no-unsupported-features/node-builtins */

export const openaiProvider: ProviderModule = {
  apiKeyUrl: 'https://platform.openai.com/api-keys',
  authType: 'api-key',
  baseUrl: 'https://api.openai.com/v1',
  category: 'popular',
  createGenerator(config: GeneratorFactoryConfig) {
    const useChatGptOAuth = config.baseUrl === CHATGPT_OAUTH_BASE_URL

    const provider = createOpenAI({
      apiKey: config.apiKey ?? '',
      baseURL: config.baseUrl,
      fetch: useChatGptOAuth ? createChatGptOAuthFetch() : undefined,
      headers: config.headers,
    })

    return new AiSdkContentGenerator({
      model: provider.responses(config.model),
      requestTimeoutMs: config.requestTimeoutMs,
    })
  },
  defaultModel: 'gpt-4.1',
  description: 'GPT models by OpenAI',
  envVars: ['OPENAI_API_KEY'],
  id: 'openai',
  name: 'OpenAI',
  priority: 3,

  providerType: 'openai',
}
