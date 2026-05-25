import {
  type ConnectionState,
  connectToDaemon,
  type ConnectToDaemonOptions,
  createDaemonReconnector,
  type DaemonReconnectorHandle,
  type ITransportClient,
  versionsAreEquivalent,
} from '@campfirein/brv-transport-client'
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'

import type {McpStartupProjectContext} from './tools/mcp-project-context.js'

import {TransportClientEventNames} from '../../core/domain/transport/schemas.js'
import {resolveLocalServerMainPath} from '../../utils/server-main-resolver.js'
import {detectMcpMode, type McpMode} from './mcp-mode-detector.js'
import {registerBrvCurateTool, registerBrvQueryTool} from './tools/index.js'

export interface McpServerConfig {
  /** CLI version for MCP server identification */
  version: string
  /** Working directory for file operations */
  workingDirectory: string
}

/**
 * ByteRover MCP Server.
 *
 * Exposes brv-query and brv-curate as MCP tools for coding agents.
 * Connects to a running brv instance via Socket.IO transport.
 *
 * Architecture:
 * - Coding agent spawns `brv mcp` process
 * - MCP server connects to running brv instance via Socket.IO
 * - MCP tools create tasks via transport
 * - Tasks are executed by the existing agent process
 */
export class ByteRoverMcpServer {
  /** Cached agent name from MCP initialize handshake, re-sent on reconnect */
  private _agentName: string | undefined
  private client: ITransportClient | undefined
  private readonly config: McpServerConfig
  private readonly connectOptions: ConnectToDaemonOptions
  private heartbeatInterval: NodeJS.Timeout | undefined
  private readonly mode: McpMode
  private readonly projectRoot: string | undefined
  private reconnectorHandle: DaemonReconnectorHandle | undefined
  private readonly server: McpServer
  private transport: StdioServerTransport | undefined
  private readonly worktreeRoot: string | undefined

  constructor(config: McpServerConfig) {
    this.config = config
    const modeResult = detectMcpMode(config.workingDirectory)
    this.mode = modeResult.mode
    this.projectRoot = modeResult.mode === 'project' ? modeResult.projectRoot : undefined
    this.worktreeRoot = modeResult.mode === 'project' ? modeResult.worktreeRoot : undefined
    this.server = new McpServer(
      {
        name: 'byterover',
        version: config.version,
      },
      {
        instructions:
          'ByteRover MCP — curate and query project context trees. ' +
          'See the `cwd` parameter description on each tool for how to provide the project path correctly.',
      },
    )

    this.connectOptions = {
      clientType: 'mcp',
      fromDir: config.workingDirectory,
      serverPath: resolveLocalServerMainPath(),
      version: config.version,
      ...(this.mode === 'project' && this.projectRoot ? {projectPath: this.projectRoot} : {}),
    }

    const getStartupProjectContext = (): McpStartupProjectContext | undefined =>
      this.mode === 'project' && this.projectRoot && this.worktreeRoot
        ? {projectRoot: this.projectRoot, worktreeRoot: this.worktreeRoot}
        : undefined

    // Register tools with lazy client getter
    // Client will be set when start() is called
    registerBrvQueryTool(
      this.server,
      () => this.client,
      () => this.getWorkingDirectory(),
      getStartupProjectContext,
      config.version,
    )
    registerBrvCurateTool(
      this.server,
      () => this.client,
      () => this.getWorkingDirectory(),
      getStartupProjectContext,
      config.version,
    )
  }

