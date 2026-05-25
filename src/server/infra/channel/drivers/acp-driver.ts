import type {ChildProcessWithoutNullStreams} from 'node:child_process'

import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'

import type {ChannelAuthMethod} from '../../../core/domain/channel/errors.js'
import type {
  AcpDriverPromptArgs,
  AcpDriverStatus,
  IAcpDriver,
  TurnEventPayload,
} from '../../../core/interfaces/channel/i-acp-driver.js'

import {
  AcpAuthRequiredError,
  AcpBinaryNotFoundError,
  AcpHandshakeFailedError,
  resolveHandshakeTimeoutMs,
} from '../../../core/domain/channel/errors.js'
import {projectSessionUpdate} from './acp-event-projector.js'
import {AcpRpcClient, AcpRpcError} from './acp-rpc-client.js'

/**
 * Slice 4.2 — classify an `AcpRpcError` raised by `initialize` or
 * `session/new` into an `AcpAuthRequiredError`. Returns `undefined` for
 * non-auth errors so the caller can fall back to the generic
 * AcpHandshakeFailedError path.
 *
 * Recognised forms:
 *  - JSON-RPC code -32000 with `data.authMethods` (real kimi-cli — see
 *    upstream `src/kimi_cli/acp/server.py:148`).
 *  - JSON-RPC code -32602 (defensive: some legacy ACP variants).
 *  - JSON-RPC code 'AUTH_REQUIRED' string (defensive: unstable-protocol
 *    variants that emit the symbolic code).
 */
const classifyAcpAuthError = (error: unknown, handle: string): AcpAuthRequiredError | undefined => {
  if (!(error instanceof AcpRpcError)) return undefined
  const codeMatches =
    error.code === -32_000 ||
    error.code === -32_602 ||
    (error.code as unknown) === 'AUTH_REQUIRED'
  if (!codeMatches) return undefined

  const data = error.data as undefined | {authMethods?: unknown}
  const rawMethods = Array.isArray(data?.authMethods) ? data?.authMethods : []
  // -32000 and -32602 are both shared with generic agent errors (kimi raises
  // -32000 for tool failures and -32602 for any Pydantic validation reject).
  // Only classify as AUTH_REQUIRED when `data.authMethods` is present — the
  // contract real ACP servers use to signal "this is an auth prompt, here's
  // how to satisfy it". The symbolic 'AUTH_REQUIRED' string is unambiguous
  // and passes through without the authMethods guard.
  if (rawMethods.length === 0 && (error.code as unknown) !== 'AUTH_REQUIRED') return undefined

  const methods: ChannelAuthMethod[] = rawMethods
    .map((m): ChannelAuthMethod | undefined => {
      if (m === null || typeof m !== 'object') return undefined
      const obj = m as Record<string, unknown>
      const id = typeof obj.id === 'string' ? obj.id : undefined
      if (id === undefined) return undefined
      const meta = obj.fieldMeta as undefined | {terminalAuth?: unknown}
      const terminal = meta?.terminalAuth as
        | undefined
        | {args?: unknown; command?: unknown; env?: unknown}
      const terminalAuth =
        terminal !== undefined && typeof terminal.command === 'string'
          ? {
              args: Array.isArray(terminal.args)
                ? (terminal.args.filter((a): a is string => typeof a === 'string') as readonly string[])
                : undefined,
              command: terminal.command,
              env:
                terminal.env !== null &&
                typeof terminal.env === 'object'
                  ? (terminal.env as Record<string, string>)
                  : undefined,
            }
          : undefined
      return {
        description: typeof obj.description === 'string' ? obj.description : undefined,
        fieldMeta: terminalAuth === undefined ? undefined : {terminalAuth},
        id,
        name: typeof obj.name === 'string' ? obj.name : undefined,
      }
    })
    .filter((m): m is ChannelAuthMethod => m !== undefined)

  return new AcpAuthRequiredError(handle, methods)
}

export type AcpDriverInvocation = {
  readonly args: string[]
  readonly command: string
  readonly cwd: string
  readonly env?: Record<string, string>
}

export type AcpDriverOptions = {
  readonly handle: string
  readonly invocation: AcpDriverInvocation
}



type SessionUpdateNotification = {
  sessionId: string
  update: {[k: string]: unknown; sessionUpdate: string;}
}

