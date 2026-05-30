import {Args, Command, Flags} from '@oclif/core'

import type {CurateSessionEnvelope} from '../../lib/curate-session.js'

import {
  continueSession,
  deleteCurateResponseFile,
  InvalidResponseFileError,
  InvalidResponseFormatError,
  kickoffSession,
  loadCurateResponseFile,
  parseCurateResponse,
  peekCurateSession,
  resolveProjectRoot,
  unknownSessionEnvelope,
} from '../../lib/curate-session.js'
import {type DaemonClientOptions, formatConnectionError, withDaemonRetry} from '../../lib/daemon-client.js'
import {writeJsonResponse} from '../../lib/json-response.js'
import {argvRequestsJsonFormat, CURATE_REMOVED_FLAGS, findRemovedFlagMessage} from '../../lib/removed-flags.js'

/** Parsed flags type */
type CurateFlags = {
  deleteResponseFile?: boolean
  format?: 'json' | 'text'
  overwrite?: boolean
  response?: string
  responseFile?: string
  session?: string
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
    '# Continue an existing session with the calling agent\'s envelope',
    '<%= config.bin %> <%= command.id %> --session <id> --response \'{"html":"<bv-topic>...</bv-topic>","meta":{...}}\' --format json',
    '',
    '# Continue from a JSON file (mutually exclusive with --response)',
    '<%= config.bin %> <%= command.id %> --session <id> --response-file envelope.json --format json',
    '',
    '# Continue from a JSON file and clean it up after local validation succeeds',
    '<%= config.bin %> <%= command.id %> --session <id> --response-file envelope.json --delete-response-file --format json',
    '',
    '# Overwrite an existing topic on continuation (data-destructive — use deliberately)',
    '<%= config.bin %> <%= command.id %> --session <id> --response-file envelope.json --overwrite --format json',
  ]
  public static flags = {
    'delete-response-file': Flags.boolean({
      // Opt-in cleanup paired with --response-file. After the CLI has
      // successfully read, parsed, and envelope-validated the file
      // locally, unlink it before dispatching to the daemon. Local
      // validation failure leaves the file in place (the agent fixes the
      // envelope and retries). Unlink failure aborts the curate so we
      // never report success when the requested cleanup did not happen.
      default: false,
      description: 'After local validation succeeds, delete the file passed via --response-file (off by default)',
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
      description: 'Continuation payload (paired with --session). Mutually exclusive with --response-file',
    }),
    'response-file': Flags.string({
      // Alternative to --response. Lets agents author the envelope as a
      // plain JSON file (no shell escaping) and point the CLI at it.
      // Same continuation semantics; mutex'd against --response at
      // runtime so the structured envelope error is returned instead of
      // oclif's generic stderr line.
      description: 'Path to a JSON file containing the continuation envelope. Mutually exclusive with --response',
    }),
    session: Flags.string({
      // Continuation: resumes an existing session by id. Presence of
      // --session implies the continuation step.
      description: 'Session id to continue (returned by a prior kickoff)',
    }),
  }

  /** Unlink the response envelope file. Wrapped for test override. */
  protected async deleteResponseFile(filePath: string): Promise<void> {
    return deleteCurateResponseFile(filePath)
  }

  /**
   * Dispatch the validated continuation envelope to the daemon. Wraps
   * `withDaemonRetry` + `continueSession` so a subclass can short-circuit
   * the daemon round-trip in tests. Throws on transport / retry-cap
   * failure so the caller can map the error to a `daemon-error` envelope
   * AND skip the post-success unlink — that ordering is the load-bearing
   * invariant we want to test against future refactors.
   */
  protected async dispatchContinuation(args: {
    confirmOverwrite: boolean
    format: 'json' | 'text'
    projectRoot: string
    response: string
    sessionId: string
  }): Promise<CurateSessionEnvelope> {
    const {confirmOverwrite, format, projectRoot, response, sessionId} = args
    let envelope: CurateSessionEnvelope | undefined
    await withDaemonRetry(async (client) => {
      envelope = await continueSession({
        client,
        confirmOverwrite,
        format,
        projectRoot,
        response,
        sessionId,
      })
    }, this.getDaemonClientOptions())

    if (envelope === undefined) {
      throw new Error('Daemon dispatch returned no envelope.')
    }

    return envelope
  }

  protected getDaemonClientOptions(): DaemonClientOptions {
    return {}
  }

  /** Load the response envelope from disk. Wrapped for test override. */
  protected async loadResponseFile(filePath: string): Promise<string> {
    return loadCurateResponseFile(filePath)
  }

  /** Peek at on-disk session state without dispatching. Wrapped for test override. */
  protected async peekSession(
    projectRoot: string,
    sessionId: string,
  ): Promise<{kind: 'invalid-format'} | {kind: 'not-found'} | {kind: 'ok'}> {
    return peekCurateSession(projectRoot, sessionId)
  }

  /**
   * Resolve the absolute project root used for session-state lookups
   * and the daemon dispatch payload. Wrapped so test subclasses can
   * point at a tmpdir without spinning up the real workspace resolver.
   */
  protected resolveProjectRoot(): string {
    return resolveProjectRoot()
  }

  public async run(): Promise<void> {
    // Tool mode is the default and only dispatch path. Calling agent
    // drives the LLM step end-to-end; ByteRover never invokes a
    // provider on this command. (The env-var `BRV_CURATE_TOOL_MODE`
    // scaffolding from M1 is removed in M3 — presence/absence is a
    // no-op now.)
    // Use `this.argv` (set by oclif when the Command instance is
    // constructed) rather than `process.argv.slice(2)` so testable
    // subclasses can scope this check to their own argv without
    // colliding with the host process's argv (e.g. mocha's own flags).
    const rawArgv = this.argv
    const removedFlagMessage = findRemovedFlagMessage(rawArgv, CURATE_REMOVED_FLAGS)
    if (removedFlagMessage) {
      // Surface as a JSON envelope when the caller asked for JSON — agents
      // parsing stdout-JSON treat unexpected stderr lines as a hard crash.
      if (argvRequestsJsonFormat(rawArgv)) {
        this.emitToolModeEnvelope(
          {
            errors: [{kind: 'removed-flag', message: removedFlagMessage}],
            ok: false,
            status: 'failed',
          },
          'json',
        )
        return
      }

      this.error(removedFlagMessage, {exit: 1})
    }

    const {args, flags: rawFlags} = await this.parse(Curate)
    const flags: CurateFlags = {
      deleteResponseFile: rawFlags['delete-response-file'],
      format: rawFlags.format === 'json' ? 'json' : rawFlags.format === 'text' ? 'text' : undefined,
      overwrite: rawFlags.overwrite,
      response: rawFlags.response,
      responseFile: rawFlags['response-file'],
      session: rawFlags.session,
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

    // Same rejection for the continuation-only response/file flags.
    // Without this, `brv curate "intent" --response-file foo.json` would
    // run the kickoff and silently ignore the file — agents would think
    // they curated when they only registered a new session.
    const continuationFlag = pickKickoffMissingFlag(flags)
    if (flags.session === undefined && continuationFlag) {
      this.emitToolModeEnvelope(
        {
          errors: [
            {
              kind: 'invalid-flag-combination',
              message: `${continuationFlag} requires --session (continuation). Remove it or pair it with --session <id>.`,
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
        `Session ${envelope.sessionId} awaiting ${envelope.step}. Reply with the {html, meta?} JSON envelope via either:
  brv curate --session ${envelope.sessionId} --response '{"html":"<bv-topic>...</bv-topic>","meta":{...}}'
  brv curate --session ${envelope.sessionId} --response-file envelope.json [--delete-response-file]`,
      )
      if (envelope.prompt) {
        this.log('\nPrompt:')
        this.log(envelope.prompt)
      }
    } else if (envelope.status === 'done') {
      this.log(`✓ Curated to ${envelope.filePath}`)
      for (const warning of envelope.warnings ?? []) {
        this.log(`  ⚠ ${warning}`)
      }

      // A `done` envelope may also carry non-fatal companion errors —
      // today, the only producer is `--delete-response-file` cleanup
      // failure (the curate landed, but the unlink couldn't run). The
      // JSON surface puts these in `errors[]` so consumers can switch
      // on `kind` programmatically; text mode needs to surface them
      // too or `--format text` users miss the signal entirely.
      for (const err of envelope.errors ?? []) {
        this.log(`  ⚠ ${err.kind}: ${err.message}`)
      }
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

    // Flag combinations specific to the new --response-file / --delete-response-file
    // surfaces. We do these checks at runtime (rather than oclif's
    // declarative `exclusive: ['…']`) so the failure is a structured
    // envelope error agents can switch on, not a generic stderr line.
    if (flags.response !== undefined && flags.responseFile !== undefined) {
      this.emitToolModeEnvelope(
        {
          errors: [
            {
              kind: 'invalid-flag-combination',
              message: '--response and --response-file are mutually exclusive; pass exactly one.',
            },
          ],
          ok: false,
          status: 'failed',
        },
        format,
      )
      return
    }

    if (flags.deleteResponseFile && flags.responseFile === undefined) {
      this.emitToolModeEnvelope(
        {
          errors: [
            {
              kind: 'invalid-flag-combination',
              message: '--delete-response-file requires --response-file. Add --response-file <path> or drop the cleanup flag.',
            },
          ],
          ok: false,
          status: 'failed',
        },
        format,
      )
      return
    }

    if (flags.response === undefined && flags.responseFile === undefined) {
      this.emitToolModeEnvelope(
        {
          errors: [
            {
              kind: 'missing-response',
              message: '--session requires --response or --response-file. Pass the calling agent\'s envelope via one of them.',
            },
          ],
          ok: false,
          status: 'failed',
        },
        format,
      )
      return
    }

    // Resolve the response payload. When --response-file is set, read
    // the file via the regular-file-guarded helper; otherwise use the
    // inline --response string. File-IO errors surface as structured
    // envelope errors and abort the continuation before any daemon work.
    let response: string
    if (flags.responseFile === undefined) {
      // Narrowed by the combination checks above — when responseFile is
      // undefined we already returned early unless response was set.
      response = flags.response ?? ''
    } else {
      try {
        response = await this.loadResponseFile(flags.responseFile)
      } catch (error) {
        if (error instanceof InvalidResponseFileError) {
          this.emitToolModeEnvelope(
            {
              errors: [{kind: error.kind, message: error.message}],
              ok: false,
              status: 'failed',
            },
            format,
          )
          return
        }

        throw error
      }
    }

    // Pre-dispatch validation. We do these checks LOCALLY (before any
    // daemon connect) so a malformed envelope or an unknown session
    // never wastes daemon I/O. continueSession re-parses and re-reads
    // the session itself; the duplicate work is microseconds and keeps
    // that function authoritative.

    // 1. Empty / whitespace-only payload. Match continueSession's
    //    `empty-response` kind (transient — session stays live so the
    //    caller can retry with the same sessionId) instead of letting
    //    JSON.parse coerce this into a terminal `invalid-response-format`.
    if (response.trim().length === 0) {
      this.emitToolModeEnvelope(
        {
          errors: [{kind: 'empty-response', message: 'Continuation --response must be non-empty.'}],
          ok: false,
          sessionId,
          status: 'failed',
        },
        format,
      )
      return
    }

    // 2. Envelope shape. parseCurateResponse throws InvalidResponseFormatError
    //    on JSON failure / schema failure.
    const projectRoot = this.resolveProjectRoot()
    try {
      parseCurateResponse(response)
    } catch (error) {
      if (error instanceof InvalidResponseFormatError) {
        this.emitToolModeEnvelope(
          {
            errors: [{kind: error.kind, message: error.message}],
            ok: false,
            sessionId,
            status: 'failed',
          },
          format,
        )
        return
      }

      throw error
    }

    // 3. Session existence (UUID format + on-disk state). If the
    //    session is unknown locally, we emit the same envelope
    //    continueSession would, with NO file mutation.
    const lookup = await this.peekSession(projectRoot, sessionId)
    if (lookup.kind !== 'ok') {
      this.emitToolModeEnvelope(unknownSessionEnvelope(sessionId, lookup.kind), format)
      return
    }

    // Local validation passed. Dispatch to the daemon — the write,
    // log, sidecar, and index regeneration all happen there. We
    // surface throws from `dispatchContinuation` as a `daemon-error`
    // envelope; crucially, the `--response-file` is NOT unlinked on
    // this path so the agent retains the source it already paid an
    // LLM call to produce.
    const confirmOverwrite = flags.overwrite ?? false
    let dispatchEnvelope: CurateSessionEnvelope
    try {
      dispatchEnvelope = await this.dispatchContinuation({
        confirmOverwrite,
        format,
        projectRoot,
        response,
        sessionId,
      })
    } catch (error) {
      this.emitToolModeEnvelope(
        {
          errors: [{kind: 'daemon-error', message: formatConnectionError(error)}],
          ok: false,
          status: 'failed',
        },
        format,
      )
      return
    }

    // Non-throw dispatch. Honor --delete-response-file: the daemon
    // received the bytes (whether the curate landed `done`, was rejected
    // with `correct-html`, or otherwise), so the file has served its
    // purpose. Skip-on-throw above is what protects the agent from
    // losing its envelope to a transport error.
    //
    // On unlink failure we surface the dispatch result with the cleanup
    // failure APPENDED TO `errors[]` — not warnings. The reason: a
    // structured `kind: 'response-file-delete-error'` lets consumers
    // switch on the field programmatically and remains discoverable on
    // both `status: done` (curate landed, cleanup hiccupped) and
    // `status: failed` (validation already populated `errors[]`; we
    // just append). The `ok`/`status` fields stay as the daemon set
    // them, so "curate succeeded but cleanup didn't" is a clean
    // (`ok: true`, `status: 'done'`, non-empty `errors[]`) shape.
    if (flags.deleteResponseFile && flags.responseFile !== undefined) {
      try {
        await this.deleteResponseFile(flags.responseFile)
      } catch (error) {
        if (error instanceof InvalidResponseFileError) {
          this.emitToolModeEnvelope(
            {
              ...dispatchEnvelope,
              errors: [
                ...(dispatchEnvelope.errors ?? []),
                {kind: error.kind, message: error.message},
              ],
            },
            format,
          )
          return
        }

        throw error
      }
    }

    this.emitToolModeEnvelope(dispatchEnvelope, format)
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

/**
 * Return the first continuation-only flag (in priority order) that the
 * caller used without `--session`. Returns `undefined` when none are
 * set. The result is the user-facing flag name (with the `--` prefix)
 * so we can drop it straight into the error message.
 *
 * `--overwrite` has its own pre-existing check above and is excluded
 * here to avoid double-emission.
 */
function pickKickoffMissingFlag(flags: CurateFlags): string | undefined {
  if (flags.response !== undefined) return '--response'
  if (flags.responseFile !== undefined) return '--response-file'
  if (flags.deleteResponseFile) return '--delete-response-file'
  return undefined
}
