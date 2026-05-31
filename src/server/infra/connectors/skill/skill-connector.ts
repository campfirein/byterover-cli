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
import type {SkillConnectorConfig, SkillSupportedAgent} from './skill-connector-config.js'

import {AGENT_CONNECTOR_CONFIG} from '../../../core/domain/entities/agent.js'
import {resolveUserPath} from '../shared/agent-path-resolver.js'
import {
  hasAutonomousAgentBlocks,
  removeAutonomousAgentBlocks,
  upsertAutonomousAgentBlocks,
} from './autonomous-agent-attachments.js'
import {
  BRV_SKILL_NAME,
  MAIN_SKILL_FILE_NAME,
  SKILL_CONNECTOR_CONFIGS,
  SKILL_FILE_NAMES,
} from './skill-connector-config.js'
import {SkillContentLoader} from './skill-content-loader.js'
import {resolveSkillDisplayPath, resolveSkillGlobalBasePath} from './skill-path-resolver.js'

const BYTEROVER_BLOCK_SECTION_NAME = 'byterover-rules-block'

/**
 * Options for constructing SkillConnector.
 */
type SkillConnectorOptions = {
  env?: NodeJS.ProcessEnv
  fileService: IFileService
  homeDir?: string
  projectRoot: string
}

/**
 * Parameters for {@link SkillConnector.writeSkillFiles}.
 */
export type WriteSkillFilesParams = {
  agent: Agent
  files: Array<{content: string; name: string}>
  /** 'global' writes to home dir, 'project' (default) writes to project root. */
  scope?: 'global' | 'project'
  /** Skill folder name to create under the connector path. */
  skillName: string
}

/**
 * Connector that integrates BRV with coding agents via skill files.
 * Writes static markdown files (SKILL.md)
 * into an agent-specific subdirectory.
 */
export class SkillConnector implements IConnector {
  readonly connectorType: ConnectorType = 'skill'
  private readonly contentLoader: SkillContentLoader
  private readonly env: NodeJS.ProcessEnv
  private readonly fileService: IFileService
  private readonly homeDir?: string
  private readonly projectRoot: string
  private readonly supportedAgents: Agent[]

  constructor(options: SkillConnectorOptions) {
    this.env = options.env ?? process.env
    this.fileService = options.fileService
    this.homeDir = options.homeDir
    this.projectRoot = options.projectRoot
    this.contentLoader = new SkillContentLoader(options.fileService)
    this.supportedAgents = Object.entries(AGENT_CONNECTOR_CONFIG)
      .filter(([_, config]) => config.supported.includes(this.connectorType))
      .map(([agent]) => agent as Agent)
  }

  getConfigPath(agent: Agent): string {
    if (!this.isSupported(agent)) {
      throw new Error(`Skill connector does not support agent: ${agent}`)
    }

    const config = this.getConfig(agent)
    const basePath = config.projectPath || config.globalPath
    if (!basePath) {
      throw new Error(`Skill connector has no configured path for agent: ${agent}`)
    }

    return path.join(resolveSkillDisplayPath(config, basePath, this.pathResolverOptions()), BRV_SKILL_NAME)
  }

  getSupportedAgents(): Agent[] {
    return this.supportedAgents
  }

