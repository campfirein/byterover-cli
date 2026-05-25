import type {ITransportClient} from '@campfirein/brv-transport-client'
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'

import {waitForConnectedClient} from '@campfirein/brv-transport-client'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'

import type {
  QueryToolModeMatchedDoc,
  QueryToolModeResult,
} from '../../../core/interfaces/executor/i-query-executor.js'

import {encodeQueryToolModeContent} from '../../../../shared/transport/query-tool-mode-content.js'
import {TransportTaskEventNames} from '../../../core/domain/transport/schemas.js'
import {appendDriftFooter} from './drift-footer.js'
import {associateProjectWithRetry, type McpStartupProjectContext, resolveMcpTaskContext} from './mcp-project-context.js'
import {resolveClientCwd} from './resolve-client-cwd.js'
import {cwdField} from './shared-schema.js'
import {waitForTaskResult} from './task-result-waiter.js'

export const BrvQueryInputSchema = z.object({
  cwd: cwdField,
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe('Maximum number of matched topics to return (1-50, default 10).'),
  query: z.string().describe('Natural language question about the codebase or project'),
})

/**
 * Registers the brv-query tool with the MCP server.
 *
 * Post-M3: routes through the daemon's `query-tool-mode` task type
 * (`QueryExecutor.executeToolMode`), which runs Tier 0/1 cache + BM25
 * retrieval with no LLM dispatch. **No byterover provider is required.**
 *
 * Wire shape: same as the post-ENG-2815 `brv query` CLI — the daemon
 * returns a JSON-encoded `QueryToolModeResult` envelope; this tool
 * parses it and renders matched topics as markdown sections for the
 * calling agent. On `no-matches` it returns a short text block (not
 * `isError`) — zero matches is data, not a failure.
 */
export function registerBrvQueryTool(
  server: McpServer,
  getClient: () => ITransportClient | undefined,
  getWorkingDirectory: () => string | undefined,
  getStartupProjectContext: () => McpStartupProjectContext | undefined,
  clientVersion: string,
): void {
  server.registerTool(
    'brv-query',
    {
      description:
        'Query the ByteRover context tree for patterns, decisions, or implementation details. ' +
        'Runs deterministic BM25 retrieval — no LLM provider required. ' +
        'Returns ranked topics with rendered markdown; the calling agent synthesises the answer in its own context.',
      inputSchema: BrvQueryInputSchema,
      title: 'ByteRover Query',
    },
    async ({cwd, limit, query}: {cwd?: string; limit?: number; query: string}) => {
      // Resolve clientCwd: explicit cwd param > server working directory
      const cwdResult = resolveClientCwd(cwd, getWorkingDirectory)
      if (!cwdResult.success) {
        return {
          content: [{text: cwdResult.error, type: 'text' as const}],
          isError: true,
        }
      }

      // Wait for a connected client (MCP's attemptReconnect() replaces client in background)
      const client = await waitForConnectedClient(getClient)
      if (!client) {
        return {
          content: [
            {
              text: 'Error: Not connected to the daemon. Connection timed out. Ensure "brv" is running.',
              type: 'text' as const,
            },
          ],
          isError: true,
        }
      }

      try {
        const taskContext = resolveMcpTaskContext(cwdResult.clientCwd, getStartupProjectContext())
        if (!getWorkingDirectory()) {
          await associateProjectWithRetry(client, taskContext.projectRoot)
        }

        const taskId = randomUUID()

        // Register event listeners BEFORE sending task:create to avoid race conditions.
        // If the task completes before listeners are set up, the task:completed event is missed.
        const resultPromise = waitForTaskResult(client, taskId)

        // Dispatch `query-tool-mode` (post-M3 default). Content is the
        // JSON-encoded payload; daemon decodes via decodeQueryToolModeContent.
        await client.requestWithAck(TransportTaskEventNames.CREATE, {
          clientCwd: cwdResult.clientCwd,
          content: encodeQueryToolModeContent({limit, query}),
          projectPath: taskContext.projectRoot,
          taskId,
          type: 'query-tool-mode',
          worktreeRoot: taskContext.worktreeRoot,
        })

        const rawResult = await resultPromise

        // Parse the envelope. A malformed payload almost certainly means
        // the daemon and MCP build are on incompatible versions — surface
        // a clear actionable message rather than a JSON.parse stack.
        let envelope: QueryToolModeResult
        try {
          envelope = JSON.parse(rawResult) as QueryToolModeResult
        } catch {
          return {
            content: [
              {
                text: 'Error: ByteRover daemon returned a malformed query result. Rebuild byterover-cli to align the MCP and daemon versions.',
                type: 'text' as const,
              },
            ],
            isError: true,
          }
        }

        const text = renderEnvelope(envelope, query)
        return {
          content: [{text: appendDriftFooter(text, clientVersion, client.getDaemonVersion?.()), type: 'text' as const}],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          content: [{text: `Error: ${message}`, type: 'text' as const}],
          isError: true,
        }
      }
    },
  )
}

/**
 * Render the `QueryToolModeResult` envelope as a single text block.
 *
 * - `status: 'ok'` → one `## <title>` (or `## <path>`) section per match
 *   with the `rendered_md` body, separated by `\n\n---\n\n`, plus a
 *   trailing italicised metadata line covering match count, duration,
 *   and tier.
 * - `status: 'no-matches'` → a short single-line message naming the
 *   query so the calling agent can quote it back to the user.
 */
function renderEnvelope(envelope: QueryToolModeResult, query: string): string {
  if (envelope.status === 'no-matches') {
    return `No topics matched "${query}" in this project's context tree.`
  }

  const sections = envelope.matchedDocs.map((doc) => renderMatch(doc)).join('\n\n---\n\n')
  const {metadata} = envelope
  const trailer = `_Matched ${envelope.matchedDocs.length} topic(s) in ${metadata.durationMs}ms (tier ${metadata.tier})._`
  return `${sections}\n\n${trailer}`
}

function renderMatch(doc: QueryToolModeMatchedDoc): string {
  const heading = doc.title.trim().length > 0 ? doc.title : doc.path
  return `## ${heading}\n\n${doc.rendered_md}`
}
