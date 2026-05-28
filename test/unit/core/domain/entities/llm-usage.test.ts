import {expect} from 'chai'

import type {LlmUsage} from '../../../../../src/server/core/domain/entities/llm-usage.js'

import {addUsage, ZERO_USAGE} from '../../../../../src/server/core/domain/entities/llm-usage.js'

describe('LlmUsage', () => {
  describe('ZERO_USAGE', () => {
    it('should have zero input and output tokens', () => {
      expect(ZERO_USAGE.inputTokens).to.equal(0)
      expect(ZERO_USAGE.outputTokens).to.equal(0)
    })

    it('should omit cache fields when zero (optional)', () => {
      expect(ZERO_USAGE.cachedInputTokens).to.be.undefined
      expect(ZERO_USAGE.cacheCreationTokens).to.be.undefined
    })
  })

  describe('addUsage', () => {
    it('should sum input and output tokens', () => {
      const a: LlmUsage = {inputTokens: 100, outputTokens: 50}
      const b: LlmUsage = {inputTokens: 200, outputTokens: 75}

      const sum = addUsage(a, b)

      expect(sum.inputTokens).to.equal(300)
      expect(sum.outputTokens).to.equal(125)
    })

    it('should sum cache fields when both sides have them', () => {
      const a: LlmUsage = {cacheCreationTokens: 5, cachedInputTokens: 10, inputTokens: 100, outputTokens: 50}
      const b: LlmUsage = {cacheCreationTokens: 8, cachedInputTokens: 20, inputTokens: 200, outputTokens: 75}

      const sum = addUsage(a, b)

      expect(sum.cachedInputTokens).to.equal(30)
      expect(sum.cacheCreationTokens).to.equal(13)
    })

    it('should preserve cache fields when only one side has them', () => {
      const a: LlmUsage = {cachedInputTokens: 10, inputTokens: 100, outputTokens: 50}
      const b: LlmUsage = {inputTokens: 200, outputTokens: 75}

      const sum = addUsage(a, b)

      expect(sum.cachedInputTokens).to.equal(10)
      expect(sum.cacheCreationTokens).to.be.undefined
    })

    it('should omit cache fields when neither side has them', () => {
      const a: LlmUsage = {inputTokens: 100, outputTokens: 50}
      const b: LlmUsage = {inputTokens: 200, outputTokens: 75}

      const sum = addUsage(a, b)

      expect(sum).to.not.have.property('cachedInputTokens')
      expect(sum).to.not.have.property('cacheCreationTokens')
    })

    it('should be associative when summing three usages', () => {
      const a: LlmUsage = {cachedInputTokens: 1, inputTokens: 1, outputTokens: 1}
      const b: LlmUsage = {cachedInputTokens: 2, inputTokens: 2, outputTokens: 2}
      const c: LlmUsage = {cachedInputTokens: 3, inputTokens: 3, outputTokens: 3}

      const left = addUsage(addUsage(a, b), c)
      const right = addUsage(a, addUsage(b, c))

      expect(left).to.deep.equal(right)
    })

    it('should treat ZERO_USAGE as identity', () => {
      const u: LlmUsage = {cacheCreationTokens: 4, cachedInputTokens: 7, inputTokens: 100, outputTokens: 50}

      expect(addUsage(u, ZERO_USAGE)).to.deep.equal(u)
      expect(addUsage(ZERO_USAGE, u)).to.deep.equal(u)
    })
  })
})
