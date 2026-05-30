import type {ITransportClient} from '@campfirein/brv-transport-client'

import {randomUUID} from 'node:crypto'
import {join} from 'node:path'

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
 * Fire-and-forget emit that swallows BOTH synchronous throws and async
 * rejections (PR #728 review fix). `ITransportClient.request` can return
 * a Promise that rejects after the synchronous call returns; without this
 * wrapper that rejection becomes an unhandled-rejection warning in Node 16+
 * and a crash under strict modes. The unit tests only exercise sync throws,
 * so this guards the prod path against the async case that test stubs miss.
 */
function safeDispatch(
  transport: ITransportClient,
  event: string,
  payload: Record<string, unknown>,
  log: ((msg: string) => void) | undefined,
  context: string,
): void {
  // A logging sink that itself throws must never escalate into the telemetry
  // path: on the sync path it would escape this function, and inside the
  // async `.catch` it would become a fresh unhandled rejection — the very
  // failure mode this wrapper exists to prevent. Swallow any error from the
  // sink itself.
  const safeLog = (msg: string): void => {
    try {
      log?.(msg)
    } catch {
      /* logging is best-effort — never let the sink crash the daemon */
    }
  }

  try {
    const result = transport.request(event, payload) as unknown
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      ;(result as Promise<unknown>).catch((error: unknown) => {
        safeLog(`${context}: async rejection — ${error instanceof Error ? error.message : String(error)}`)
      })
    }
  } catch (error) {
    safeLog(`${context}: sync throw — ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Marker stamped on every synthetic event's `metadata`. `TaskRouter.routeLlmEvent`
 * inspects this and SKIPS the per-client `sendTo()` + `broadcastToProjectRoom()`
 * for synthetic events. Without the skip, the synthetic tool-call envelopes
 * leak into the CLI's streamed JSON output, the TUI live view, every MCP
 * client subscribed to the project, and the webui — surfacing internal
 * analytics plumbing as user-facing progress events.
 *
 * The internal accumulator + `onToolResult` hook chain still run (they're
 * gated separately in `routeLlmEvent`), so AnalyticsHook / CurateLogHandler /
 * QueryLogHandler get their inputs unchanged.
 */
export const SYNTHETIC_EVENT_METADATA = {_synthetic: true} as const

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
  safeDispatch(
    transport,
    LlmEventNames.TOOL_RESULT,
    {
      metadata: SYNTHETIC_EVENT_METADATA,
      result: JSON.stringify({applied: operations}),
      sessionId: SYNTHETIC_SESSION_ID,
      success: true,
      taskId,
      toolName: 'curate',
    },
    log,
    `synthetic curate toolResult emit failed for ${taskId}`,
  )
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

  // PR #728 review fix: emit each toolCall + a paired toolResult. The
  // accumulator's `TOOL_RESULT` branch (`task-router.ts` TOOL_RESULT case)
  // matches on `callId` and flips the running call to `completed`. Without
  // the pair, the accumulator persists `status: 'running'` forever and
  // task-history snapshots show the synthetic call stuck mid-flight.
  // Sharing the callId between the call and its result is what links them.
  const searchCallId = randomUUID()
  safeDispatch(
    transport,
    LlmEventNames.TOOL_CALL,
    {
      args: {
        cacheHit: metadata.cacheHit ?? null,
        matchedCount: matchedDocs.length,
        tier: metadata.tier,
        topScore: metadata.topScore,
        totalFound: metadata.totalFound,
      },
      callId: searchCallId,
      metadata: SYNTHETIC_EVENT_METADATA,
      sessionId: SYNTHETIC_SESSION_ID,
      taskId,
      toolName: 'search_knowledge',
    },
    log,
    `synthetic query search_knowledge toolCall emit failed for ${taskId}`,
  )
  safeDispatch(
    transport,
    LlmEventNames.TOOL_RESULT,
    {
      callId: searchCallId,
      metadata: SYNTHETIC_EVENT_METADATA,
      result: JSON.stringify({matched: matchedDocs.length, tier: metadata.tier}),
      sessionId: SYNTHETIC_SESSION_ID,
      success: true,
      taskId,
      toolName: 'search_knowledge',
    },
    log,
    `synthetic query search_knowledge toolResult emit failed for ${taskId}`,
  )

  for (const doc of matchedDocs) {
    const readCallId = randomUUID()
    safeDispatch(
      transport,
      LlmEventNames.TOOL_CALL,
      {
        args: {filePath: join(contextTreeRoot, doc.path)},
        callId: readCallId,
        metadata: SYNTHETIC_EVENT_METADATA,
        sessionId: SYNTHETIC_SESSION_ID,
        taskId,
        toolName: 'read_file',
      },
      log,
      `synthetic query read_file toolCall emit failed for ${taskId}`,
    )
    safeDispatch(
      transport,
      LlmEventNames.TOOL_RESULT,
      {
        callId: readCallId,
        metadata: SYNTHETIC_EVENT_METADATA,
        result: JSON.stringify({path: doc.path}),
        sessionId: SYNTHETIC_SESSION_ID,
        success: true,
        taskId,
        toolName: 'read_file',
      },
      log,
      `synthetic query read_file toolResult emit failed for ${taskId}`,
    )
  }
}
