/**
 * ClientInfo — In-memory entity representing a connected client.
 *
 * Tracked by ClientManager for project membership and onProjectEmpty detection.
 * Not persisted — no Zod validation needed.
 *
 * Client types:
 * - 'tui': Terminal UI (the brv REPL) — external client, long-lived
 * - 'cli': CLI headless commands (brv curate --headless, etc.) — external client, short-lived
 * - 'extension': IDE extension (e.g. VS Code extension) — external client, implemented in separate repo
 * - 'mcp': MCP protocol client (IDEs, external tools) — external client, may be global-scope
 * - 'webui': Web UI (browser dashboard at /ui) — external client, long-lived
 * - 'agent': Agent worker process — NOT an external client (worker, not user)
 *
 * projectPath is undefined for global-scope MCP clients until
 * associateProject() is called on first tool call with cwd.
 */

/**
 * Valid client types (runtime source of truth).
 * Used for validation when registering clients.
 */
export const VALID_CLIENT_TYPES = ['agent', 'cli', 'extension', 'mcp', 'tui', 'webui'] as const

/**
 * Client type discriminator.
 */
export type ClientType = (typeof VALID_CLIENT_TYPES)[number]

/**
 * Runtime type guard for client type validation.
 */
export function isValidClientType(value: unknown): value is ClientType {
  return typeof value === 'string' && (VALID_CLIENT_TYPES as readonly string[]).includes(value)
}

/**
 * Construction parameters for ClientInfo.
 */
type ClientInfoParams = {
  agentName?: string
  connectedAt: number
  id: string
  projectPath?: string
  type: ClientType
}

/**
 * Represents a connected client tracked by ClientManager.
 */
export class ClientInfo {
  public readonly connectedAt: number
  public readonly id: string
  public readonly type: ClientType
  /** Mutable: set via setAgentName() for MCP clients after MCP initialize handshake */
  private _agentName: string | undefined
  /**
   * M15.8: frozen copy of the IDE name as emitted on `mcp_session_start`.
   * Read by `mcp_session_ended` so the start/end pair always carries
   * matching `client_name` even if `_agentName` were re-mutated mid-session.
   * Also serves as the "session active for analytics" gate — non-undefined
   * iff a `mcp_session_start` has been emitted for this ClientInfo.
   */
  private _mcpSessionEmittedName: string | undefined
  /** Mutable: set via associateProject() for global-scope MCP clients */
  private _projectPath: string | undefined

  constructor(params: ClientInfoParams) {
    this.id = params.id
    this.type = params.type
    this.connectedAt = params.connectedAt
    this._agentName = params.agentName
    this._projectPath = params.projectPath
  }

  /**
   * The agent name reported by the MCP client during initialize handshake.
   * Undefined for non-MCP clients or MCP clients that haven't completed handshake.
   */
  get agentName(): string | undefined {
    return this._agentName
  }

  /**
   * Whether this client has been associated with a project.
   */
  get hasProject(): boolean {
    return this._projectPath !== undefined
  }

  /**
   * Whether this client counts toward project membership for onProjectEmpty.
   * Agent clients are workers, not users — they don't count.
   */
  get isExternalClient(): boolean {
    return this.type !== 'agent'
  }

  /**
   * M15.8: the `client_name` value emitted on the prior `mcp_session_start`,
   * or undefined if no session-start has fired for this ClientInfo yet.
   * Read by ClientManager's `mcp_session_ended` emitter so start/end pairs
   * remain correlated even if `agentName` were re-mutated mid-session.
   */
  get mcpSessionEmittedName(): string | undefined {
    return this._mcpSessionEmittedName
  }

  /**
   * The project this client is associated with.
   * Undefined for global-scope MCP clients that haven't been associated yet.
   */
  get projectPath(): string | undefined {
    return this._projectPath
  }

  /**
   * Associate this client with a project path.
   * Used for global-scope MCP clients on first tool call with cwd.
   */
  associateProject(projectPath: string): void {
    this._projectPath = projectPath
  }

  /**
   * M15.8: freeze the IDE name that `mcp_session_start` was just emitted with.
   * Called immediately before `analyticsClient.track('mcp_session_start')`
   * in ClientManager. The matching `mcp_session_ended` reads this value
   * instead of the live `agentName` to guarantee start/end correlation.
   */
  markMcpSessionStartEmitted(emittedName: string): void {
    this._mcpSessionEmittedName = emittedName
  }

  /**
   * Set the agent name for this MCP client.
   * Called after MCP initialize handshake provides clientInfo.
   */
  setAgentName(agentName: string): void {
    this._agentName = agentName
  }

  /**
   * Update this client's project path, even if already associated.
   * Used for reassociation after worktree add/remove operations.
   *
   * @returns The previous project path (undefined if not previously associated)
   */
  updateProjectPath(projectPath: string): string | undefined {
    const oldPath = this._projectPath
    this._projectPath = projectPath

    return oldPath
  }
}
