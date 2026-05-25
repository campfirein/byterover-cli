/* eslint-disable camelcase */
// Test fixtures intentionally use the snake_case wire format from Anthropic /
// OpenAI APIs (input_tokens, prompt_tokens, etc.) — that's what `extractUsage`
// is documented to map from. The disable is per CLAUDE.md "Snake_case APIs"
// convention and was approved by the user (Phat) for this file.

import {expect} from 'chai'

import {extractUsage} from '../../../../src/agent/infra/llm/usage-extractor.js'

describe('extractUsage', () => {
  describe('anthropic provider', () => {
    it('should map snake_case fields to canonical M1 names', () => {
      const raw = {
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 200,
        input_tokens: 1000,
        output_tokens: 250,
      }

      const usage = extractUsage(raw, 'anthropic')

      expect(usage).to.deep.equal({
        cacheCreationTokens: 50,
        cachedInputTokens: 200,
        inputTokens: 1000,
        outputTokens: 250,
      })
    })

    it('should omit cache fields when absent', () => {
      const raw = {input_tokens: 1000, output_tokens: 250}

      const usage = extractUsage(raw, 'anthropic')

      expect(usage).to.deep.equal({inputTokens: 1000, outputTokens: 250})
    })

    it('should return undefined when raw has no token fields', () => {
      expect(extractUsage({}, 'anthropic')).to.be.undefined
    })

    it('should return undefined for null/undefined raw', () => {
      expect(extractUsage(null, 'anthropic')).to.be.undefined
      expect(extractUsage(undefined, 'anthropic')).to.be.undefined
    })
  })

  describe('openai provider', () => {
    it('should map prompt_tokens / completion_tokens to canonical', () => {
      const raw = {
        completion_tokens: 250,
        prompt_tokens: 1000,
        prompt_tokens_details: {cached_tokens: 200},
      }

      const usage = extractUsage(raw, 'openai')

      expect(usage?.inputTokens).to.equal(1000)
      expect(usage?.outputTokens).to.equal(250)
      expect(usage?.cachedInputTokens).to.equal(200)
    })

    it('should omit cachedInputTokens when prompt_tokens_details is missing', () => {
      const raw = {completion_tokens: 250, prompt_tokens: 1000}

      const usage = extractUsage(raw, 'openai')

      expect(usage?.cachedInputTokens).to.be.undefined
    })

    it('should never set cacheCreationTokens (OpenAI has no equivalent)', () => {
      const raw = {
        completion_tokens: 250,
        prompt_tokens: 1000,
        prompt_tokens_details: {cached_tokens: 200},
      }

      const usage = extractUsage(raw, 'openai')

      expect(usage?.cacheCreationTokens).to.be.undefined
    })
  })

  describe('google provider', () => {
    it('should map promptTokenCount / candidatesTokenCount / cachedContentTokenCount', () => {
      const raw = {
        cachedContentTokenCount: 200,
        candidatesTokenCount: 250,
        promptTokenCount: 1000,
      }

      const usage = extractUsage(raw, 'google')

      expect(usage?.inputTokens).to.equal(1000)
      expect(usage?.outputTokens).to.equal(250)
      expect(usage?.cachedInputTokens).to.equal(200)
    })

    it('should omit cachedInputTokens when cachedContentTokenCount is missing', () => {
      const raw = {candidatesTokenCount: 250, promptTokenCount: 1000}

      const usage = extractUsage(raw, 'google')

      expect(usage?.cachedInputTokens).to.be.undefined
    })

    it('should never set cacheCreationTokens (Gemini has no equivalent)', () => {
      const raw = {
        cachedContentTokenCount: 200,
        candidatesTokenCount: 250,
        promptTokenCount: 1000,
      }

      const usage = extractUsage(raw, 'google')

      expect(usage?.cacheCreationTokens).to.be.undefined
    })
  })

  describe('aiSdk provider', () => {
    it('should pass camelCase fields straight through', () => {
      const raw = {cachedInputTokens: 200, inputTokens: 1000, outputTokens: 250}

      const usage = extractUsage(raw, 'aiSdk')

      expect(usage?.inputTokens).to.equal(1000)
      expect(usage?.outputTokens).to.equal(250)
      expect(usage?.cachedInputTokens).to.equal(200)
    })

    it('should preserve cacheCreationTokens when AI SDK exposes it', () => {
      const raw = {cacheCreationTokens: 50, cachedInputTokens: 200, inputTokens: 1000, outputTokens: 250}

      const usage = extractUsage(raw, 'aiSdk')

      expect(usage?.cacheCreationTokens).to.equal(50)
    })

    it('should return undefined when inputTokens and outputTokens are both absent', () => {
      expect(extractUsage({}, 'aiSdk')).to.be.undefined
    })
  })

  describe('numeric coercion safety', () => {
    it('should reject non-number token values', () => {
      const raw = {input_tokens: '1000', output_tokens: 250}

      const usage = extractUsage(raw, 'anthropic')

      // input_tokens is a string — the extractor should not silently coerce.
      expect(usage?.inputTokens).to.not.equal(1000)
    })
  })
})
