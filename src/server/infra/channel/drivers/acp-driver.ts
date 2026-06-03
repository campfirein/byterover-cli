import type {ChildProcessWithoutNullStreams} from 'node:child_process'

import {spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import {z} from 'zod'

import type {PermissionOption} from '../../../../shared/types/index.js'
import type {
  AgentDriverPromptArgs,
  AgentDriverStatus,
  IAgentDriver,
  TurnEventPayload,
} from '../../../core/interfaces/channel/i-agent-driver.js'
import type {ClassifyDriverArgs} from '../driver-class-classifier.js'

import {AGENT_PROCESS_STOP_TIMEOUT_MS, CHANNEL_ACP_HANDSHAKE_TIMEOUT_MS} from '../../../constants.js'
import {AgentBinaryNotFoundError, AgentHandshakeFailedError} from '../../../core/domain/channel/errors.js'
import {projectSessionUpdate} from './acp-event-projector.js'
import {AcpRpcClient, AcpRpcError} from './acp-rpc-client.js'

/**
 * Snapshot of the agent's `initialize` response, captured during {@link
 * AcpDriver.start}. ACP-specific, so it lives on the concrete driver (NOT on
 * the transport-agnostic {@link IAgentDriver}). The onboard probe reads it to
 * classify the driver.
 */
export type AcpInitializeSnapshot = {
  readonly _meta?: Readonly<Record<string, unknown>>
  readonly agentCapabilities?: ClassifyDriverArgs['agentCapabilities']
}

/** Loose parse of the ACP `initialize` result — fields the probe consumes. */
const AcpInitializeResultSchema = z
  .object({
    _meta: z.record(z.unknown()).optional(),
    agentCapabilities: z
      .object({
        promptCapabilities: z
          .object({embeddedContext: z.boolean().optional(), image: z.boolean().optional()})
          .passthrough()
          .optional(),
        toolCallSupport: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    protocolVersion: z.number().optional(),
  })
  .passthrough()

/** Grace before escalating a graceful stop from `SIGTERM` to `SIGKILL`. */
const SIGTERM_GRACE_MS = 1000

/** Recognised `PermissionOption.kind` values for inbound ACP permission options. */
const PERMISSION_OPTION_KINDS = new Set<PermissionOption['kind']>([
  'allow_always',
  'allow_once',
  'reject_always',
  'reject_once',
])

/** How to spawn an ACP agent subprocess. */
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

type PermissionContext = {
  reject(error: unknown): void
  resolve(response: unknown): void
}

type PromptQueueState = {
  /**
   * Set by `AcpDriver.cancel()`. The iterator observes this AFTER the
   * queue-drain loop exits and skips the `await promptPromise` that would
   * otherwise hang on a non-responding child.
   */
  cancelled: boolean
  done: boolean
  queue: TurnEventPayload[]
  resolveNext: (() => void) | undefined
}

/** Narrows an ACP permission-option array into domain {@link PermissionOption}s. */
const toPermissionOptions = (raw: unknown): PermissionOption[] => {
  if (!Array.isArray(raw)) return []
  const options: PermissionOption[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const {kind, name, optionId} = entry as {kind?: unknown; name?: unknown; optionId?: unknown}
    if (typeof optionId !== 'string' || typeof name !== 'string' || typeof kind !== 'string') continue
    if (!PERMISSION_OPTION_KINDS.has(kind as PermissionOption['kind'])) continue
    options.push({kind: kind as PermissionOption['kind'], name, optionId})
  }

  return options
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

  // If the child hangs on `session/prompt`, `promptPromise` never resolves;
  // `cancel()` flips `state.done`/`cancelled` and wakes the parked resolver so
  // the cancellation path owns finalisation. Detach the orphaned promise (the
  // child is about to be killed via `stop()`).
  if (state.cancelled) {
    promptPromise.catch(() => {
      // Detached — the host has already moved on.
    })
    return
  }

  await promptPromise
}

/**
 * Subprocess-driven ACP {@link IAgentDriver}.
 *
 * Wires a Node `child_process` spawn to {@link AcpRpcClient} via NDJSON framing.
 * Owns the agent's `initialize` handshake, lazy `session/new`, and per-turn
 * `session/prompt` lifecycle, projecting `session/update` notifications into
 * payload-only {@link TurnEventPayload}s via {@link projectSessionUpdate}. The
 * driver stays transport-specific; nothing ACP leaks past the projector.
 */
export class AcpDriver implements IAgentDriver {
  /** Raw `initialize` snapshot, captured during {@link start}; `undefined` before start. */
  public acpInitialize: AcpInitializeSnapshot | undefined
  public readonly handle: string
  /** ACP protocol version the agent reported at `initialize`; `undefined` before start. */
  public protocolVersion: number | undefined
  public status: AgentDriverStatus = 'idle'
  private child: ChildProcessWithoutNullStreams | undefined
  private currentPromptState: PromptQueueState | undefined
  private currentPromptWakeup: (() => void) | undefined
  private readonly invocation: AcpDriverInvocation
  private pendingPermissions = new Map<string, PermissionContext>()
  private rpc: AcpRpcClient | undefined
  private sessionId: string | undefined
  private spawnFailed = false

  public constructor(options: AcpDriverOptions) {
    this.handle = options.handle
    this.invocation = options.invocation
  }

  /** Cancels in-flight work; unblocks the iterator and best-effort `session/cancel`. */
  async cancel(_turnId?: string): Promise<void> {
    if (this.rpc === undefined || this.sessionId === undefined) return

    // Flip the iterator's flags + wake the parked resolver BEFORE awaiting
    // session/cancel, so a child hung on session/prompt can't leak the stream.
    if (this.currentPromptState !== undefined) {
      this.currentPromptState.cancelled = true
      this.currentPromptState.done = true
    }

    this.currentPromptWakeup?.()

    // Resolve any pending permission contexts so the iterator unblocks cleanly.
    for (const ctx of this.pendingPermissions.values()) {
      ctx.resolve({outcome: {outcome: 'cancelled'}})
    }

    this.pendingPermissions.clear()

    try {
      await this.rpc.call('session/cancel', {sessionId: this.sessionId})
    } catch {
      // Best-effort: the child may already be exiting or hung.
    }
  }

  /**
   * Probes `session/new` for onboarding classification. Returns `true` when a
   * session is established (caching it so the next `prompt` reuses it), `false`
   * on any failure. Never throws.
   */
  async probeSession(): Promise<boolean> {
    try {
      await this.openSession()
      return true
    } catch {
      return false
    }
  }

  prompt(args: AgentDriverPromptArgs): AsyncIterableIterator<TurnEventPayload> {
    if (this.rpc === undefined) {
      throw new Error('AcpDriver: prompt() called before start() resolved')
    }

    // Single-flight: one prompt streams at a time. Overlapping prompts would
    // overwrite the shared notification/permission routing and cross-wire
    // events into the wrong iterator. Per-turn routing is a later concern.
    if (this.currentPromptState !== undefined) {
      throw new Error('AcpDriver: a prompt is already in flight; concurrent prompts are not supported')
    }

    const {rpc} = this
    const state: PromptQueueState = {cancelled: false, done: false, queue: [], resolveNext: undefined}
    const wakeup = (): void => {
      if (state.resolveNext !== undefined) {
        const resolve = state.resolveNext
        state.resolveNext = undefined
        resolve()
      }
    }

    // Publish state + wakeup so cancel() can flip them. Cleared in
    // dispatchPrompt's finally (the single path both success and error take).
    this.currentPromptState = state
    this.currentPromptWakeup = wakeup
    this.status = 'streaming'

    rpc.onNotification('session/update', (params) => {
      if (typeof params !== 'object' || params === null) return
      const note = params as {sessionId?: unknown; update?: unknown}
      // Drop cross-session notifications (late, duplicate, or foreign session)
      // so they can't leak into the wrong prompt iterator.
      if (
        typeof note.sessionId === 'string' &&
        this.sessionId !== undefined &&
        note.sessionId !== this.sessionId
      ) {
        return
      }

      // projectSessionUpdate is total: malformed `note.update` yields undefined.
      const event = projectSessionUpdate(note.update)
      if (event !== undefined) {
        state.queue.push(event)
        wakeup()
      }
    })

    rpc.onRequest(
      'session/request_permission',
      (params) =>
        new Promise<unknown>((resolve, reject) => {
          const request =
            typeof params === 'object' && params !== null
              ? (params as {options?: unknown; toolCall?: unknown})
              : {}
          const permissionRequestId = `acp-perm-${randomUUID()}`
          this.pendingPermissions.set(permissionRequestId, {reject, resolve})
          state.queue.push({
            kind: 'permission_request',
            options: toPermissionOptions(request.options),
            permissionRequestId,
            toolCall: request.toolCall,
          })
          wakeup()
        }),
    )

    return iteratePromptQueue(
      state,
      this.dispatchPrompt({args, ensureSession: () => this.openSession(), rpc, state, wakeup}),
    )
  }

  /** Resolves a pending permission request the driver surfaced. */
  async respondToPermission(permissionRequestId: string, response: unknown): Promise<void> {
    const ctx = this.pendingPermissions.get(permissionRequestId)
    if (ctx === undefined) return
    this.pendingPermissions.delete(permissionRequestId)
    ctx.resolve(response)
  }

  /** Spawns the agent subprocess and completes the `initialize` handshake. Idempotent. */
  async start(): Promise<void> {
    if (this.child !== undefined) return

    const env = {...process.env, ...this.invocation.env}
    const child = spawn(this.invocation.command, this.invocation.args, {
      cwd: this.invocation.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams
    this.child = child

    // Translate spawn ENOENT into a typed AgentBinaryNotFoundError — the raw
    // `Error: spawn <cmd> ENOENT` node leaks is cryptic at the CLI surface.
    let spawnError: NodeJS.ErrnoException | undefined
    const spawnErrorPromise = new Promise<never>((_, reject) => {
      child.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          spawnError = err
          this.spawnFailed = true
          reject(new AgentBinaryNotFoundError(this.invocation.command))
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
        if (!closed && child.stdin.writable) child.stdin.write(line)
      },
    })
    child.stdout.on('data', (chunk: Buffer) => {
      rpc.ingest(chunk)
    })
    child.stderr.resume() // Drain; surface as an ERROR log once wired up.
    this.rpc = rpc

    try {
      let timer: NodeJS.Timeout | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new AgentHandshakeFailedError(
              this.handle,
              `initialize did not respond within ${CHANNEL_ACP_HANDSHAKE_TIMEOUT_MS}ms`,
            ),
          )
        }, CHANNEL_ACP_HANDSHAKE_TIMEOUT_MS)
      })
      const initializeCall = rpc.call('initialize', {clientCapabilities: {}, protocolVersion: 1})
      try {
        await Promise.race([initializeCall, spawnErrorPromise, timeoutPromise])
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }

      if (spawnError !== undefined) throw new AgentBinaryNotFoundError(this.invocation.command)

      // Capture the handshake result for the onboard probe. The race already
      // resolved on `initializeCall`, so this await returns immediately.
      const initResult = AcpInitializeResultSchema.safeParse(await initializeCall)
      if (initResult.success) {
        this.protocolVersion = initResult.data.protocolVersion
        this.acpInitialize = {_meta: initResult.data._meta, agentCapabilities: initResult.data.agentCapabilities}
      }
    } catch (error) {
      this.status = 'errored'
      await this.stop()
      if (error instanceof AgentBinaryNotFoundError) throw error
      if (error instanceof AgentHandshakeFailedError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      throw new AgentHandshakeFailedError(this.handle, reason)
    }
  }

  /** Tears the subprocess down: close stdin → SIGTERM → SIGKILL. Idempotent. */
  async stop(): Promise<void> {
    if (this.status !== 'errored') this.status = 'stopped'
    const {child} = this
    if (child === undefined) return
    this.child = undefined

    if (child.exitCode !== null || child.killed || this.spawnFailed) return

    await new Promise<void>((resolve) => {
      let settled = false
      const timers: NodeJS.Timeout[] = []
      const finish = (): void => {
        if (settled) return
        settled = true
        for (const timer of timers) clearTimeout(timer)
        resolve()
      }

      child.once('exit', finish)
      child.once('close', finish)

      try {
        child.stdin.end()
      } catch {
        // Already closed.
      }

      timers.push(
        setTimeout(() => {
          try {
            child.kill('SIGTERM')
          } catch {
            // Already gone.
          }
        }, SIGTERM_GRACE_MS),
        setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // Already gone.
          }

          finish()
        }, AGENT_PROCESS_STOP_TIMEOUT_MS),
      )
    })

    // A clean stop leaves the driver 'stopped'; an errored start keeps 'errored'.
    if (this.status !== 'errored') this.status = 'stopped'
  }

  private async dispatchPrompt(deps: {
    args: AgentDriverPromptArgs
    ensureSession: () => Promise<string>
    rpc: AcpRpcClient
    state: PromptQueueState
    wakeup: () => void
  }): Promise<void> {
    try {
      const sessionId = await deps.ensureSession()
      await deps.rpc.call('session/prompt', {...deps.args.meta, prompt: deps.args.prompt, sessionId})
    } catch (error) {
      // A non-RPC error is a driver-level failure; an AcpRpcError is the agent
      // reporting a turn error and still leaves the driver usable.
      if (!(error instanceof AcpRpcError)) {
        this.status = 'errored'
        throw error
      }
    } finally {
      deps.state.done = true
      deps.wakeup()
      this.currentPromptState = undefined
      this.currentPromptWakeup = undefined
      if (this.status === 'streaming') this.status = 'idle'
    }
  }

  /**
   * Establishes (and caches) the ACP session via `session/new`. Reused by both
   * the lazy `prompt` path and the onboard `probeSession` probe so the
   * session/new contract lives in one place.
   */
  private async openSession(): Promise<string> {
    if (this.sessionId !== undefined) return this.sessionId
    if (this.rpc === undefined) {
      throw new AcpRpcError(-32_000, 'openSession() called before start() resolved')
    }

    const result = await this.rpc.call('session/new', {cwd: this.invocation.cwd, mcpServers: []})
    const sessionId =
      typeof result === 'object' && result !== null && 'sessionId' in result ? result.sessionId : undefined
    if (typeof sessionId !== 'string') {
      throw new AcpRpcError(-32_000, 'session/new did not return a sessionId')
    }

    this.sessionId = sessionId
    return sessionId
  }
}
