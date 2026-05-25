import {Args, Command, Flags} from '@oclif/core'

import {formatDirectResponse} from '../../server/infra/executor/direct-search-responder.js'
import {
  type DaemonClientOptions,
  formatConnectionError,
  hasLeakedHandles,
  withDaemonRetry,
} from '../lib/daemon-client.js'
import {writeJsonResponse} from '../lib/json-response.js'
import {type QueryToolModeEnvelope, runRetrieval} from '../lib/query-retrieval.js'
import {DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS} from '../lib/task-client.js'

/** Default match cap. Locked to 10 (matches `brv search`). */
const DEFAULT_QUERY_LIMIT = 10
const MIN_QUERY_LIMIT = 1
const MAX_QUERY_LIMIT = 50

export default class Query extends Command {
  public static args = {
    query: Args.string({
      description: 'Natural language question about your codebase or project knowledge',
      required: true,
    }),
  }
  public static description = `Query and retrieve information from the context tree

Good:
- "How is user authentication implemented?"
- "What are the API rate limits and where are they enforced?"
Bad:
- "auth" or "authentication" (too vague, not a question)
- "show me code" (not specific about what information is needed)`
  public static examples = [
    '# Ask questions about patterns, decisions, or implementation details',
    '<%= config.bin %> <%= command.id %> What are the coding standards?',
    '<%= config.bin %> <%= command.id %> How is authentication implemented?',
    '',
    '# JSON output (for automation)',
    '<%= config.bin %> <%= command.id %> "How does auth work?" --format json',
  ]
  public static flags = {
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
    limit: Flags.integer({
      default: DEFAULT_QUERY_LIMIT,
      description: `Maximum matches (${MIN_QUERY_LIMIT}-${MAX_QUERY_LIMIT})`,
      max: MAX_QUERY_LIMIT,
      min: MIN_QUERY_LIMIT,
    }),
    timeout: Flags.integer({
      default: DEFAULT_TIMEOUT_SECONDS,
      description: 'Maximum seconds to wait for task completion',
      max: MAX_TIMEOUT_SECONDS,
      min: MIN_TIMEOUT_SECONDS,
    }),
  }
  public static strict = false

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    // Tool mode is the default and only path. Deterministic BM25
    // retrieval + render; no LLM. ByteRover never invokes a provider
    // on this command. (The env-var `BRV_QUERY_TOOL_MODE` scaffolding
    // from M2 is removed in M3 — presence/absence is a no-op now.)
    const {args, flags: rawFlags} = await this.parse(Query)
    const format: 'json' | 'text' = rawFlags.format === 'json' ? 'json' : 'text'
    const limit = rawFlags.limit ?? DEFAULT_QUERY_LIMIT

    if (args.query.trim().length === 0) {
      if (format === 'json') {
        writeJsonResponse({
          command: 'query',
          data: {error: 'Query requires a question argument.', status: 'error'},
          success: false,
        })
      } else {
        this.log('Query argument is required.')
        this.log('Usage: brv query "your question here"')
      }

      return
    }

    try {
      await withDaemonRetry(async (client) => {
        const envelope = await runRetrieval({client, limit, query: args.query})
        this.emitEnvelope(envelope, format, args.query)
      }, this.getDaemonClientOptions())
    } catch (error) {
      this.reportError(error, format)
    }
  }

  /**
   * Wire-envelope emitter. JSON mode wraps the envelope in the
   * standard CLI envelope ({command, data, success, timestamp}). Text
   * mode prints a human-readable digest via the existing direct-response
   * formatter — the primary consumer is the calling agent in
   * `--format json` mode.
   */
  private emitEnvelope(envelope: QueryToolModeEnvelope, format: 'json' | 'text', query: string): void {
    if (format === 'json') {
      writeJsonResponse({command: 'query', data: envelope, success: true})
      return
    }

    if (envelope.status === 'no-matches') {
      this.log('No matches.')
      return
    }

    const directResults = envelope.matchedDocs.map((m) => ({
      content: m.rendered_md,
      path: m.path,
      score: m.score,
      title: m.title,
    }))
    this.log(formatDirectResponse(query, directResults))
  }

  private reportError(error: unknown, format: 'json' | 'text'): void {
    const errorMessage = error instanceof Error ? error.message : 'Query failed'

    if (format === 'json') {
      writeJsonResponse({command: 'query', data: {error: errorMessage, status: 'error'}, success: false})
    } else {
      this.log(formatConnectionError(error))
    }

    if (hasLeakedHandles(error)) {
      // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
      process.exit(1)
    }
  }
}
