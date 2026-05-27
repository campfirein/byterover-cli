import path from 'node:path'

import type {Agent} from '../../../core/domain/entities/agent.js'
import type {McpServerConfig} from '../../../core/interfaces/storage/i-mcp-config-writer.js'

import {resolveHermesHome} from '../shared/agent-path-resolver.js'
import {getClaudeDesktopConfigPath} from './claude-desktop-config-path.js'

/**
 * Supported MCP config file formats.
 */
export type McpConfigFormat = 'json' | 'toml' | 'yaml'

/**
 * Supported MCP config scope.
 */
export type McpConfigScope = 'global' | 'project'

/**
 * Installation mode for MCP connector.
 * - 'auto': Automatically write config file
 * - 'manual': Show instructions for user to configure manually
 */
export type McpConfigMode = 'auto' | 'manual'

/**
 * Base configuration shared by all MCP connector configs.
 */
type McpConnectorConfigBase = {
  /** Path to the MCP config file (relative to project root). Used when scope is 'project'. */
  configPath?: string
  /**
   * Function that returns an absolute path to the config file.
   * Takes precedence over configPath when present.
   * Used when the path varies by platform (e.g., Claude Desktop).
   */
  configPathResolver?: () => string
  /** Config file format */
  format: McpConfigFormat
  /** Guide URL or instructions for manual setup. Required when mode is 'manual'. */
  manualGuide?: string
  /** Installation mode: 'auto' writes config, 'manual' shows instructions. Defaults to 'auto'. */
  mode: McpConfigMode
  /** Whether this config is project-level or global (user-level). Defaults to 'project'. */
  scope: McpConfigScope
  /** The MCP server configuration to inject */
  serverConfig: McpServerConfig
}

/**
 * JSON format configuration - uses key path navigation.
 */
export type JsonMcpConnectorConfig = McpConnectorConfigBase & {
  format: 'json'
  /**
   * JSON key path to the mcpServers object, including server name.
   * e.g., ['mcpServers', 'brv']
   */
  serverKeyPath: readonly string[]
}

/**
 * TOML format configuration - uses marker-based replacement.
 */
export type TomlMcpConnectorConfig = McpConnectorConfigBase & {
  format: 'toml'
  /**
   * The server name to use in the TOML section header.
   * e.g., 'brv' produces [mcp_servers.brv]
   */
  serverName: string
}

/**
 * YAML format configuration - uses key path navigation.
 */
export type YamlMcpConnectorConfig = McpConnectorConfigBase & {
  format: 'yaml'
  /**
   * YAML key path to the MCP server entry, including server name.
   * e.g., ['mcp_servers', 'brv'] navigates to { mcp_servers: { brv: ... } }
   */
  serverKeyPath: readonly string[]
}

/**
 * Configuration for agent-specific MCP settings.
 */
export type McpConnectorConfig = JsonMcpConnectorConfig | TomlMcpConnectorConfig | YamlMcpConnectorConfig

/* eslint-disable perfectionist/sort-objects */
/** Default MCP server configuration */
const DEFAULT_SERVER_CONFIG: McpServerConfig = {
  command: 'brv',
  args: ['mcp'],
}
/* eslint-enable */

/** Standard key path used by most JSON agents */
const STANDARD_KEY_PATH = ['mcpServers', 'brv'] as const

/** Standard server name used by TOML agents */
const STANDARD_SERVER_NAME = 'brv'

/* eslint-disable perfectionist/sort-objects */
/**
 * Agent-specific MCP configurations.
 * Maps each supported agent to its configuration details.
 */
