import {expect} from 'chai'

import {TaskUsageAggregator} from '../../../../src/server/infra/telemetry/task-usage-aggregator.js'

describe('TaskUsageAggregator', () => {
  it('should expose the taskId it was constructed with', () => {
    const aggregator = new TaskUsageAggregator('task-abc')

    expect(aggregator.taskId).to.equal('task-abc')
  })

  it('should return ZERO totals before any usage is added', () => {
    const aggregator = new TaskUsageAggregator('task-abc')

    const totals = aggregator.getTotals()

    expect(totals.inputTokens).to.equal(0)
    expect(totals.outputTokens).to.equal(0)
    expect(totals.cachedInputTokens).to.be.undefined
    expect(totals.cacheCreationTokens).to.be.undefined
  })

  it('should accumulate input and output across multiple addUsage calls', () => {
    const aggregator = new TaskUsageAggregator('task-abc')

    aggregator.addUsage({inputTokens: 100, outputTokens: 50})
    aggregator.addUsage({inputTokens: 200, outputTokens: 75})

    const totals = aggregator.getTotals()

    expect(totals.inputTokens).to.equal(300)
    expect(totals.outputTokens).to.equal(125)
  })

  it('should accumulate cache fields when present', () => {
    const aggregator = new TaskUsageAggregator('task-abc')

    aggregator.addUsage({cacheCreationTokens: 5, cachedInputTokens: 10, inputTokens: 100, outputTokens: 50})
    aggregator.addUsage({cacheCreationTokens: 8, cachedInputTokens: 20, inputTokens: 200, outputTokens: 75})

    const totals = aggregator.getTotals()

    expect(totals.cachedInputTokens).to.equal(30)
    expect(totals.cacheCreationTokens).to.equal(13)
  })

  it('should preserve cache fields contributed by only some additions', () => {
    const aggregator = new TaskUsageAggregator('task-abc')

    aggregator.addUsage({inputTokens: 100, outputTokens: 50})
    aggregator.addUsage({cachedInputTokens: 50, inputTokens: 200, outputTokens: 75})

    const totals = aggregator.getTotals()

    expect(totals.cachedInputTokens).to.equal(50)
    expect(totals.cacheCreationTokens).to.be.undefined
  })

  it('should return a fresh copy on each getTotals call (no mutation leaks)', () => {
    const aggregator = new TaskUsageAggregator('task-abc')
    aggregator.addUsage({inputTokens: 100, outputTokens: 50})

    const first = aggregator.getTotals()
    first.inputTokens = 9999

    const second = aggregator.getTotals()

    expect(second.inputTokens).to.equal(100)
  })

  it('should reset totals to zero', () => {
    const aggregator = new TaskUsageAggregator('task-abc')
    aggregator.addUsage({cachedInputTokens: 10, inputTokens: 100, outputTokens: 50})

    aggregator.reset()
    const totals = aggregator.getTotals()

    expect(totals.inputTokens).to.equal(0)
    expect(totals.outputTokens).to.equal(0)
    expect(totals.cachedInputTokens).to.be.undefined
  })

  describe('llmMs accumulation', () => {
    it('should report 0 before any addUsage call', () => {
      const aggregator = new TaskUsageAggregator('task-abc')

      expect(aggregator.getLlmMs()).to.equal(0)
    })

    it('should sum durationMs across addUsage calls', () => {
      const aggregator = new TaskUsageAggregator('task-abc')

      aggregator.addUsage({inputTokens: 100, outputTokens: 50}, 200)
      aggregator.addUsage({inputTokens: 200, outputTokens: 75}, 350)

      expect(aggregator.getLlmMs()).to.equal(550)
    })

    it('should leave llmMs unchanged when durationMs is omitted', () => {
      const aggregator = new TaskUsageAggregator('task-abc')

      aggregator.addUsage({inputTokens: 100, outputTokens: 50})
      aggregator.addUsage({inputTokens: 200, outputTokens: 75}, 300)

      expect(aggregator.getLlmMs()).to.equal(300)
    })

    it('should ignore negative durationMs values defensively', () => {
      const aggregator = new TaskUsageAggregator('task-abc')

      aggregator.addUsage({inputTokens: 100, outputTokens: 50}, -50)

      expect(aggregator.getLlmMs()).to.equal(0)
    })

    it('should reset llmMs to zero on reset()', () => {
      const aggregator = new TaskUsageAggregator('task-abc')
      aggregator.addUsage({inputTokens: 100, outputTokens: 50}, 200)

      aggregator.reset()

      expect(aggregator.getLlmMs()).to.equal(0)
    })
  })
})
