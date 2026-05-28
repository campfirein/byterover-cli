import {dump as yamlDump} from 'js-yaml'
import {set} from 'lodash-es'
import os from 'node:os'
import path from 'node:path'

import type {Agent} from '../../../core/domain/entities/agent.js'
import type {ConnectorType} from '../../../core/domain/entities/connector-type.js'
import type {
  ConnectorInstallResult,
  ConnectorStatus,
  ConnectorUninstallResult,
} from '../../../core/interfaces/connectors/connector-types.js'
import type {ConnectorOperationOptions, IConnector} from '../../../core/interfaces/connectors/i-connector.js'
import type {IFileService} from '../../../core/interfaces/services/i-file-service.js'
import type {IRuleTemplateService} from '../../../core/interfaces/services/i-rule-template-service.js'
import type {IMcpConfigWriter} from '../../../core/interfaces/storage/i-mcp-config-writer.js'
import type {McpConnectorConfig, McpSupportedAgent} from './mcp-connector-config.js'

import {AGENT_CONNECTOR_CONFIG} from '../../../core/domain/entities/agent.js'
import {RULES_CONNECTOR_CONFIGS} from '../rules/rules-connector-config.js'
import {BRV_RULE_MARKERS, hasMcpToolsInBrvSection} from '../shared/constants.js'
import {RuleFileManager} from '../shared/rule-file-manager.js'
import {JsonMcpConfigWriter} from './json-mcp-config-writer.js'
import {MCP_CONNECTOR_CONFIGS} from './mcp-connector-config.js'
import {TomlMcpConfigWriter} from './toml-mcp-config-writer.js'
import {YamlMcpConfigWriter} from './yaml-mcp-config-writer.js'

/**
 * Options for constructing McpConnector.
 */
type McpConnectorOptions = {
  fileService: IFileService
  projectRoot: string
  templateService: IRuleTemplateService
}

/**
 * Connector that integrates BRV with coding agents via MCP configuration.
 * Manages MCP server entries in agent-specific configuration files.
 * Also installs rule files with MCP-specific content.
 *
 * Key safety features:
 * - Non-destructive: Preserves user's existing MCP servers and other config
 * - No duplicates: Checks before adding new server entry
 * - Safe uninstall: Only removes ByteRover's MCP server entry and rule content
 */
export class McpConnector implements IConnector {
  readonly connectorType: ConnectorType = 'mcp'
  private readonly fileService: IFileService
  private readonly projectRoot: string
  private readonly ruleFileManager: RuleFileManager
  private readonly supportedAgents: Agent[]
  private readonly templateService: IRuleTemplateService

  constructor(options: McpConnectorOptions) {
    this.fileService = options.fileService
    this.projectRoot = options.projectRoot
    this.templateService = options.templateService
    this.ruleFileManager = new RuleFileManager({
      fileService: options.fileService,
      projectRoot: options.projectRoot,
    })
    this.supportedAgents = Object.entries(AGENT_CONNECTOR_CONFIG)
      .filter(([_, config]) => config.supported.includes(this.connectorType))
      .map(([agent]) => agent as Agent)
  }

  getConfigPath(agent: Agent): string {
    if (!this.isSupported(agent)) {
      throw new Error(`MCP connector does not support agent: ${agent}`)
    }

    const config = MCP_CONNECTOR_CONFIGS[agent as McpSupportedAgent]
    return this.getFullConfigPath(config)
  }

  getSupportedAgents(): Agent[] {
    return this.supportedAgents
  }

  async install(agent: Agent): Promise<ConnectorInstallResult> {
    if (!this.isSupported(agent)) {
      return {
        alreadyInstalled: false,
        configPath: '',
        message: `MCP connector does not support agent: ${agent}`,
        success: false,
      }
    }

    const config = MCP_CONNECTOR_CONFIGS[agent as McpSupportedAgent]

    // Handle manual mode - return instructions instead of writing files
    if (config.mode === 'manual') {
      // Still install the rule file for manual mode
      await this.installRuleFile(agent)
      return this.installManual(agent, config)
    }

    return this.installAutomatic(agent, config)
  }

  isSupported(agent: Agent): agent is McpSupportedAgent {
    return agent in MCP_CONNECTOR_CONFIGS && AGENT_CONNECTOR_CONFIG[agent].supported.includes(this.connectorType)
  }