export const MCP_CONNECTOR_CONFIGS = {
  Amp: {
    configPath: '.vscode/settings.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: ['amp.mcpServers', 'brv'],
  },
  Antigravity: {
    configPath: '.gemini/antigravity/mcp_config.json',
    format: 'json',
    mode: 'auto',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Auggie CLI': {
    format: 'json',
    manualGuide: 'https://docs.augmentcode.com/cli/integrations#configure-mcp-via-settings-json',
    mode: 'manual',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Augment Code': {
    format: 'json',
    manualGuide: 'https://docs.augmentcode.com/setup-augment/mcp#import-from-json',
    mode: 'manual',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Claude Code': {
    configPath: '.mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: {
      type: 'stdio',
      command: 'brv',
      args: ['mcp'],
      env: {},
    },
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Claude Desktop': {
    configPathResolver: getClaudeDesktopConfigPath,
    format: 'json',
    mode: 'auto',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  Cline: {
    format: 'json',
    manualGuide: 'https://docs.cline.bot/mcp/configuring-mcp-servers#editing-mcp-settings-files',
    mode: 'manual',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  Codex: {
    configPath: '.codex/config.toml',
    format: 'toml',
    mode: 'auto',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverName: STANDARD_SERVER_NAME,
  },
  Cursor: {
    configPath: '.cursor/mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Gemini CLI': {
    configPath: '.gemini/settings.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Github Copilot': {
    configPath: '.vscode/mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: ['servers', 'brv'],
  },
  Hermes: {
    configPathResolver: () => path.join(resolveHermesHome(), 'config.yaml'),
    format: 'yaml',
    mode: 'auto',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: ['mcp_servers', 'brv'],
  },
  Junie: {
    configPath: '.junie/mcp/mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Kilo Code': {
    configPath: '.kilocode/mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  Kiro: {
    configPath: '.kiro/settings/mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  OpenClaude: {
    configPath: '.mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: {
      type: 'stdio',
      command: 'brv',
      args: ['mcp'],
      env: {},
    },
    serverKeyPath: STANDARD_KEY_PATH,
  },
  OpenCode: {
    format: 'json',
    manualGuide: 'https://opencode.ai/docs/mcp-servers/#manage',
    mode: 'manual',
    scope: 'global',
    serverConfig: {
      type: 'local',
      command: ['brv', 'mcp'],
    },
    serverKeyPath: ['mcp', 'brv'],
  },
  Qoder: {
    format: 'json',
    manualGuide: 'https://docs.qoder.com/user-guide/chat/model-context-protocol#configure-mcp-servers',
    mode: 'manual',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Qwen Code': {
    manualGuide:
      'https://qwenlm.github.io/qwen-code-docs/en/developers/tools/mcp-server/#configure-the-mcp-server-in-settingsjson',
    format: 'json',
    mode: 'manual',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Roo Code': {
    configPath: '.roo/mcp.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  'Trae.ai': {
    format: 'json',
    manualGuide: 'https://docs.trae.ai/ide/add-mcp-servers?_lang=en#dccd4df8',
    mode: 'manual',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  Warp: {
    format: 'json',
    manualGuide: 'https://docs.warp.dev/knowledge-and-collaboration/mcp#adding-an-mcp-server',
    mode: 'manual',
    scope: 'global',
    serverConfig: {
      args: ['mcp'],
      command: 'brv',
      env: {},
      start_on_launch: true, // eslint-disable-line camelcase
      working_directory: null, // eslint-disable-line camelcase
    },
    serverKeyPath: STANDARD_KEY_PATH,
  },
  Windsurf: {
    configPath: '.codeium/windsurf/mcp_config.json',
    format: 'json',
    mode: 'auto',
    scope: 'global',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: STANDARD_KEY_PATH,
  },
  Zed: {
    configPath: '/.zed/settings.json',
    format: 'json',
    mode: 'auto',
    scope: 'project',
    serverConfig: DEFAULT_SERVER_CONFIG,
    serverKeyPath: ['context_servers', 'brv'],
  },
} as const satisfies Partial<Record<Agent, McpConnectorConfig>>
/* eslint-enable */

/**
 * Type representing agents that have MCP connector support.
 * Derived from the keys of MCP_CONNECTOR_CONFIGS.
 */
export type McpSupportedAgent = keyof typeof MCP_CONNECTOR_CONFIGS