type PermissionContext = {
  reject(error: unknown): void
  resolve(response: unknown): void
}

type PromptQueueState = {
  /**
   * Set by `AcpDriver.cancel()` (review fix #3). The iterator observes
   * this AFTER the queue-drain loop exits and skips the `await
   * promptPromise` that would otherwise hang on a non-responding child.
   */
  cancelled: boolean
  done: boolean
  queue: TurnEventPayload[]
  resolveNext: (() => void) | undefined
}

async function* iteratePromptQueue(
  state: PromptQueueState,
  promptPromise: Promise<unknown>,
): AsyncGenerator<TurnEventPayload> {
  while (state.queue.length > 0 || !state.done) {
    if (state.queue.length > 0) {
      const event = state.queue.shift()
      if (event !== undefined) yield event
      continue
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      state.resolveNext = resolve
    })
  }

  // Review fix #3: if the child hangs on `session/prompt` (network stall,
  // dead agent), `promptPromise` never resolves and the orchestrator's
  // background streaming task leaks forever — `releaseNextQueued` and
  // `maybeFinaliseTurn` are never reached. `cancel()` flips `state.done`
  // and resolves any pending permission contexts; observing `state.done`
  // here means the cancellation path owns finalisation. Discard the hung
  // promise's eventual settlement (it's now orphaned, which is fine for a
  // child we're about to kill via `stop()`).
  if (state.cancelled) {
    promptPromise.catch(() => {
      // Detach — the host has already moved on.
    })
    return
  }

  await promptPromise
}

/**
 * Subprocess-driven ACP driver.
 *
 * Wires a Node `child_process` spawn to {@link AcpRpcClient} via NDJSON
 * framing. Owns the agent's `initialize` handshake, lazy `session/new`,
 * and per-turn `session/prompt` lifecycle. Projects `session/update`
 * notifications to payload-only {@link TurnEventPayload}.
 */
export class AcpDriver implements IAcpDriver {
  public acpInitialize: import('../../../core/interfaces/channel/i-acp-driver.js').AcpInitializeSnapshot | undefined
  public capabilities: string[] = []
  public readonly handle: string
  public protocolVersion: number | undefined
  public status: AcpDriverStatus = 'idle'
  private child: ChildProcessWithoutNullStreams | undefined
  /**
   * Review fix #3: the per-prompt iterator state, exposed to `cancel()`
   * so it can flip `state.cancelled = true` AND `state.done = true` AND
   * wake the parked `resolveNext` promise. Without this, a stuck
   * `session/prompt` would never let `iteratePromptQueue` exit.
   */
  private currentPromptState: PromptQueueState | undefined
  private currentPromptWakeup: (() => void) | undefined
  private readonly invocation: AcpDriverInvocation
  private pendingPermissions = new Map<string, PermissionContext>()
  private rpc: AcpRpcClient | undefined
  private sessionId: string | undefined

  public constructor(options: AcpDriverOptions) {
    this.handle = options.handle
    this.invocation = options.invocation
  }

  async cancel(_turnId?: string): Promise<void> {
    if (this.rpc === undefined || this.sessionId === undefined) return

    // Review fix #3: flip the iterator's `cancelled` + `done` flags + wake
    // the parked resolver BEFORE awaiting session/cancel. If the child is
    // hung on session/prompt (network stall, dead agent), the iterator
    // would otherwise leak forever — this short-circuits its
    // `await promptPromise` and lets the orchestrator's background task
    // continue to releaseNextQueued / maybeFinaliseTurn.
    if (this.currentPromptState !== undefined) {
      this.currentPromptState.cancelled = true
      this.currentPromptState.done = true
    }

    if (this.currentPromptWakeup !== undefined) {
      this.currentPromptWakeup()
    }

    // Resolve any pending permission contexts with a cancellation outcome so
    // the iterator unblocks cleanly.
    for (const ctx of this.pendingPermissions.values()) {
      ctx.resolve({outcome: {outcome: 'cancelled'}})
    }

    this.pendingPermissions.clear()

    try {
      await this.rpc.call('session/cancel', {sessionId: this.sessionId})
    } catch {
      // session/cancel is best-effort; the child may already be exiting
      // or hung. We've already unblocked the iterator above.
    }
  }

