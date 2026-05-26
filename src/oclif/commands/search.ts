/* eslint-disable camelcase */
import type {ITransportClient, TaskAck} from '@campfirein/brv-transport-client'

import {Args, Command, Flags} from '@oclif/core'
import {randomUUID} from 'node:crypto'

import type {SearchKnowledgeResult} from '../../agent/infra/sandbox/tools-sdk.js'

import {TaskEvents} from '../../shared/transport/events/index.js'
import {encodeSearchContent} from '../../shared/transport/search-content.js'
import {buildCliMetadata} from '../lib/build-cli-metadata.js'
import {
  type DaemonClientOptions,
  formatConnectionError,
  hasLeakedHandles,
  withDaemonRetry,
} from '../lib/daemon-client.js'
import {writeJsonResponse} from '../lib/json-response.js'
import {formatSearchTextOutput} from '../lib/search-format.js'
import {waitForTaskCompletion} from '../lib/task-client.js'

export default class Search extends Command {
  public static args = {
    query: Args.string({
      description: 'Search query to find relevant knowledge in the context tree',
      required: true,
    }),
  }
  public static description = `Search the context tree for relevant knowledge

Returns ranked results with paths, scores, and excerpts.
Pure BM25 retrieval — no LLM, no token cost.

Use this for structured results with file paths.
Use "brv query" when you need a synthesized answer.`
  public static examples = [
    '# Search for knowledge about authentication',
    '<%= config.bin %> <%= command.id %> "authentication"',
    '',
    '# Limit results and scope to a domain',
    '<%= config.bin %> <%= command.id %> "JWT tokens" --limit 5 --scope auth/',
    '',
    '# JSON output (for automation)',
    '<%= config.bin %> <%= command.id %> "auth" --format json',
  ]
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
    limit: Flags.integer({
      default: 10,
      description: 'Maximum number of results (1-50)',
      max: 50,
      min: 1,
    }),
    scope: Flags.string({
      description: 'Path prefix to scope results (e.g. "auth/" for auth domain only)',
    }),
  }
  public static strict = false

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    const {args, flags, metadata} = await this.parse(Search)
    const format: 'json' | 'text' = flags.format === 'json' ? 'json' : 'text'

    if (!this.validateInput(args.query, format)) return

    const cliMetadata = buildCliMetadata(this.id ?? 'search', {flags, metadata})

    try {
      await withDaemonRetry(
        async (client, projectRoot, worktreeRoot) => {
          // No provider validation — search is pure BM25, no LLM needed.
          await this.submitTask({
            client,
            cliMetadata,
            format,
            limit: flags.limit,
            projectRoot,
            query: args.query,
            scope: flags.scope,
            worktreeRoot,
          })
        },
        {
          ...this.getDaemonClientOptions(),
          onRetry:
            format === 'text'
              ? (attempt, maxRetries) =>
                  this.log(`\nConnection lost. Restarting daemon... (attempt ${attempt}/${maxRetries})`)
              : undefined,
        },
      )
    } catch (error) {
      this.reportError(error, format)
    }
  }

  private reportError(error: unknown, format: 'json' | 'text'): void {
    const errorMessage = error instanceof Error ? error.message : 'Search failed'

    if (format === 'json') {
      writeJsonResponse({command: 'search', data: {error: errorMessage, status: 'error'}, success: false})
    } else {
      this.log(formatConnectionError(error))
    }

    if (hasLeakedHandles(error)) {
      // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
      process.exit(1)
    }
  }

  private async submitTask(props: {
    client: ITransportClient
    cliMetadata: ReturnType<typeof buildCliMetadata>
    format: 'json' | 'text'
    limit?: number
    projectRoot?: string
    query: string
    scope?: string
    worktreeRoot?: string
  }): Promise<void> {
    const {client, cliMetadata, format, projectRoot, query, worktreeRoot} = props
    const taskId = randomUUID()

    const contentPayload = encodeSearchContent({limit: props.limit, query, scope: props.scope})

    const taskPayload = {
      cli_metadata: cliMetadata,
      clientCwd: process.cwd(),
      content: contentPayload,
      ...(projectRoot ? {projectPath: projectRoot} : {}),
      taskId,
      type: 'search' as const,
      ...(worktreeRoot ? {worktreeRoot} : {}),
    }

    const completionPromise = waitForTaskCompletion(
      {
        client,
        command: 'search',
        format,
        onCompleted: ({result}) => {
          if (!result) {
            if (format === 'json') {
              writeJsonResponse({
                command: 'search',
                data: {results: [], status: 'completed', totalFound: 0},
                success: true,
              })
            } else {
              this.log('\nNo results.\n')
            }

            return
          }

          try {
            const searchResult = JSON.parse(result) as SearchKnowledgeResult

            if (format === 'json') {
              writeJsonResponse({
                command: 'search',
                data: {
                  ...searchResult,
                  status: 'completed',
                },
                success: true,
              })
            } else {
              for (const line of formatSearchTextOutput(searchResult)) {
                this.log(line)
              }
            }
          } catch {
            // Fallback: result isn't valid JSON — display as-is
            if (format === 'json') {
              writeJsonResponse({
                command: 'search',
                data: {error: 'Invalid search result format', raw: result, status: 'error'},
                success: false,
              })
            } else {
              this.log(`\n${result}\n`)
            }
          }
        },
        onError({error}) {
          if (format === 'json') {
            writeJsonResponse({
              command: 'search',
              data: {event: 'error', message: error.message, status: 'error'},
              success: false,
            })
          }
        },
        taskId,
      },
      (msg) => this.log(msg),
    )

    await client.requestWithAck<TaskAck>(TaskEvents.CREATE, taskPayload)
    await completionPromise
  }

  private validateInput(query: string, format: 'json' | 'text'): boolean {
    if (query.trim()) return true

    if (format === 'json') {
      writeJsonResponse({
        command: 'search',
        data: {message: 'Search query is required.', status: 'error'},
        success: false,
      })
    } else {
      this.log('Search query is required.')
      this.log('Usage: brv search "your query here"')
    }

    return false
  }
}