  /**
   * Starts the MCP server.
   *
   * 1. Connects to running brv instance via Socket.IO
   * 2. Starts MCP server with stdio transport
   *
   * @throws NoInstanceRunningError - No brv instance is running
   * @throws ConnectionFailedError - Failed to connect to brv instance
   */
  async start(): Promise<void> {
    this.log('Starting MCP server...')
    this.log(`Working directory: ${this.config.workingDirectory}`)
    this.log(`Mode: ${this.mode}`)

    // Connect to running brv instance via connectToDaemon (single entry point)
    // Project mode: registers with projectPath for project-scoped events
    // Global mode: registers WITHOUT projectPath (serves multiple projects)
    this.log('Connecting to brv instance...')

    const result = await connectToDaemon(this.connectOptions)

    this.client = result.client

    this.log(`Connected to brv instance at ${result.projectRoot}`)
    this.log(`Client ID: ${result.client.getClientId()}`)
    this.log(`Initial connection state: ${result.client.getState()}`)
    this.logDaemonVersionDrift(result.client.getDaemonVersion?.())

    // Auto-reconnect on disconnect (shared logic from brv-transport-client)
    this.reconnectorHandle = createDaemonReconnector(result.client, {
      connectOptions: this.connectOptions,
      onReconnected: (newClient: ITransportClient) => {
        this.client = newClient
        this.log(`Reconnected successfully! Client ID: ${newClient.getClientId()}`)
        this.logDaemonVersionDrift(newClient.getDaemonVersion?.())
        this.sendAgentName()
      },
      onStateChange: (state: ConnectionState) => {
        const timestamp = new Date().toISOString()
        this.log(`[${timestamp}] Connection state changed: ${state}`)
        // Socket.IO built-in reconnect: re-send agent name for new server-side clientId
        if (state === 'connected') {
          this.sendAgentName()
        }
      },
    })

    // Capture the coding agent's identity after MCP initialize handshake
    this.server.server.oninitialized = () => {
      const clientVersion = this.server.server.getClientVersion()
      if (clientVersion?.name && this.client) {
        this._agentName = clientVersion.name
        this.log(`MCP client identified: ${clientVersion.name} v${clientVersion.version}`)
        this.sendAgentName()
      } else {
        this.log('MCP client did not provide clientInfo name')
      }
    }

    // Start MCP server with stdio transport
    this.transport = new StdioServerTransport()
    await this.server.connect(this.transport)

    this.log('MCP server started and ready for tool calls')

    // Log client state periodically to debug connection issues
    this.heartbeatInterval = setInterval(() => {
      if (this.client) {
        this.log(`[heartbeat] Client state: ${this.client.getState()}, ID: ${this.client.getClientId()}`)
      } else {
        this.log('[heartbeat] Client is undefined!')
      }
    }, 10_000)
  }

  /**
   * Stops the MCP server.
   *
   * Order: stop background work first (reconnector, heartbeat), then drop
   * the daemon connection so any in-flight tool handler awaiting daemon work
   * surfaces a clean MCP error response, THEN close the MCP SDK server so
   * those error responses still travel back to the parent before the stdio
   * transport seals.
   */
  async stop(): Promise<void> {
    // Cancel auto-reconnection
    this.reconnectorHandle?.cancel()
    this.reconnectorHandle = undefined

    // Clear heartbeat interval
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = undefined
    }

    // Disconnect daemon first — in-flight tool handlers reject with a clean
    // "Connection lost" error that can still be delivered over the open MCP
    // transport (see task-result-waiter onStateChange handler).
    if (this.client) {
      await this.client.disconnect()
      this.client = undefined
    }

    // Then close the MCP SDK server (final stdio teardown).
    await this.server.close()
  }

  /**
   * Returns the project root directory for MCP tool calls.
   *
   * In project mode, returns the discovered project root (where .brv/config.json lives).
   * In global mode, returns undefined — each tool call must provide cwd.
   */
  private getWorkingDirectory(): string | undefined {
    return this.mode === 'project' ? this.worktreeRoot : undefined
  }

  /**
   * Log to stderr (stdout is reserved for MCP protocol).
   */
  private log(msg: string): void {
    process.stderr.write(`[brv-mcp] ${msg}\n`)
  }

  /**
   * Logs a one-line drift notice when the running daemon's version differs
   * from this MCP's. Helps users notice an out-of-sync IDE without forcing
   * a reconnect — the protocol is backward-compatible across the gap.
   */
  private logDaemonVersionDrift(daemonVersion: string | undefined): void {
    if (daemonVersion && !versionsAreEquivalent(this.config.version, daemonVersion)) {
      this.log(
        `connected to daemon ${daemonVersion}; this MCP is ${this.config.version} (backward-compatible protocol)`,
      )
    }
  }

  /**
   * Sends the cached agent name to the daemon (fire-and-forget).
   * Called after MCP initialize handshake and on Socket.IO reconnection.
   */
  private sendAgentName(): void {
    if (!this._agentName || !this.client) return

    this.client
      .requestWithAck(TransportClientEventNames.UPDATE_AGENT_NAME, {agentName: this._agentName})
      .catch((error: unknown) => {
        this.log(`Failed to send agent name: ${error instanceof Error ? error.message : String(error)}`)
      })
  }
}