  /**
   * Phase-3 onboarding probe: explicitly attempt ACP `session/new` and
   * report whether it succeeded. The driver does NOT keep the probed
   * session — it is closed (by not being referenced) so the next
   * `prompt()` call starts a fresh session.
   *
   * Returns `false` on any error response so the onboard classifier can
   * tag the driver as `C-prime` instead of `B`.
   */
  async probeSession(): Promise<boolean> {
    if (this.rpc === undefined) return false
    try {
      // Send the same `session/new` shape the production path uses; real
      // agents (e.g. kimi-cli) validate params with Pydantic and reject
      // `{}` with -32602 Invalid params, which the auth classifier would
      // then mis-classify as AUTH_REQUIRED.
      const result = (await this.rpc.call('session/new', {
        cwd: this.invocation.cwd,
        mcpServers: [],
      })) as {sessionId?: string}
      return typeof result?.sessionId === 'string' && result.sessionId.length > 0
    } catch (error) {
      // Slice 4.2: AUTH_REQUIRED from session/new must surface upward so
      // the onboard service produces ONBOARD_AUTH_REQUIRED instead of
      // silently classifying the driver as C-prime.
      const authError = classifyAcpAuthError(error, this.handle)
      if (authError !== undefined) throw authError
      return false
    }
  }

  prompt(args: AcpDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
    if (this.rpc === undefined) {
      throw new Error('AcpDriver: prompt() called before start() resolved')
    }

    const {rpc} = this
    const ensureSession = async (): Promise<string> => {
      if (this.sessionId !== undefined) return this.sessionId
      const result = (await rpc.call('session/new', {
        cwd: this.invocation.cwd,
        mcpServers: [],
      })) as {sessionId: string}
      this.sessionId = result.sessionId
      return result.sessionId
    }

    const state: PromptQueueState = {cancelled: false, done: false, queue: [], resolveNext: undefined}
    const wakeup = (): void => {
      if (state.resolveNext !== undefined) {
        const r = state.resolveNext
        state.resolveNext = undefined
        r()
      }
    }

    // Review fix #3: publish state + wakeup so cancel() can flip them.
    // Cleared inside dispatchPrompt's finally block (the only path that
    // both successful prompts and errors flow through).
    this.currentPromptState = state
    this.currentPromptWakeup = wakeup

    rpc.onNotification('session/update', (params) => {
      const note = params as SessionUpdateNotification
      const event = projectSessionUpdate(note.update)
      if (event !== undefined) {
        state.queue.push(event)
        wakeup()
      }
    })

    rpc.onRequest('session/request_permission', (params) =>
      new Promise<unknown>((resolve, reject) => {
        const req = params as {options: unknown[]; sessionId: string; toolCall: unknown}
        // Review fix #9: `pendingPermissions.size + 1` was not monotonic
        // (a resolve before the next track reuses the slot), and
        // `Date.now()` is millisecond-precision — two permissions fired in
        // the same ms with the same map size collided. Use randomUUID()
        // for unconditional uniqueness; prefix kept for human-readable logs.
        const id = `acp-perm-${randomUUID()}`
        this.pendingPermissions.set(id, {reject, resolve})
        state.queue.push({
          kind: 'permission_request',
          permissionRequestId: id,
          request: req,
        } as TurnEventPayload)
        wakeup()
      }),
    )

    return iteratePromptQueue(state, this.dispatchPrompt({args, ensureSession, rpc, state, wakeup}))
  }

  async respondToPermission(permissionRequestId: string, response: unknown): Promise<void> {
    const ctx = this.pendingPermissions.get(permissionRequestId)
    if (ctx === undefined) return
    this.pendingPermissions.delete(permissionRequestId)
    ctx.resolve(response)
  }

