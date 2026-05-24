import type {ICipherAgent} from '../../../../agent/core/interfaces/i-cipher-agent.js'
import type {HtmlWriteError} from '../../../infra/render/writer/html-writer.js'
import type {CurateUsageRecord} from '../../domain/entities/curate-log-entry.js'
import type {IUsageAggregator} from '../telemetry/i-usage-aggregator.js'

/**
 * Options for executing curate with an injected agent.
 * Agent uses its default session (Single-Session pattern).
 */
export interface CurateExecuteOptions {
  /** Client's working directory for file validation (defaults to process.cwd() if not provided) */
  clientCwd?: string
  /** Context content to curate */
  content: string
  /** Optional file paths for --files flag */
  files?: string[]
  /**
   * Telemetry sink invoked by the executor at completion with the rolled-up
   * curate-side telemetry . The wiring layer plugs this into
   * `CurateLogHandler.setCurateUsage(taskId, record)` so the entry on disk
   * gets the new fields.
   */
  onTelemetry?: (record: CurateUsageRecord) => void
  /** Canonical project root where .brv/ lives (for post-processing: snapshot, summary, manifest) */
  projectRoot?: string
  /** Task ID for event routing (required for concurrent task isolation) */
  taskId: string
  /**
   * Optional per-task usage aggregator. When provided, the executor reads
   * its rolled-up totals at completion and feeds them to {@link onTelemetry}.
   * The caller is responsible for subscribing the aggregator to the agent's
   * `llmservice:usage` event stream (TODO: agent-process integration).
   *
   */
  usageAggregator?: IUsageAggregator
  /** Workspace root — linked subdir or same as projectRoot for direct projects */
  worktreeRoot?: string
}

/**
 * ICurateExecutor - Executes curate tasks with an injected CipherAgent.
 *
 * This is NOT a UseCase (which orchestrates business logic).
 * It's an Executor that wraps agent.execute() with curate-specific options.
 *
 * Architecture:
 * - AgentProcess injects the long-lived CipherAgent
 * - Event streaming is handled by agent-process (subscribes to agentEventBus)
 * - Executor focuses solely on curate execution
 */
export interface ICurateExecutor {
  /**
   * Execute curate with an injected agent.
   *
   * @param agent - Long-lived CipherAgent (managed by caller)
   * @param options - Execution options (content, file references)
   * @returns Result string from agent execution
   */
  executeWithAgent(agent: ICipherAgent, options: CurateExecuteOptions): Promise<string>
}

/**
 * Wire envelope returned by the `curate-html-direct` daemon task type.
 *
 * Single-shot: the calling agent (typically over MCP) supplies a fully
 * authored `<bv-topic>` HTML document; the daemon validates via
 * `validateHtmlTopic` and writes via `writeHtmlTopic`. No LLM, no
 * provider, no session.
 *
 * - `status: 'ok'` — write succeeded. `topicPath` is the bv-topic path
 *   attribute (e.g. `security/auth`); `filePath` is the relative path
 *   under `.brv/context-tree/` including the `.html` extension;
 *   `overwrote` is true iff the topic existed before the write and
 *   `confirmOverwrite` was set.
 * - `status: 'validation-failed'` — write was refused. `errors[]`
 *   carries the writer's structured errors (including the
 *   `existingContent` on `path-exists` so the calling agent can merge).
 *
 * Renaming any field is a breaking change for MCP consumers.
 */
export type CurateHtmlDirectResult =
  | {errors: readonly HtmlWriteError[]; status: 'validation-failed'}
  | {filePath: string; overwrote: boolean; status: 'ok'; topicPath: string; warnings?: readonly string[]}
