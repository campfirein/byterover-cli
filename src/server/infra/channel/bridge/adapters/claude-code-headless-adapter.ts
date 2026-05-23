/* eslint-disable camelcase */
// Claude stream-json event field names are snake_case per the claude CLI
// wire format.

/**
 * Phase 9.5.3 — `ClaudeCodeHeadlessAdapter` drives Claude Code in
 * headless mode by spawning `claude -p` per inbound parley query and
 * parsing `--output-format stream-json` output.
 *
 * **Security gate:** this adapter is registered ONLY when
 * `BRV_BRIDGE_CLAUDE_UNSAFE=1` is set in the daemon environment.
 * It spawns `claude --dangerously-skip-permissions`, which allows a
 * verified remote prompt to drive the local Claude Code process with the
 * local filesystem and process permissions. Operators should run this
 * only on a dedicated VM or sandbox. Default-off prevents demos from
 * accidentally enabling the security hole (plan §2.5, codex round-1 #1).
 *
 * Subprocess invocation per inbound turn:
 *   claude -p --output-format stream-json --dangerously-skip-permissions \
 *     --cwd <projectRoot> [--resume <sessionId>]
 * Prompt is piped to STDIN (not passed on the command line) to avoid
 * hitting ARG_MAX on large prompts.
 *
 * Session IDs are persisted across turns via `ParleyAdapterSessionStore`
 * so `--resume` can continue the same Claude Code conversation. A stale
 * session-id (claude exits with "session not found" in stderr) triggers
 * a single retry without `--resume`.
 *
 * Subprocess hang on a dead libp2p substream is avoided by wiring
 * `ctx.abortSignal` to SIGTERM the child.
 */

import {type ChildProcess, spawn as nodeSpawn, type SpawnOptionsWithoutStdio, spawnSync} from 'node:child_process'
import {z} from 'zod'

import {type ParleyAdapterSessionStore} from '../parley-adapter-session-store.js'
import {type AdapterWarmResult, type ParleyAdapter, type ParleyAdapterContext} from '../parley-adapter.js'
import {type ParleyResponseDataChunk, ParleyResponseError} from '../parley-response-generator.js'
import {type ProfileConcurrencyGate} from '../profile-concurrency-gate.js'

// ─── stream-json event schemas ────────────────────────────────────────────────

const SystemInitEventSchema = z.object({
  session_id: z.string(),
  subtype: z.literal('init'),
  type: z.literal('system'),
})

const ContentTextBlockSchema = z.object({
  text: z.string(),
  type: z.literal('text'),
})

const ContentToolUseBlockSchema = z.object({
  input: z.unknown(),
  name: z.string(),
  type: z.literal('tool_use'),
})

const ContentBlockSchema = z.union([ContentTextBlockSchema, ContentToolUseBlockSchema])

const AssistantEventSchema = z.object({
  message: z.object({
    content: z.array(ContentBlockSchema),
  }),
  type: z.literal('assistant'),
})

const ResultEventSchema = z.object({
  is_error: z.boolean().optional(),
  session_id: z.string().optional(),
  type: z.literal('result'),
})

const StreamJsonEventSchema = z.union([
  SystemInitEventSchema,
  AssistantEventSchema,
  ResultEventSchema,
  // Catch-all for events we don't handle (user, tool_result, etc.).
  z.object({type: z.string()}).passthrough(),
])

type StreamJsonEvent = z.infer<typeof StreamJsonEventSchema>

// ─── adapter args ─────────────────────────────────────────────────────────────

export interface ClaudeCodeHeadlessAdapterArgs {
  /** The `claude` binary to invoke. Defaults to `'claude'`. Overridable for tests. */
  readonly claudeBinary?: string
  readonly concurrencyGate: ProfileConcurrencyGate
  readonly log: (msg: string) => void
  /** Override binary existence probe for tests. */
  readonly pathProbe?: (binary: string) => Promise<boolean>
  readonly sessionStore: ParleyAdapterSessionStore
  /** Override `node:child_process.spawn` for tests. */
  readonly spawn?: (
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio,
  ) => ChildProcess
}