  async start(): Promise<void> {
    const env = {...process.env, ...this.invocation.env}
    const child = spawn(this.invocation.command, this.invocation.args, {
      cwd: this.invocation.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    this.child = child

    // Slice 4.4 — translate spawn ENOENT into a typed
    // `AcpBinaryNotFoundError`. The raw `Error: spawn <cmd> ENOENT` leaked
    // by node is cryptic at the CLI surface.
    let spawnError: NodeJS.ErrnoException | undefined
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once('error', (err) => {
        const errno = err as NodeJS.ErrnoException
        if (errno.code === 'ENOENT') {
          spawnError = errno
          reject(new AcpBinaryNotFoundError(this.invocation.command))
          return
        }

        reject(err)
      })
    })

    let closed = false
    const rpc = new AcpRpcClient({
      onClose(handler) {
        child.on('close', () => {
          closed = true
          handler()
        })
      },
      onLine() {
        // ingest() drives the decoder directly; this hook isn't used.
      },
      send(line) {
        if (!closed && child.stdin.writable) {
          child.stdin.write(line)
        }
      },
    })
    child.stdout.on('data', (chunk: Buffer) => {
      rpc.ingest(chunk)
    })
    child.stderr.on('data', () => {
      // Drain; surface as ERROR log when we wire it up.
    })

    this.rpc = rpc

    try {
      const handshakeTimeoutMs = resolveHandshakeTimeoutMs(process.env)
      let timer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new AcpHandshakeFailedError(
              this.handle,
              `initialize did not respond within ${handshakeTimeoutMs}ms`,
            ),
          )
        }, handshakeTimeoutMs)
      })
      const initializeCall = rpc.call('initialize', {
        clientCapabilities: {},
        protocolVersion: 1,
      })
      let result: {
        _meta?: Record<string, unknown>
        agentCapabilities?: {
          promptCapabilities?: Record<string, boolean>
          toolCallSupport?: boolean
        }
        protocolVersion: number
      }
      try {
        result = (await Promise.race([initializeCall, spawnErrorPromise, timeoutPromise])) as typeof result
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }

      if (spawnError !== undefined) throw new AcpBinaryNotFoundError(this.invocation.command)
      this.protocolVersion = result.protocolVersion
      this.acpInitialize = {_meta: result._meta, agentCapabilities: result.agentCapabilities}
      const promptCaps = result.agentCapabilities?.promptCapabilities ?? {}
      this.capabilities = Object.entries(promptCaps)
        .filter(([, v]) => v === true)
        .map(([k]) => k)
      if (result.agentCapabilities?.toolCallSupport === true) this.capabilities.push('toolCallSupport')
    } catch (error) {
      this.status = 'errored'
      await this.stop()
      // Already-typed errors propagate verbatim.
      if (error instanceof AcpBinaryNotFoundError) throw error
      if (error instanceof AcpHandshakeFailedError) throw error
      const authError = classifyAcpAuthError(error, this.handle)
      if (authError !== undefined) throw authError
      const reason = error instanceof Error ? error.message : String(error)
      throw new AcpHandshakeFailedError(this.handle, reason)
    }
  }

  async stop(): Promise<void> {
    this.status = 'stopped'
    const {child} = this
    if (child === undefined) return
    this.child = undefined

    if (child.exitCode !== null || child.killed) return

    return new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(killTimer)
        resolve()
      }

      child.once('exit', onExit)

      // Try graceful close: close stdin → SIGTERM after 1s → SIGKILL after 5s.
      try {
        child.stdin.end()
      } catch {
        // Already closed.
      }

      const termTimer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
        } catch {
          // Already gone.
        }
      }, 1000)
      const killTimer = setTimeout(() => {
        clearTimeout(termTimer)
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone.
        }
      }, 5000)
    })
  }

  private async dispatchPrompt(deps: {
    args: AcpDriverPromptArgs
    ensureSession: () => Promise<string>
    rpc: AcpRpcClient
    state: PromptQueueState
    wakeup: () => void
  }): Promise<void> {
    const sessionId = await deps.ensureSession()
    try {
      await deps.rpc.call('session/prompt', {
        ...deps.args.meta,
        prompt: deps.args.prompt,
        sessionId,
      })
    } catch (error) {
      // Non-cancellation errors mark the driver `errored`; the iterator
      // surfaces them via its trailing `await promptPromise`.
      if (!(error instanceof AcpRpcError)) {
        this.status = 'errored'
        throw error
      }
    } finally {
      deps.state.done = true
      deps.wakeup()
      // Review fix #3: clear the published cancel hooks now that the prompt
      // has run to completion (or thrown). A subsequent cancel() must NOT
      // race against an already-resolved iterator.
      this.currentPromptState = undefined
      this.currentPromptWakeup = undefined
    }
  }
}

export {AcpHandshakeFailedError} from '../../../core/domain/channel/errors.js'