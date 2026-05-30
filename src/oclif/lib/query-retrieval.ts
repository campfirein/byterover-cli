/**
 * Tool-mode query CLI dispatcher.
 *
 * Background. `brv query` legacy path runs Tier-0/1/2/3/4 inside the
 * daemon, with Tier 3 and Tier 4 invoking byterover's own LLM. Tool
 * mode removes those tiers: the calling agent owns synthesis,
 * byterover just retrieves + renders. No LLM lives inside byterover
 * on this path.
 *
 * Architecture: the CLI dispatches a `type: 'query-tool-mode'` task
 * to the daemon. The daemon's `QueryExecutor.executeToolMode` builds
 * the wire envelope (Tier 0/1 cache + Tier-2 retrieval, no canRespondDirectly
 * gate, supplementEntitySearches preserved). This module is a thin
 * client — no retrieval logic lives here.
 *
 * One-shot (unlike curate's session loop). No session, no
 * continuation, no state on disk.
 *
 * Stability promise. Wire envelope keys are part of the public
 * contract once SKILL.md ships against this shape. Renaming any key
 * is a breaking change. The canonical type declarations live in
 * `src/server/core/interfaces/executor/i-query-executor.ts`; the
 * agent-facing protocol is documented in the bundled SKILL.md
 * (section 1, "Tool mode — run query without an LLM provider").
 */

import type {ITransportClient, TaskAck} from '@campfirein/brv-transport-client'

import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import type {QueryToolModeResult} from '../../server/core/interfaces/executor/i-query-executor.js'

import {renderHtmlTopicForLlm} from '../../server/infra/render/reader/html-renderer.js'
import {TaskEvents} from '../../shared/transport/events/index.js'
import {encodeQueryToolModeContent} from '../../shared/transport/query-tool-mode-content.js'
import {waitForTaskCompletion} from './task-client.js'

// Re-export the shared types so existing CLI consumers (query.ts,
// tests) import from one canonical CLI-side location. The server side
// owns the type definitions because it builds the envelope.
export type {
  QueryToolModeMatchedDoc,
  QueryToolModeMetadata,
  QueryToolModeResult,
} from '../../server/core/interfaces/executor/i-query-executor.js'

/**
 * Backwards-compatible alias. New code should use
 * `QueryToolModeResult`.
 */
export type QueryToolModeEnvelope = QueryToolModeResult

type RunRetrievalOptions = {
  client: ITransportClient
  /** Max matches to return. Bounded 1-50 by the CLI flag. */
  limit: number
  /** User question, verbatim. */
  query: string
}

/**
 * Submit a `type: 'query-tool-mode'` task to the daemon, wait for
 * completion, parse the JSON envelope. Daemon-side errors (index
 * unavailable, transport timeout) bubble up as thrown Errors so the
 * CLI dispatcher can map to the outer `success: false` envelope.
 */
export async function runRetrieval(options: RunRetrievalOptions): Promise<QueryToolModeResult> {
  const {client, limit, query} = options
  const taskId = randomUUID()
  const taskPayload = {
    clientCwd: process.cwd(),
    content: encodeQueryToolModeContent({limit, query}),
    taskId,
    type: 'query-tool-mode' as const,
  }

  let parsed: QueryToolModeResult | undefined
  let errorMessage: string | undefined

  const completion = waitForTaskCompletion(
    {
      client,
      command: 'query',
      format: 'json',
      onCompleted({result}) {
        if (!result) {
          errorMessage = 'Daemon returned an empty tool-mode result.'
          return
        }

        try {
          parsed = JSON.parse(result) as QueryToolModeResult
        } catch {
          errorMessage = 'Daemon returned a malformed tool-mode result.'
        }
      },
      onError({error}) {
        errorMessage = error.message
      },
      taskId,
    },
    () => {
      // No-op log sink: tool mode emits one envelope, not progress lines.
    },
  )

  await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
  await completion

  if (errorMessage) throw new Error(errorMessage)
  if (!parsed) throw new Error('Daemon tool-mode query returned no payload.')
  return parsed
}

/**
 * Read the full bytes of a context-tree topic and prepare the rendered
 * markdown view (HTML topics post-`renderHtmlTopicForLlm`, markdown
 * topics pass through). Returns `undefined` on read failure.
 *
 * Retained from the earlier CLI-side retrieval path because tests
 * still depend on it. Production callers now go through the daemon
 * (`runRetrieval`) which renders server-side via the same
 * `renderHtmlTopicForLlm` helper.
 */
export async function readMatchContent(
  contextTreeRoot: string,
  relPath: string,
): Promise<undefined | {format: 'html' | 'markdown'; rawContent: string; renderedContent: string}> {
  const fullPath = join(contextTreeRoot, relPath)
  let raw: string
  try {
    raw = await readFile(fullPath, 'utf8')
  } catch {
    return undefined
  }

  const format: 'html' | 'markdown' = relPath.toLowerCase().endsWith('.html') ? 'html' : 'markdown'
  const renderedContent = format === 'html' ? renderHtmlTopicForLlm(raw) : raw
  return {format, rawContent: raw, renderedContent}
}