  async status(agent: Agent, options?: ConnectorOperationOptions): Promise<ConnectorStatus> {
    if (!options?.force && !this.isSupported(agent)) {
      return {
        configExists: false,
        configPath: '',
        error: `MCP connector does not support agent: ${agent}`,
        installed: false,
      }
    }

    if (!(agent in MCP_CONNECTOR_CONFIGS)) {
      return {
        configExists: false,
        configPath: '',
        installed: false,
      }
    }

    const config = MCP_CONNECTOR_CONFIGS[agent as McpSupportedAgent]

    // For manual mode, check if the rule file has MCP content
    if (config.mode === 'manual') {
      return this.statusManual(agent)
    }

    return this.statusAutomatic(agent, config)
  }

  async uninstall(agent: Agent, options?: ConnectorOperationOptions): Promise<ConnectorUninstallResult> {
    if (!options?.force && !this.isSupported(agent)) {
      return {
        configPath: '',
        message: `MCP connector does not support agent: ${agent}`,
        success: false,
        wasInstalled: false,
      }
    }

    if (!(agent in MCP_CONNECTOR_CONFIGS)) {
      return {
        configPath: '',
        message: `MCP connector has no config for agent: ${agent}`,
        success: true,
        wasInstalled: false,
      }
    }

    const config = MCP_CONNECTOR_CONFIGS[agent as McpSupportedAgent]
    const fullPath = this.getFullConfigPath(config)
    const writer = this.createWriter(config)

    try {
      // Uninstall rule file first
      await this.uninstallRuleFile(agent)

      const {fileExists} = await writer.exists(fullPath)

      if (!fileExists) {
        return {
          configPath: fullPath,
          message: `Config file does not exist: ${fullPath}`,
          success: true,
          wasInstalled: false,
        }
      }

      const wasRemoved = await writer.remove(fullPath)

      if (!wasRemoved) {
        return {
          configPath: fullPath,
          message: `MCP connector is not installed for ${agent}`,
          success: true,
          wasInstalled: false,
        }
      }

      return {
        configPath: fullPath,
        message: `MCP connector uninstalled for ${agent}`,
        success: true,
        wasInstalled: true,
      }
    } catch (error) {
      return {
        configPath: fullPath,
        message: `Failed to uninstall MCP connector for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
        wasInstalled: false,
      }
    }
  }

  /**
   * Create the appropriate config writer for the given agent config.
   */
  private createWriter(config: McpConnectorConfig): IMcpConfigWriter {
    if (config.format === 'json') {
      return new JsonMcpConfigWriter({
        fileService: this.fileService,
        serverKeyPath: config.serverKeyPath,
      })
    }

    if (config.format === 'yaml') {
      return new YamlMcpConfigWriter({
        fileService: this.fileService,
        serverKeyPath: config.serverKeyPath,
      })
    }

    return new TomlMcpConfigWriter({
      fileService: this.fileService,
      serverName: config.serverName,
    })
  }

  /**
   * Format the config content for display based on format type.
   */
  private formatConfigContent(config: McpConnectorConfig): string {
    if (config.format === 'json') {
      const result = set({}, config.serverKeyPath, config.serverConfig)
      return JSON.stringify(result, null, 2)
    }

    if (config.format === 'yaml') {
      const result = set({}, config.serverKeyPath, config.serverConfig)
      return yamlDump(result)
    }

    const lines = [`[mcp_servers.${config.serverName}]`]
    for (const [key, value] of Object.entries(config.serverConfig)) {
      if (typeof value === 'string') {
        lines.push(`${key} = "${value}"`)
      } else if (Array.isArray(value)) {
        lines.push(`${key} = ${JSON.stringify(value)}`)
      } else if (value === null) {
        // Skip null values in TOML
      } else {
        lines.push(`${key} = ${JSON.stringify(value)}`)
      }
    }

    return lines.join('\n')
  }

  /**
   * Get the full (absolute) config path for file operations.
   * - Project scope: relative to project root
   * - Global scope: relative to os.homedir()
   */
  private getFullConfigPath(config: McpConnectorConfig): string {
    if (config.configPathResolver) {
      return config.configPathResolver()
    }

    if (!config.configPath) {
      return ''
    }

    if (config.scope === 'global') {
      return path.join(os.homedir(), config.configPath)
    }

    return path.join(this.projectRoot, config.configPath)
  }

  /**
   * Install connector automatically by writing to config file.
   */
  private async installAutomatic(agent: Agent, config: McpConnectorConfig): Promise<ConnectorInstallResult> {
    const fullPath = this.getFullConfigPath(config)
    const writer = this.createWriter(config)

    try {
      const {fileExists, serverExists} = await writer.exists(fullPath)

      if (serverExists) {
        return {
          alreadyInstalled: true,
          configPath: fullPath,
          message: `MCP connector is already installed for ${agent}`,
          success: true,
        }
      }

      await writer.write(fullPath, config.serverConfig)

      // Also install the rule file with MCP-specific content
      await this.installRuleFile(agent)

      return {
        alreadyInstalled: false,
        configPath: fullPath,
        message: fileExists
          ? `MCP connector installed for ${agent}`
          : `MCP connector installed for ${agent} (created ${fullPath})`,
        success: true,
      }
    } catch (error) {
      return {
        alreadyInstalled: false,
        configPath: fullPath,
        message: `Failed to install MCP connector for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
      }
    }
  }

