import type {
  Agent as UpstreamAgent,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptCapabilities,
  PromptRequest,
  PromptResponse,
  Stream,
} from '@agentclientprotocol/sdk'

import {AgentSideConnection, ndJsonStream} from '@agentclientprotocol/sdk'
import {randomUUID} from 'node:crypto'
import {Readable, Writable} from 'node:stream'

import {PromptContext} from './prompt-context.js'

export type ChannelAgentConfig = {
  readonly name: string
  readonly promptCapabilities: PromptCapabilities
  readonly version: string
}

export type ChannelAgentRunOptions = {
  /**
   * Optional bidirectional ACP `Stream`. Defaults to stdio NDJSON
   * (`ndJsonStream(stdout, stdin)`). Tests typically construct a paired
   * in-memory pair and pass it here.
   */
  readonly stream?: Stream
}

export type PromptHandler = (
  request: PromptRequest,
  ctx: PromptContext,
) => Promise<PromptResponse>

export type CancelHandler = (notification: CancelNotification) => Promise<void> | void

type SessionState = {
  readonly abortController: AbortController
}

/**
 * Ergonomic wrapper around `@agentclientprotocol/sdk`'s `AgentSideConnection`.
 *
 * Surface (Slice 5.1, v0.1):
 *   - `onPrompt(handler)` — register the user's prompt handler.
 *   - `onCancel(handler)` — register an optional cancel handler.
 *   - `run({stream?})` — wire stdin/stdout (or the provided stream) and
 *     start the agent loop.
 *
 * Outside-in: every API exists because the 25-LOC echo example needs it.
 * `loadSession`, `setSessionMode`, `authenticate` are intentionally absent
 * from v0.1 — add them only when an example surfaces the need.
 */
export class ChannelAgent {
  private cancelHandler: CancelHandler | undefined
  private readonly config: ChannelAgentConfig
  private connection: AgentSideConnection | undefined
  private promptHandler: PromptHandler | undefined
  private readonly sessions = new Map<string, SessionState>()

  public constructor(config: ChannelAgentConfig) {
    this.config = config
  }

  onCancel(handler: CancelHandler): void {
    this.cancelHandler = handler
  }

  onPrompt(handler: PromptHandler): void {
    this.promptHandler = handler
  }

  run(options: ChannelAgentRunOptions = {}): void {
    const stream = options.stream ?? this.defaultStdioStream()
    this.connection = new AgentSideConnection((conn) => this.makeAgent(conn), stream)
  }

  private defaultStdioStream(): Stream {
    // The upstream lib expects Web Streams. Node's process.stdout / stdin
    // are Node streams; we adapt them via the Node-built-in helpers.
    const stdoutWeb = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
    const stdinWeb = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
    return ndJsonStream(stdoutWeb, stdinWeb)
  }

  private makeAgent(conn: AgentSideConnection): UpstreamAgent {
    return {
      authenticate: async (_params: AuthenticateRequest): Promise<AuthenticateResponse> => {
        // v0.1 of the SDK does not surface authenticate to user code —
        // agents that need an out-of-band login flow should return an
        // `AUTH_REQUIRED` error from `initialize` instead (§15.6).
        throw new Error('ChannelAgent: authenticate is not supported in v0.1. Surface AUTH_REQUIRED from initialize().')
      },
      cancel: async (notification: CancelNotification): Promise<void> => {
        const state = this.sessions.get(notification.sessionId)
        if (state !== undefined) state.abortController.abort()
        if (this.cancelHandler !== undefined) {
          await this.cancelHandler(notification)
        }
      },
      initialize: async (_params: InitializeRequest): Promise<InitializeResponse> => ({
        agentCapabilities: {
          promptCapabilities: this.config.promptCapabilities,
        },
        agentInfo: {name: this.config.name, version: this.config.version},
        protocolVersion: 1,
      }),
      newSession: async (_params: NewSessionRequest): Promise<NewSessionResponse> => {
        const sessionId = randomUUID()
        this.sessions.set(sessionId, {abortController: new AbortController()})
        return {sessionId}
      },
      prompt: async (params: PromptRequest): Promise<PromptResponse> => {
        if (this.promptHandler === undefined) {
          throw new Error('ChannelAgent: no prompt handler registered. Call agent.onPrompt(...) before agent.run().')
        }

        const state = this.sessions.get(params.sessionId) ?? {abortController: new AbortController()}
        if (!this.sessions.has(params.sessionId)) this.sessions.set(params.sessionId, state)
        const ctx = new PromptContext({
          connection: conn,
          sessionId: params.sessionId,
          signal: state.abortController.signal,
        })
        try {
          return await this.promptHandler(params, ctx)
        } finally {
          ctx._deactivate()
          // Review fix #10: drop the session entry once the prompt handler
          // has resolved. The AbortController only matters DURING a prompt;
          // keeping a stale entry forever (or recreating a fresh one for
          // a "next prompt that might never come") is the leak. A
          // subsequent `prompt` on the same `sessionId` recreates the entry
          // just-in-time via the `?? new AbortController()` above.
          this.sessions.delete(params.sessionId)
        }
      },
    }
  }
}
