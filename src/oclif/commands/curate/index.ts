import {Args, Command, Flags} from '@oclif/core'

import {continueSession, kickoffSession, resolveProjectRoot} from '../../lib/curate-session.js'
import {type DaemonClientOptions} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'
import {DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS} from '../../lib/task-client.js'

/** Parsed flags type */
type CurateFlags = {
  detach?: boolean
  files?: string[]
  folder?: string[]
  format?: 'json' | 'text'
  overwrite?: boolean
  response?: string
  session?: string
  timeout?: number
}

export default class Curate extends Command {
  public static args = {
    context: Args.string({
      description: 'Knowledge context: patterns, decisions, errors, or insights',
      required: false,
    }),
  }
  public static description = `Curate context to the context tree

Good examples:
- "Auth uses JWT with 24h expiry. Tokens stored in httpOnly cookies via authMiddleware.ts"
- "API rate limit is 100 req/min per user. Implemented using Redis with sliding window in rateLimiter.ts"
Bad examples:
- "Authentication" or "JWT tokens" (too vague, lacks context)
- "Rate limiting" (no implementation details or file references)`
  public static examples = [
    '# Kickoff a curate session — calling agent drives the LLM step',
    '<%= config.bin %> <%= command.id %> "Auth uses JWT with 24h expiry. Tokens stored in httpOnly cookies via authMiddleware.ts" --format json',
    '',
    '# Continue an existing session with the calling agent\'s HTML response',
    '<%= config.bin %> <%= command.id %> --session <id> --response "<bv-topic>...</bv-topic>" --format json',
    '',
    '# Overwrite an existing topic on continuation (data-destructive — use deliberately)',
    '<%= config.bin %> <%= command.id %> --session <id> --response "..." --overwrite --format json',
  ]
  public static flags = {
    detach: Flags.boolean({
      default: false,
      description: 'Queue task and exit without waiting for completion',
    }),
    files: Flags.string({
      char: 'f',
      description: 'Include specific file paths for critical context (max 5 files)',
      multiple: true,
    }),
    folder: Flags.string({
      char: 'd',
      description: 'Folder path to pack and analyze (triggers folder pack flow)',
      multiple: true,
    }),
    format: Flags.string({
      default: 'text',
      description: 'Output format (text or json)',
      options: ['text', 'json'],
    }),
    overwrite: Flags.boolean({
      // Continuation only. When set, the orchestrator passes
      // `confirmOverwrite: true` to the writer, bypassing the
      // `path-exists` guard. The default (false) refuses to clobber an
      // existing topic; the calling agent receives a `correct-html`
      // step carrying the existing content for merging.
      default: false,
      description: 'Allow overwriting an existing topic on continuation (pairs with --session)',
    }),
    response: Flags.string({
      // Pairs with --session for continuation. The opaque text is
      // interpreted by the orchestrator per the step it last emitted
      // (HTML for generate-html / correct-html). Presence without
      // --session is rejected during validation.
      description: 'Continuation payload (paired with --session)',
    }),
    session: Flags.string({
      // Continuation: resumes an existing session by id. Presence of
      // --session implies the continuation step.
      description: 'Session id to continue (returned by a prior kickoff)',
    }),
    timeout: Flags.integer({
      default: DEFAULT_TIMEOUT_SECONDS,
      description: 'Maximum seconds to wait for task completion',
      max: MAX_TIMEOUT_SECONDS,
      min: MIN_TIMEOUT_SECONDS,
    }),
  }

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  public async run(): Promise<void> {
    // Tool mode is the default and only dispatch path. Calling agent
    // drives the LLM step end-to-end; ByteRover never invokes a
    // provider on this command. (The env-var `BRV_CURATE_TOOL_MODE`
    // scaffolding from M1 is removed in M3 — presence/absence is a
    // no-op now.)
    const {args, flags: rawFlags} = await this.parse(Curate)
    const flags: CurateFlags = {
      detach: rawFlags.detach,
      files: rawFlags.files,
      folder: rawFlags.folder,
      format: rawFlags.format === 'json' ? 'json' : rawFlags.format === 'text' ? 'text' : undefined,
      overwrite: rawFlags.overwrite,
      response: rawFlags.response,
      session: rawFlags.session,
      timeout: rawFlags.timeout,
    }
    const format: 'json' | 'text' = flags.format ?? 'text'

    // `--overwrite` is meaningful only on continuation. Reject early
    // so the user doesn't believe overwrite semantics took effect on
    // a kickoff (it'd be silently ignored otherwise).
    if (flags.overwrite && flags.session === undefined) {
      this.emitToolModeEnvelope(
        {
          errors: [
            {
              kind: 'invalid-flag-combination',
              message: '--overwrite requires --session (continuation). Remove it or pair it with --session <id>.',
            },
          ],
          ok: false,
          status: 'failed',
        },
        format,
      )
      return
    }

    if (flags.session !== undefined) {
      // Narrow at the call site so the handler doesn't need a
      // non-null assertion on flags.session.
      await this.handleContinuation({flags, format, sessionId: flags.session})
      return
    }

    await this.handleKickoff({args, format})
  }