  /**
   * Generate manual installation instructions for the user.
   */
  private installManual(agent: Agent, config: McpConnectorConfig): ConnectorInstallResult {
    const fullPath = this.getFullConfigPath(config)
    const configContent = this.formatConfigContent(config)

    return {
      alreadyInstalled: false,
      configPath: fullPath,
      manualInstructions: {
        configContent,
        guide: config.manualGuide ?? '',
      },
      message: `Manual setup required for ${agent}`,
      requiresManualSetup: true,
      success: true,
    }
  }

  /**
   * Install the rule file with MCP-specific content.
   */
  private async installRuleFile(agent: Agent): Promise<void> {
    const rulesConfig =
      agent in RULES_CONNECTOR_CONFIGS
        ? RULES_CONNECTOR_CONFIGS[agent as keyof typeof RULES_CONNECTOR_CONFIGS]
        : undefined
    if (!rulesConfig) {
      return
    }

    const ruleContent = await this.templateService.generateRuleContent(agent, this.connectorType)
    await this.ruleFileManager.install(rulesConfig.filePath, rulesConfig.writeMode, ruleContent)
  }

  /**
   * Get status for auto mode by checking MCP config file.
   */
  private async statusAutomatic(agent: Agent, config: McpConnectorConfig): Promise<ConnectorStatus> {
    const fullPath = this.getFullConfigPath(config)
    const writer = this.createWriter(config)

    try {
      const {fileExists, serverExists} = await writer.exists(fullPath)

      return {
        configExists: fileExists,
        configPath: fullPath,
        installed: serverExists,
      }
    } catch (error) {
      return {
        configExists: true,
        configPath: fullPath,
        error: error instanceof Error ? error.message : String(error),
        installed: false,
      }
    }
  }

  /**
   * Get status for manual mode by checking if rule file has MCP content.
   * Checks for markers AND MCP-specific tool references (brv-query, brv-curate).
   */
  private async statusManual(agent: Agent): Promise<ConnectorStatus> {
    const rulesConfig =
      agent in RULES_CONNECTOR_CONFIGS
        ? RULES_CONNECTOR_CONFIGS[agent as keyof typeof RULES_CONNECTOR_CONFIGS]
        : undefined
    if (!rulesConfig) {
      return {
        configExists: false,
        configPath: '',
        installed: false,
      }
    }

    const fullPath = path.join(this.projectRoot, rulesConfig.filePath)
    const fileExists = await this.fileService.exists(fullPath)

    if (!fileExists) {
      return {
        configExists: false,
        configPath: rulesConfig.filePath,
        installed: false,
      }
    }

    const content = await this.fileService.read(fullPath)
    const hasMarkers = content.includes(BRV_RULE_MARKERS.START) && content.includes(BRV_RULE_MARKERS.END)
    const hasMcpTools = hasMcpToolsInBrvSection(content)

    return {
      configExists: true,
      configPath: rulesConfig.filePath,
      installed: hasMarkers && hasMcpTools,
    }
  }

  /**
   * Uninstall the rule file content.
   */
  private async uninstallRuleFile(agent: Agent): Promise<void> {
    const rulesConfig =
      agent in RULES_CONNECTOR_CONFIGS
        ? RULES_CONNECTOR_CONFIGS[agent as keyof typeof RULES_CONNECTOR_CONFIGS]
        : undefined
    if (!rulesConfig) {
      return
    }

    await this.ruleFileManager.uninstall(rulesConfig.filePath, rulesConfig.writeMode)
  }
}