  async install(agent: Agent): Promise<ConnectorInstallResult> {
    if (!this.isSupported(agent)) {
      return {
        alreadyInstalled: false,
        configPath: '',
        message: `Skill connector does not support agent: ${agent}`,
        success: false,
      }
    }

    const config = this.getConfig(agent)

    // Install the skill connector in the project directory by default
    if (!config.projectPath && !config.globalPath) {
      return {
        alreadyInstalled: false,
        configPath: '',
        message: `Skill connector has no configured path for agent: ${agent}`,
        success: false,
      }
    }

    // Install to project directory by default, fall back to global for global-only agents
    const scope = config.projectPath ? 'project' : 'global'
    const fullDir = this.resolveFullPath(config, scope, BRV_SKILL_NAME)

    try {
      const skillFilePath = path.join(fullDir, MAIN_SKILL_FILE_NAME)
      const alreadyInstalled = await this.fileService.exists(skillFilePath)

      await Promise.all(
        SKILL_FILE_NAMES.map(async (fileName) => {
          const content = await this.contentLoader.loadSkillFile(fileName)
          const filePath = path.join(fullDir, fileName)
          await this.fileService.write(content, filePath, 'overwrite')
        }),
      )

      if (config.agentFile) {
        const agentContent = await this.contentLoader.loadAgentFile(config.agentFile.source)
        const agentFilePath = this.resolveAgentFilePath(config, scope)
        await this.fileService.write(agentContent, agentFilePath, 'overwrite')
      }

      await this.upsertAutonomousAttachment(config)

      return {
        alreadyInstalled,
        configPath: fullDir,
        message: alreadyInstalled
          ? `Skill connector refreshed for ${agent}`
          : `Skill connector installed for ${agent} (created ${fullDir}/)`,
        success: true,
      }
    } catch (error) {
      return {
        alreadyInstalled: false,
        configPath: fullDir,
        message: `Failed to install skill connector for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
      }
    }
  }

  isSupported(agent: Agent): agent is SkillSupportedAgent {
    return agent in SKILL_CONNECTOR_CONFIGS && AGENT_CONNECTOR_CONFIG[agent].supported.includes(this.connectorType)
  }

  async status(agent: Agent, options?: ConnectorOperationOptions): Promise<ConnectorStatus> {
    if (!options?.force && !this.isSupported(agent)) {
      return {
        configExists: false,
        configPath: '',
        error: `Skill connector does not support agent: ${agent}`,
        installed: false,
      }
    }

    if (!(agent in SKILL_CONNECTOR_CONFIGS)) {
      return {
        configExists: false,
        configPath: '',
        installed: false,
      }
    }

    const config = this.getConfig(agent)

    try {
      // For attachment agents the always-loaded block is part of the install;
      // a present SKILL.md without it is an incomplete install that re-install
      // must be allowed to repair (it is otherwise short-circuited as "same type").
      const attachmentOk = await this.hasAutonomousAttachment(config)

      // Check project scope first
      if (config.projectPath) {
        const projectDir = this.resolveFullPath(config, 'project', BRV_SKILL_NAME)
        const filesOk = await this.hasAllManagedSkillFiles(projectDir)
        const agentFileOk = await this.hasAgentFile(config, 'project')
        if (attachmentOk && filesOk && agentFileOk) {
          return {
            configExists: true,
            configPath: path.join(
              resolveSkillDisplayPath(config, config.projectPath, this.pathResolverOptions()),
              BRV_SKILL_NAME,
            ),
            installed: true,
          }
        }
      }

      // Check global scope
      if (config.globalPath) {
        const globalDir = this.resolveFullPath(config, 'global', BRV_SKILL_NAME)
        const filesOk = await this.hasAllManagedSkillFiles(globalDir)
        const agentFileOk = await this.hasAgentFile(config, 'global')
        if (attachmentOk && filesOk && agentFileOk) {
          return {
            configExists: true,
            configPath: path.join(
              resolveSkillDisplayPath(config, config.globalPath, this.pathResolverOptions()),
              BRV_SKILL_NAME,
            ),
            installed: true,
          }
        }
      }

      return {
        configExists: false,
        configPath: '',
        installed: false,
      }
    } catch (error) {
      return {
        configExists: false,
        configPath: '',
        error: error instanceof Error ? error.message : String(error),
        installed: false,
      }
    }
  }

  async uninstall(agent: Agent, options?: ConnectorOperationOptions): Promise<ConnectorUninstallResult> {
    if (!options?.force && !this.isSupported(agent)) {
      return {
        configPath: '',
        message: `Skill connector does not support agent: ${agent}`,
        success: false,
        wasInstalled: false,
      }
    }

    if (!(agent in SKILL_CONNECTOR_CONFIGS)) {
      return {
        configPath: '',
        message: `Skill connector has no config for agent: ${agent}`,
        success: true,
        wasInstalled: false,
      }
    }

    const config = this.getConfig(agent)
    let removedAttachment = false

    try {
      // Try to uninstall from project scope
      if (config.projectPath) {
        const projectDir = this.resolveFullPath(config, 'project', BRV_SKILL_NAME)
        const projectSkillFile = path.join(projectDir, SKILL_FILE_NAMES[0])
        if (await this.fileService.exists(projectSkillFile)) {
          await this.deleteAgentFile(config, 'project')
          await this.fileService.deleteDirectory(projectDir)
          await this.removeAutonomousAttachment(config)
          return {
            configPath: path.join(
              resolveSkillDisplayPath(config, config.projectPath, this.pathResolverOptions()),
              BRV_SKILL_NAME,
            ),
            message: `Skill connector uninstalled for ${agent}`,
            success: true,
            wasInstalled: true,
          }
        }
      }

      // Try to uninstall from global scope
      if (config.globalPath) {
        const globalDir = this.resolveFullPath(config, 'global', BRV_SKILL_NAME)
        const globalSkillFile = path.join(globalDir, SKILL_FILE_NAMES[0])
        if (await this.fileService.exists(globalSkillFile)) {
          await this.deleteAgentFile(config, 'global')
          await this.fileService.deleteDirectory(globalDir)
          await this.removeAutonomousAttachment(config)
          return {
            configPath: path.join(
              resolveSkillDisplayPath(config, config.globalPath, this.pathResolverOptions()),
              BRV_SKILL_NAME,
            ),
            message: `Skill connector uninstalled for ${agent}`,
            success: true,
            wasInstalled: true,
          }
        }
      }

      removedAttachment = await this.removeAutonomousAttachment(config)
      return {
        configPath: '',
        message: removedAttachment
          ? `Skill connector block removed for ${agent}`
          : `Skill connector is not installed for ${agent}`,
        success: true,
        wasInstalled: removedAttachment,
      }
    } catch (error) {
      return {
        configPath: '',
        message: `Failed to uninstall skill connector for ${agent}: ${error instanceof Error ? error.message : String(error)}`,
        success: false,
        wasInstalled: true,
      }
    }
  }

  /**
   * Write files to a named skill subdirectory for the given agent.
   * Used by hub install to write downloaded skill files to e.g. `.claude/skills/{skillName}/`.
   */
  async writeSkillFiles(
    params: WriteSkillFilesParams,
  ): Promise<{alreadyInstalled: boolean; installedFiles: string[]; installedPath: string}> {
    const {agent, files, scope = 'project', skillName} = params
    if (!this.isSupported(agent)) {
      throw new Error(`Skill connector does not support agent: ${agent}`)
    }

    const config = this.getConfig(agent)
    const basePath = scope === 'global' ? config.globalPath : config.projectPath
    if (!basePath) {
      throw new Error(`Skill connector does not support ${scope} scope for agent: ${agent}`)
    }

    const fullDir = this.resolveFullPath(config, scope, skillName)
    const filesWithPaths = files.map((file) => ({
      ...file,
      filePath: path.join(fullDir, file.name),
    }))

    if (filesWithPaths.length > 0) {
      const existingFiles = await Promise.all(filesWithPaths.map((file) => this.fileService.exists(file.filePath)))
      if (existingFiles.every(Boolean)) {
        return {alreadyInstalled: true, installedFiles: [], installedPath: fullDir}
      }
    }

    const installedFiles: string[] = []
    await Promise.all(
      filesWithPaths.map(async (file) => {
        if (await this.fileService.exists(file.filePath)) return

        await this.fileService.write(file.content, file.filePath, 'overwrite')
        installedFiles.push(file.filePath)
      }),
    )

    return {alreadyInstalled: false, installedFiles, installedPath: fullDir}
  }

  /**
   * Delete the saved sub-agent file if the config declares one and the file
   * exists. No-op when `config.agentFile` is undefined.
   */
  private async deleteAgentFile(config: SkillConnectorConfig, scope: 'global' | 'project'): Promise<void> {
    if (!config.agentFile) return

    const agentFilePath = this.resolveAgentFilePath(config, scope)
    if (await this.fileService.exists(agentFilePath)) {
      await this.fileService.delete(agentFilePath)
    }
  }

  /**
   * Get the skill connector config for an agent, typed as SkillConnectorConfig
   * to allow safe optional property access on union types from `as const`.
   */
  private getConfig(agent: Agent): SkillConnectorConfig {
    return SKILL_CONNECTOR_CONFIGS[agent as SkillSupportedAgent]
  }

  private async hasAgentFile(config: SkillConnectorConfig, scope: 'global' | 'project'): Promise<boolean> {
    if (!config.agentFile) return true
    return this.fileService.exists(this.resolveAgentFilePath(config, scope))
  }

  private async hasAllManagedSkillFiles(skillDir: string): Promise<boolean> {
    const exists = await Promise.all(
      SKILL_FILE_NAMES.map((fileName) => this.fileService.exists(path.join(skillDir, fileName))),
    )
    return exists.every(Boolean)
  }

  private async hasAutonomousAttachment(config: SkillConnectorConfig): Promise<boolean> {
    if (!config.attachment) return true

    const blockContent = await this.loadByteroverBlockContent()
    return hasAutonomousAgentBlocks(config.attachment, blockContent, this.pathResolverOptions())
  }

  private async loadByteroverBlockContent(): Promise<string> {
    return this.contentLoader.loadSectionFile(BYTEROVER_BLOCK_SECTION_NAME)
  }

  private pathResolverOptions(): {env: NodeJS.ProcessEnv; homeDir?: string} {
    return {
      env: this.env,
      homeDir: this.homeDir,
    }
  }

  private async removeAutonomousAttachment(config: SkillConnectorConfig): Promise<boolean> {
    if (!config.attachment) return false

    return removeAutonomousAgentBlocks(config.attachment, this.pathResolverOptions())
  }

  /** Project root or home directory + config.agentFile.target. Custom global roots are unsupported. */
  private resolveAgentFilePath(config: SkillConnectorConfig, scope: 'global' | 'project'): string {
    if (!config.agentFile) {
      throw new Error('Agent file is not configured for this agent')
    }

    if (scope === 'global') {
      if (config.globalRoot && config.globalRoot !== 'home') {
        throw new Error(`Agent file deployment not supported for globalRoot '${config.globalRoot}'`)
      }

      return path.join(resolveUserPath('~', this.pathResolverOptions()), config.agentFile.target)
    }

    return path.join(this.projectRoot, config.agentFile.target)
  }

  /**
   * Get the full (absolute) path for skill file operations.
   * Combines the config base path with the skill name, rooted at either
   * the project root (project scope) or the user's home directory (global scope).
   *
   * @throws Error if the requested scope is not configured for the agent.
   */
  private resolveFullPath(config: SkillConnectorConfig, scope: 'global' | 'project', skillName: string): string {
    if (scope === 'global') {
      if (!config.globalPath) {
        throw new Error('Global path is not configured for this agent')
      }

      return path.join(resolveSkillGlobalBasePath(config, this.pathResolverOptions()), skillName)
    }

    if (!config.projectPath) {
      throw new Error('Project path is not configured for this agent')
    }

    return path.join(this.projectRoot, config.projectPath, skillName)
  }

  private async upsertAutonomousAttachment(config: SkillConnectorConfig): Promise<void> {
    if (!config.attachment) return

    const blockContent = await this.loadByteroverBlockContent()
    await upsertAutonomousAgentBlocks(config.attachment, blockContent, this.pathResolverOptions())
  }
}
