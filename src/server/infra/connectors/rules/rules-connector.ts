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

import {AGENT_CONNECTOR_CONFIG} from '../../../core/domain/entities/agent.js'
import {extractInstalledAgentFromBrvSection, hasMcpToolsInBrvSection} from '../shared/constants.js'
import {RuleFileManager} from '../shared/rule-file-manager.js'
import {RULES_CONNECTOR_CONFIGS} from './rules-connector-config.js'

/**
 * Options for constructing RulesConnector.
 */
type RulesConnectorOptions = {
  fileService: IFileService
  projectRoot: string
  templateService: IRuleTemplateService
}

/**
 * Connector that integrates BRV with coding agents via rule files.
 * Manages the installation, uninstallation, and status of rule files.
 */
export class RulesConnector implements IConnector {
  readonly connectorType: ConnectorType = 'rules'
  private readonly fileService: IFileService
  private readonly projectRoot: string
  private readonly ruleFileManager: RuleFileManager
  private readonly supportedAgents: Agent[]
  private readonly templateService: IRuleTemplateService

  constructor(options: RulesConnectorOptions) {
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
    const config = agent in RULES_CONNECTOR_CONFIGS ? RULES_CONNECTOR_CONFIGS[agent as keyof typeof RULES_CONNECTOR_CONFIGS] : undefined
    if (!config) {
      throw new Error(`Rules connector does not support agent: ${agent}`)
    }

    return config.filePath
  }

  getSupportedAgents(): Agent[] {
    return this.supportedAgents
  }

  async install(agent: Agent): Promise<ConnectorInstallResult> {
    const config = agent in RULES_CONNECTOR_CONFIGS ? RULES_CONNECTOR_CONFIGS[agent as keyof typeof RULES_CONNECTOR_CONFIGS] : undefined
    if (!config) {
      return {
        alreadyInstalled: false,
        configPath: '',
        message: `Rules connector does not support agent: ${agent}`,
        success: false,
      }
    }

    try {
      const ruleContent = await this.templateService.generateRuleContent(agent, this.connectorType)
      // Write the rule content to the file
      await this.ruleFileManager.install(config.filePath, config.writeMode, ruleContent)

      return {
        alreadyInstalled: false,
        configPath: config.filePath,
        message: `Rules connector installed for ${agent} (created ${config.filePath})`,
        success: true,
      }
    } catch (error) {
      return {
        alreadyInstalled: false,
        configPath: config.filePath,
        message: `Failed to install rules connector for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
      }
    }
  }

  isSupported(agent: Agent): boolean {
    return AGENT_CONNECTOR_CONFIG[agent].supported.includes(this.connectorType)
  }

  async status(agent: Agent, options?: ConnectorOperationOptions): Promise<ConnectorStatus> {
    if (!options?.force && !this.isSupported(agent)) {
      return {
        configExists: false,
        configPath: '',
        error: `Rules connector does not support agent: ${agent}`,
        installed: false,
      }
    }

    const config = agent in RULES_CONNECTOR_CONFIGS ? RULES_CONNECTOR_CONFIGS[agent as keyof typeof RULES_CONNECTOR_CONFIGS] : undefined
    if (!config) {
      return {
        configExists: false,
        configPath: '',
        error: `Rules connector has no config for agent: ${agent}`,
        installed: false,
      }
    }

    const fullPath = path.join(this.projectRoot, config.filePath)

    try {
      const {fileExists, hasMarkers} = await this.ruleFileManager.status(config.filePath)

      if (!fileExists) {
        return {
          configExists: false,
          configPath: config.filePath,
          installed: false,
        }
      }

      const content = await this.fileService.read(fullPath)
      const hasMcpTools = hasMcpToolsInBrvSection(content)
      const footerAgent = extractInstalledAgentFromBrvSection(content)
      // Footer present: only the agent named in the footer owns this rule file.
      // Footer absent (legacy file pre-footer): fall back to marker presence so
      // existing installs keep reporting installed until the next reinstall.
      const matchesFooter = footerAgent === undefined ? true : footerAgent === agent
      const installed = hasMarkers && !hasMcpTools && matchesFooter

      return {
        configExists: true,
        configPath: config.filePath,
        installed,
      }
    } catch (error) {
      return {
        configExists: true,
        configPath: config.filePath,
        error: error instanceof Error ? error.message : String(error),
        installed: false,
      }
    }
  }

  async uninstall(agent: Agent, options?: ConnectorOperationOptions): Promise<ConnectorUninstallResult> {
    if (!options?.force && !this.isSupported(agent)) {
      return {
        configPath: '',
        message: `Rules connector does not support agent: ${agent}`,
        success: false,
        wasInstalled: false,
      }
    }

    const config = agent in RULES_CONNECTOR_CONFIGS ? RULES_CONNECTOR_CONFIGS[agent as keyof typeof RULES_CONNECTOR_CONFIGS] : undefined
    if (!config) {
      return {
        configPath: '',
        message: `Rules connector has no config for agent: ${agent}`,
        success: false,
        wasInstalled: false,
      }
    }

    try {
      const {fileExists, hasLegacyTag, hasMarkers} = await this.ruleFileManager.status(config.filePath)

      if (!fileExists) {
        return {
          configPath: config.filePath,
          message: `Rule file does not exist: ${config.filePath}`,
          success: true,
          wasInstalled: false,
        }
      }

      if (!hasMarkers) {
        if (!hasLegacyTag) {
          return {
            configPath: config.filePath,
            message: `Rules connector is not installed for ${agent}`,
            success: true,
            wasInstalled: false,
          }
        }

        // Legacy format detected - cannot safely uninstall
        return {
          configPath: config.filePath,
          message: `Legacy rules detected for ${agent}. Please manually remove the old rules section.`,
          success: false,
          wasInstalled: true,
        }
      }

      const result = await this.ruleFileManager.uninstall(config.filePath, config.writeMode)

      return {
        configPath: config.filePath,
        message: result.wasInstalled
          ? `Rules connector uninstalled for ${agent}`
          : `Rules connector is not installed for ${agent}`,
        success: true,
        wasInstalled: result.wasInstalled,
      }
    } catch (error) {
      return {
        configPath: config.filePath,
        message: `Failed to uninstall rules connector for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
        wasInstalled: true,
      }
    }
  }
}
