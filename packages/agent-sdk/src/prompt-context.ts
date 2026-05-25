import type {
  AgentSideConnection,
  ContentBlock,
  RequestPermissionOutcome,
  SessionNotification,
  ToolCallContent,
} from '@agentclientprotocol/sdk'

/**
 * The per-prompt context object passed to the user's `onPrompt` handler.
 *
 * Owns the bridge from "I want to stream something to the host" to the
 * underlying `AgentSideConnection.sessionUpdate(...)` call. The context is
 * INVALIDATED when the prompt handler returns; calling `sendMessageChunk`
 * etc. after that throws (§7.2 — agents must not stream out-of-prompt).
 *
 * `signal` is wired to the host's `session/cancel`: agents who do long
 * work inside `onPrompt` should observe `signal.aborted` (or attach an
 * `'abort'` listener) and bail.
 */
export type PromptContextOptions = {
  readonly connection: AgentSideConnection
  readonly sessionId: string
  readonly signal: AbortSignal
}

export type RequestPermissionArgs = {
  readonly options: ReadonlyArray<{
    readonly kind: 'allow_always' | 'allow_once' | 'reject_always' | 'reject_once'
    readonly name: string
    readonly optionId: string
  }>
  readonly toolCall: {
    readonly content?: readonly ToolCallContent[]
    readonly kind?: 'delete' | 'edit' | 'execute' | 'fetch' | 'move' | 'other' | 'read' | 'search' | 'think'
    readonly locations?: readonly {readonly line?: number; readonly path: string}[]
    readonly rawInput?: unknown
    readonly title: string
    readonly toolCallId: string
  }
}

export type SendToolCallArgs = {
  readonly content?: readonly ToolCallContent[]
  readonly kind?: 'delete' | 'edit' | 'execute' | 'fetch' | 'move' | 'other' | 'read' | 'search' | 'think'
  readonly rawInput?: unknown
  readonly title: string
  readonly toolCallId: string
}

export type SendToolCallUpdateArgs = {
  readonly content?: readonly ToolCallContent[]
  readonly rawOutput?: unknown
  readonly status?: string
  readonly toolCallId: string
}

export class PromptContext {
  public readonly signal: AbortSignal
  private active = true
  private readonly connection: AgentSideConnection
  private readonly sessionId: string

  public constructor(options: PromptContextOptions) {
    this.connection = options.connection
    this.sessionId = options.sessionId
    this.signal = options.signal
  }

  async requestPermission(args: RequestPermissionArgs): Promise<RequestPermissionOutcome> {
    this.assertActive('requestPermission')
    const response = await this.connection.requestPermission({
      options: args.options.map((o) => ({...o})),
      sessionId: this.sessionId,
      toolCall: {
        ...args.toolCall,
        content: args.toolCall.content === undefined ? undefined : [...args.toolCall.content],
        locations: args.toolCall.locations === undefined ? undefined : [...args.toolCall.locations],
      },
    })
    return response.outcome
  }

  async sendMessageChunk(text: string): Promise<void>
  async sendMessageChunk(content: ContentBlock): Promise<void>
  async sendMessageChunk(textOrBlock: ContentBlock | string): Promise<void> {
    this.assertActive('sendMessageChunk')
    const content: ContentBlock = typeof textOrBlock === 'string' ? {text: textOrBlock, type: 'text'} : textOrBlock
    const notification: SessionNotification = {
      sessionId: this.sessionId,
      update: {content, sessionUpdate: 'agent_message_chunk'},
    }
    await this.connection.sessionUpdate(notification)
  }

  async sendThoughtChunk(text: string): Promise<void>
  async sendThoughtChunk(content: ContentBlock): Promise<void>
  async sendThoughtChunk(textOrBlock: ContentBlock | string): Promise<void> {
    this.assertActive('sendThoughtChunk')
    const content: ContentBlock = typeof textOrBlock === 'string' ? {text: textOrBlock, type: 'text'} : textOrBlock
    const notification: SessionNotification = {
      sessionId: this.sessionId,
      update: {content, sessionUpdate: 'agent_thought_chunk'},
    }
    await this.connection.sessionUpdate(notification)
  }

  async sendToolCall(args: SendToolCallArgs): Promise<void> {
    this.assertActive('sendToolCall')
    const notification: SessionNotification = {
      sessionId: this.sessionId,
      update: {
        kind: args.kind,
        rawInput: args.rawInput,
        sessionUpdate: 'tool_call',
        title: args.title,
        toolCallId: args.toolCallId,
        ...(args.content === undefined ? {} : {content: [...args.content]}),
      },
    }
    await this.connection.sessionUpdate(notification)
  }

  async sendToolCallUpdate(args: SendToolCallUpdateArgs): Promise<void> {
    this.assertActive('sendToolCallUpdate')
    const notification: SessionNotification = {
      sessionId: this.sessionId,
      update: {
        rawOutput: args.rawOutput,
        sessionUpdate: 'tool_call_update',
        // @agentclientprotocol/sdk's narrower status enum is widened to any
        // string on the wire as of Channel Protocol §7.1.1 — pass through.
        status: args.status as 'completed' | 'failed' | 'in_progress' | undefined,
        toolCallId: args.toolCallId,
        ...(args.content === undefined ? {} : {content: [...args.content]}),
      },
    }
    await this.connection.sessionUpdate(notification)
  }

  /** @internal — called by `ChannelAgent` once the prompt handler resolves. */
  _deactivate(): void {
    this.active = false
  }

  private assertActive(method: string): void {
    if (!this.active) {
      throw new Error(
        `ctx.${method}() called after the prompt handler ended; agents must not stream out-of-prompt (Channel Protocol §15.2).`,
      )
    }
  }
}