  /**
   * Wire-envelope emitter. JSON mode dumps the envelope inside the
   * standard `{command, data, success, timestamp}` wrapper for
   * symmetry with the rest of the CLI. Text mode prints a terse
   * human-readable digest; the main consumer is the calling agent in
   * `--format json` mode.
   */
  private emitToolModeEnvelope(
    envelope: Awaited<ReturnType<typeof kickoffSession>>,
    format: 'json' | 'text',
  ): void {
    if (format === 'json') {
      writeJsonResponse({command: 'curate', data: envelope, success: envelope.ok})
      return
    }

    if (envelope.status === 'needs-llm-step') {
      this.log(
        `Session ${envelope.sessionId} awaiting ${envelope.step}. Run: brv curate --session ${envelope.sessionId} --response "<your output>"`,
      )
      if (envelope.prompt) {
        this.log('\nPrompt:')
        this.log(envelope.prompt)
      }
    } else if (envelope.status === 'done') {
      this.log(`✓ Curated to ${envelope.filePath}`)
    } else {
      this.log('✗ Curate failed')
      for (const err of envelope.errors ?? []) {
        this.log(`  ${err.kind}: ${err.message}`)
      }
    }
  }

  private async handleContinuation(props: {
    flags: CurateFlags
    format: 'json' | 'text'
    sessionId: string
  }): Promise<void> {
    const {flags, format, sessionId} = props
    if (flags.response === undefined) {
      this.emitToolModeEnvelope(
        {
          errors: [
            {
              kind: 'missing-response',
              message: '--session requires --response. Pass the calling agent\'s LLM output via --response.',
            },
          ],
          ok: false,
          status: 'failed',
        },
        format,
      )
      return
    }

    const envelope = await continueSession({
      confirmOverwrite: flags.overwrite ?? false,
      projectRoot: resolveProjectRoot(),
      response: flags.response,
      sessionId,
    })
    this.emitToolModeEnvelope(envelope, format)
  }

  /**
   * Kickoff: runs the in-CLI placeholder orchestrator and writes the
   * wire envelope to stdout. No daemon connection, no provider check
   * — tool mode never invokes the byterover LLM.
   */
  private async handleKickoff(props: {
    args: {context?: string}
    format: 'json' | 'text'
  }): Promise<void> {
    const {args, format} = props
    const content = args.context?.trim() ?? ''
    if (content.length === 0) {
      this.emitToolModeEnvelope(
        {
          errors: [{kind: 'missing-content', message: 'Curate kickoff requires a context argument.'}],
          ok: false,
          status: 'failed',
        },
        format,
      )
      return
    }

    const envelope = await kickoffSession({content, projectRoot: resolveProjectRoot()})
    this.emitToolModeEnvelope(envelope, format)
  }
}
