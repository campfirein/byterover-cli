import type {LlmUsage} from '../../core/domain/entities/llm-usage.js'
import type {IUsageAggregator} from '../../core/interfaces/telemetry/i-usage-aggregator.js'

import {addUsage, ZERO_USAGE} from '../../core/domain/entities/llm-usage.js'

/**
 * Per-task accumulator for `LlmUsage` + `llmMs`. Subscribes (in production)
 * to `llmservice:usage` events emitted by `LoggingContentGenerator` after
 * each LLM call; sums tokens into {@link getTotals} and per-call durations
 * into {@link getLlmMs}. The executor (query / curate) reads both at task
 * completion and writes them to the log entry.
 *
 * Tests exercise the aggregator via direct `addUsage()` calls without
 * coupling to the event-bus plumbing.
 */
export class TaskUsageAggregator implements IUsageAggregator {
  public readonly taskId: string
  private llmMsTotal = 0
  private totals: LlmUsage = ZERO_USAGE

  constructor(taskId: string) {
    this.taskId = taskId
  }

  /**
   * Accumulate a single LLM call's usage and (optionally) its wall-clock
   * duration. Pass `durationMs` from the event payload — undefined leaves
   * `llmMs` unchanged for that call.
   */
  public addUsage(usage: LlmUsage, durationMs?: number): void {
    this.totals = addUsage(this.totals, usage)
    if (durationMs !== undefined && durationMs >= 0) {
      this.llmMsTotal += durationMs
    }
  }

  /** Sum of LLM-call durations seen by `addUsage` (milliseconds). */
  public getLlmMs(): number {
    return this.llmMsTotal
  }

  public getTotals(): LlmUsage {
    return {...this.totals}
  }

  public reset(): void {
    this.totals = ZERO_USAGE
    this.llmMsTotal = 0
  }
}