// ─── stale-session detection ──────────────────────────────────────────────────

const STALE_SESSION_PATTERNS = [
  /session not found/i,
  /invalid session/i,
  /session.*does not exist/i,
  /no such session/i,
]

function isStaleSessionError(stderr: string): boolean {
  return STALE_SESSION_PATTERNS.some((re) => re.test(stderr))
}

// ─── adapter ─────────────────────────────────────────────────────────────────

export class ClaudeCodeHeadlessAdapter implements ParleyAdapter {
  public readonly kind = 'sdk-headless' as const
  public readonly profile = 'claude-code'
private readonly claudeBinary: string
  private readonly concurrencyGate: ProfileConcurrencyGate
  private readonly log: (msg: string) => void
  private readonly pathProbeFn: (binary: string) => Promise<boolean>
  private readonly sessionStore: ParleyAdapterSessionStore
  private readonly spawnFn: (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcess

  public constructor(args: ClaudeCodeHeadlessAdapterArgs) {
    this.claudeBinary = args.claudeBinary ?? 'claude'
    this.concurrencyGate = args.concurrencyGate
    this.log = args.log
    this.sessionStore = args.sessionStore
    this.spawnFn = args.spawn ?? nodeSpawn
    this.pathProbeFn = args.pathProbe ?? defaultPathProbe
  }

  public async *generate(ctx: ParleyAdapterContext): AsyncIterable<ParleyResponseDataChunk> {
    const release = await this.concurrencyGate.acquire(this.profile)
    try {
      // The request may have aborted while queued on the gate. With cap=1 a
      // slow request can hold the slot long enough for a peer to dead-stream
      // / Ctrl-C / heartbeat-fail before we even reach spawn. Honour the
      // signal post-acquire so we don't fire up `claude` for an already-
      // gone request. (codex round-4 finding.)
      if (ctx.abortSignal.aborted) {
        this.log(`[claude-code] request aborted while queued — skipping spawn (channelId=${ctx.channelId})`)
        return
      }

      yield* this.generateWithRelease(ctx)
    } finally {
      release()
    }
  }

  public async shutdown(): Promise<void> {
    // No long-running state — each turn spawns its own subprocess.
  }

  public async warm(): Promise<AdapterWarmResult> {
    const available = await this.pathProbeFn(this.claudeBinary)
    if (!available) {
      return {available: false, reason: `claude binary not on PATH (looked for "${this.claudeBinary}")`}
    }

    return {available: true}
  }

  private async *generateWithRelease(ctx: ParleyAdapterContext): AsyncIterable<ParleyResponseDataChunk> {
    const sessionKey = {
      adapterProfile: this.profile,
      channelId: ctx.channelId,
      projectRoot: ctx.projectRoot,
      senderPeerId: ctx.senderPeerId,
    }
    const existingSessionId = this.sessionStore.get(sessionKey)

    yield* this.runOnce(ctx, sessionKey, existingSessionId, false)
  }

  // eslint-disable-next-line complexity -- subprocess lifecycle generator; complexity is inherent in the event-to-chunk projection
  private async *runOnce(
    ctx: ParleyAdapterContext,
    sessionKey: {adapterProfile: string; channelId: string; projectRoot: string; senderPeerId: string},
    sessionId: string | undefined,
    isRetry: boolean,
  ): AsyncIterable<ParleyResponseDataChunk> {
    const prompt = ctx.envelope.prompt.map((b) => b.text).join('\n')
    const spawnArgs = buildSpawnArgs(sessionId)

    // Second abort check: between acquire-time and now we may have done
    // additional awaits (sessionStore.get, etc.). If the signal fired in
    // that window we must NOT spawn — same rationale as the post-acquire
    // check in generate(). (codex round-4 finding.)
    if (ctx.abortSignal.aborted) {
      this.log(`[claude-code] request aborted before spawn — bailing (channelId=${ctx.channelId})`)
      return
    }

    this.log(
      `[claude-code] spawning: ${this.claudeBinary} ${spawnArgs.join(' ')} ` +
      `(cwd=${ctx.projectRoot}, session=${sessionId ?? 'new'}, retry=${isRetry})`,
    )

    const child = this.spawnFn(this.claudeBinary, spawnArgs, {
      cwd: ctx.projectRoot,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    // Wire abort signal to SIGTERM.
    let abortFired = false
    const onAbort = (): void => {
      abortFired = true
      child.kill('SIGTERM')
    }

    ctx.abortSignal.addEventListener('abort', onAbort, {once: true})

    // Pipe the prompt via STDIN to avoid ARG_MAX limits on large prompts.
    child.stdin?.end(prompt, 'utf8')

    // Collect stdout lines for stream-json parsing.
    // Collect stderr for error reporting.
    let stdoutBuffer = ''
    const stderrChunks: string[] = []

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'))
    })

    // We yield chunks as we parse them from stdout.
    // But since spawn is event-based and AsyncIterable must work via
    // a pull model, we use a queue with a signal.
    type QueueItem =
      | {chunk: ParleyResponseDataChunk; kind: 'chunk';}
      | {code: null | number; kind: 'exit';}
      | {error: Error; kind: 'spawn_error'}
      | {kind: 'abort'}
      | {kind: 'result_error'}
      | {kind: 'result_success'; newSessionId: string | undefined}

    const queue: QueueItem[] = []
    let notify: (() => void) | undefined
    let streamDone = false

    function enqueue(item: QueueItem): void {
      queue.push(item)
      notify?.()
    }

    // Fix 9.5.3 (codex K79P0sTCkPTOaaZefPoh1 Fix 2b): listen for spawn
    // errors after enqueue is defined so ENOENT / EACCES is caught and
    // translated into a proper ParleyResponseError rather than crashing
    // as an unhandled child_process error event at query time.
    child.on('error', (spawnError: Error) => {
      streamDone = true
      enqueue({error: spawnError, kind: 'spawn_error'})
    })

    // Captured session ID from the system init event.
    let newSessionId: string | undefined

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString('utf8')
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue

        let parsed: unknown
        try {
          parsed = JSON.parse(trimmed)
        } catch {
          // Not valid JSON — skip.
          continue
        }

        const result = StreamJsonEventSchema.safeParse(parsed)
        if (!result.success) continue

        const event: StreamJsonEvent = result.data
        processEvent(event)
      }
    })

    function processEvent(event: StreamJsonEvent): void {
      const systemInit = SystemInitEventSchema.safeParse(event)
      if (systemInit.success) {
        newSessionId = systemInit.data.session_id
        return
      }

      const assistant = AssistantEventSchema.safeParse(event)
      if (assistant.success) {
        for (const block of assistant.data.message.content) {
          if (block.type === 'text') {
            enqueue({chunk: {content: block.text, kind: 'agent_message_chunk'}, kind: 'chunk'})
          } else if (block.type === 'tool_use') {
            // Placeholder per plan §2.5 — real permission passthrough is a follow-up (§3.7).
            enqueue({chunk: {content: `[tool_use: ${block.name}]`, kind: 'agent_thought_chunk'}, kind: 'chunk'})
          }
        }

        return
      }

      const resultEv = ResultEventSchema.safeParse(event)
      if (resultEv.success) {
        if (resultEv.data.is_error === true) {
          enqueue({kind: 'result_error'})
        } else {
          enqueue({kind: 'result_success', newSessionId: resultEv.data.session_id ?? newSessionId})
        }
      }
    }

    let resultReceived = false
    let resultError = false
    let resultSessionId: string | undefined
    let spawnErr: Error | undefined

    child.on('close', (code) => {
      streamDone = true
      enqueue({code, kind: 'exit'})
    })

    // Drive the queue via async iterator.
    // Intentional no-await-in-loop: each iteration polls a single
    // event-driven async queue; this is not a batch-of-independent-promises
    // case and can't be restructured without losing the generator semantics.
    try {
      while (true) {
        if (queue.length === 0) {
          if (streamDone) break
          // Wait for the next item.
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((res) => {
            notify = res
          })
          notify = undefined
        }

        const item = queue.shift()
        if (item === undefined) continue

        // eslint-disable-next-line unicorn/prefer-switch -- labeled continue/break not possible in switch inside generator
        if (item.kind === 'chunk') {
          yield item.chunk
        } else if (item.kind === 'result_success') {
          resultReceived = true
          resultSessionId = item.newSessionId
          break
        } else if (item.kind === 'result_error') {
          resultError = true
          break
        } else if (item.kind === 'exit') {
          flushStdoutBuffer(stdoutBuffer, processEvent)
          break
        } else if (item.kind === 'spawn_error') {
          spawnErr = item.error
          break
        } else if (item.kind === 'abort') {
          break
        }
      }
    } finally {
      ctx.abortSignal.removeEventListener('abort', onAbort)
    }

    // Stream lifecycle aborted by caller — kill child, drain, return normally.
    // parley-server will emit cancel seal.
    if (abortFired) {
      this.log(`[claude-code] stream aborted by caller; child SIGTERMed`)
      return
    }

    // Fix 9.5.3 (codex K79P0sTCkPTOaaZefPoh1 Fix 2b): spawn error (ENOENT,
    // EACCES, etc.) → translate into a ParleyResponseError so the parley-
    // server can emit a signed error terminal rather than propagating an
    // unhandled child_process error.
    if (spawnErr !== undefined) {
      throw new ParleyResponseError(
        'ADAPTER_SUBPROCESS_FAILED',
        `claude binary missing or not executable: ${spawnErr.message}`,
      )
    }

    const stderr = stderrChunks.join('')

    // result.is_error=true → throw.
    if (resultError) {
      throw new ParleyResponseError(
        'ADAPTER_SUBPROCESS_FAILED',
        `claude subprocess reported result.is_error=true. stderr: ${stderr.slice(-500)}`,
      )
    }

    // No result event received — subprocess may have exited non-zero.
    if (!resultReceived) {
      // Stale session retry: if we passed a sessionId and stderr hints at a
      // bad session, retry once without --resume.
      if (!isRetry && sessionId !== undefined && isStaleSessionError(stderr)) {
        this.log(`[claude-code] stale session "${sessionId}"; retrying without --resume`)
        // Delete the stale id from the store before retry.
        await this.sessionStore.delete(sessionKey)
        yield* this.runOnce(ctx, sessionKey, undefined, true)
        return
      }

      throw new ParleyResponseError(
        'ADAPTER_SUBPROCESS_FAILED',
        `claude subprocess exited without a result event. stderr: ${stderr.slice(-500)}`,
      )
    }

    // Success path — persist the new session ID.
    if (resultSessionId !== undefined) {
      await this.sessionStore.set(sessionKey, resultSessionId)
      this.log(`[claude-code] session persisted: ${resultSessionId}`)
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildSpawnArgs(sessionId: string | undefined): string[] {
  const spawnArgs = [
    '-p',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
  ]
  if (sessionId !== undefined) {
    spawnArgs.push('--resume', sessionId)
  }

  return spawnArgs
}

/** Flush any trailing incomplete line from the stdout buffer through the event processor. */
function flushStdoutBuffer(buffer: string, processEvent: (ev: StreamJsonEvent) => void): void {
  const trimmed = buffer.trim()
  if (trimmed === '') return
  try {
    const parsed = JSON.parse(trimmed)
    const evResult = StreamJsonEventSchema.safeParse(parsed)
    if (evResult.success) processEvent(evResult.data)
  } catch {
    // Ignore parse errors on final buffer flush.
  }
}

function defaultPathProbe(binary: string): Promise<boolean> {
  // Use `which` (POSIX) to check if the binary is on PATH.
  // spawnSync is synchronous but we wrap in a Promise to match the interface.
  const result = spawnSync('which', [binary], {encoding: 'utf8', shell: false})
  return Promise.resolve(result.status === 0)
}
