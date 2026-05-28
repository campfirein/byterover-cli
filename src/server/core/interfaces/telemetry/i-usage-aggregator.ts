import type {LlmUsage} from '../../domain/entities/llm-usage.js'

/**
 * Per-task LLM usage aggregator.
 *
 * Implementations subscribe to `llmservice:usage` events for a specific task,
 * roll the per-call payloads up into running totals, and expose snapshot reads
 * (`getTotals`, `getLlmMs`) for the executor to forward to the persistence
 * layer.
 *
 * Lives in `core/interfaces/` so executor interfaces can reference it
 * without crossing the `core → infra` boundary. The default implementation
 * is `TaskUsageAggregator` in `infra/telemetry/`.
 */
export interface IUsageAggregator {
  /** Add one LLM call's usage and (optional) wall-clock duration to the rolling totals. */
  addUsage(usage: LlmUsage, durationMs?: number): void
  /** Sum of LLM-call durations seen so far (ms). Returns `0` when no events have arrived. */
  getLlmMs(): number
  /** Snapshot of the rolled-up usage. Returns `ZERO_USAGE` when no events have arrived. */
  getTotals(): LlmUsage
}
