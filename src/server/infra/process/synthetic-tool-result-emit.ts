import {randomUUID} from 'node:crypto'
import {join} from 'node:path'

import type {ITransportClient} from '@campfirein/brv-transport-client'

import type {CurateLogOperation} from '../../core/domain/entities/curate-log-entry.js'
import type {
  QueryToolModeMatchedDoc,
  QueryToolModeMetadata,
} from '../../core/interfaces/executor/i-query-executor.js'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../constants.js'
import {LlmEventNames} from '../../core/domain/transport/schemas.js'

/**
 * Tool-mode synthetic LLM-event emitters.
 *
 * Tool-mode dispatch (`curate-tool-mode`, `query-tool-mode`) bypasses the
 * `llmservice:toolResult` / `llmservice:toolCall` channel that the legacy
 * LLM-driven path used. AnalyticsHook, CurateLogHandler, and QueryLogHandler
 * all listen on that channel — when it is silent, every downstream M12 emit
 * fires with zero inputs (e.g. `curate_run_completed{operations_added:0}`,
 * `query_completed{matched_doc_count:0, read_paths_with_metadata: absent}`).
 *
 * These helpers shape the same wire envelopes the legacy LLM path produced
 * and ship them through the existing `ITransportClient`, so the daemon's
 * `TaskRouter.routeLlmEvent` chain runs unchanged. No producer code needs
 * to learn about tool-mode.
 *
 * Errors are swallowed — analytics MUST NOT block the user-facing
 * curate/query response.
 */

/** Synthetic events have no LLM session; use empty-string for the field. */
const SYNTHETIC_SESSION_ID = ''

/**
 * Fire a synthetic `llmservice:toolResult` mirroring the legacy curate-tool
 * envelope (`{applied: CurateLogOperation[]}`).
 *
 * Consumed by:
 * - `AnalyticsHook.processToolResult` → `extractCurateOperations` →
 *   `curate_operation_applied` per op + bumps `curate_run_completed.operations_*`
 * - `CurateLogHandler.onToolResult` → persistence to `curate-log.jsonl`
 *   (parallel coverage — the same gap exists there)
 */
export function emitSyntheticCurateToolResult(opts: {
  log?: (msg: string) => void
  operations: readonly CurateLogOperation[]
  taskId: string
  transport: ITransportClient
}): void {
  const {log, operations, taskId, transport} = opts
  if (operations.length === 0) return
  try {
    transport.request(LlmEventNames.TOOL_RESULT, {
      result: JSON.stringify({applied: operations}),
      sessionId: SYNTHETIC_SESSION_ID,
      success: true,
      taskId,
      toolName: 'curate',
    })
  } catch (error) {
    log?.(
      `synthetic curate toolResult emit failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Fire synthetic `llmservice:toolCall` events for the deterministic BM25
 * retrieval + per-doc render that `brv query` runs server-side.
 *
 * Consumed by:
 * - `AnalyticsHook.buildQueryCompletedPayload` reads `task.toolCalls`:
 *     - `search_knowledge` calls bump `search_call_count`
 *     - `read_file` calls bump `read_tool_call_count` AND seed
 *       `read_paths_with_metadata[]` (enriched from each file's frontmatter)
 *
 * `matchedDocs[i].path` is a context-tree-relative path (e.g.
 * `development/guidelines/x.md`). The enrichment reader needs an absolute
 * path to find the file on disk; we join against `<projectPath>/.brv/context-tree/`
 * before passing it through `args.filePath`. `AnalyticsHook.toRelativePath`
 * then translates the absolute path back to project-relative for the wire
 * `relative_path` field.
 *
 * PRIVACY: the raw user query string is NOT included in `args`. Only
 * structured retrieval metadata (tier, count, score, cacheHit) flows.
 */
export function emitSyntheticQueryToolCalls(opts: {
  log?: (msg: string) => void
  matchedDocs: readonly QueryToolModeMatchedDoc[]
  metadata: QueryToolModeMetadata
  projectPath: string
  taskId: string
  transport: ITransportClient
}): void {
  const {log, matchedDocs, metadata, projectPath, taskId, transport} = opts
  const contextTreeRoot = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)
  try {
    transport.request(LlmEventNames.TOOL_CALL, {
      args: {
        cacheHit: metadata.cacheHit ?? null,
        matchedCount: matchedDocs.length,
        tier: metadata.tier,
        topScore: metadata.topScore,
        totalFound: metadata.totalFound,
      },
      callId: randomUUID(),
      sessionId: SYNTHETIC_SESSION_ID,
      taskId,
      toolName: 'search_knowledge',
    })

    for (const doc of matchedDocs) {
      transport.request(LlmEventNames.TOOL_CALL, {
        args: {filePath: join(contextTreeRoot, doc.path)},
        callId: randomUUID(),
        sessionId: SYNTHETIC_SESSION_ID,
        taskId,
        toolName: 'read_file',
      })
    }
  } catch (error) {
    log?.(
      `synthetic query toolCall emit failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
