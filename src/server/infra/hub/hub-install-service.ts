import axios, {isAxiosError} from 'axios'
import {join} from 'node:path'

import type {HubEntryDTO} from '../../../shared/transport/types/dto.js'
import type {Agent} from '../../core/domain/entities/agent.js'
import type {
  HubInstallAuthParams,
  HubInstallParams,
  IHubInstallService,
} from '../../core/interfaces/hub/i-hub-install-service.js'
import type {IFileService} from '../../core/interfaces/services/i-file-service.js'
import type {SkillConnector} from '../connectors/skill/skill-connector.js'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../constants.js'
import {ProxyConfig} from '../http/proxy-config.js'
import {buildAuthHeaders} from './hub-auth-headers.js'

export interface HubInstallServiceDeps {
  fileService: IFileService
  skillConnectorFactory: (projectRoot: string) => SkillConnector
}

export class HubInstallService implements IHubInstallService {
  private readonly fileService: IFileService
  private readonly skillConnectorFactory: (projectRoot: string) => SkillConnector

  constructor(deps: HubInstallServiceDeps) {
    this.fileService = deps.fileService
    this.skillConnectorFactory = deps.skillConnectorFactory
  }

  async install(params: HubInstallParams): Promise<{installedFiles: string[]; installedPath: string; message: string}> {
    const {agent, auth, entry, projectPath, scope} = params
    return entry.type === 'agent-skill'
      ? this.installSkill({agent, auth, entry, projectPath, scope})
      : this.installBundle(entry, projectPath, auth)
  }

  private async downloadAndWrite(
    files: Array<{name: string; url: string}>,
    targetDir: string,
    auth?: HubInstallAuthParams,
  ): Promise<string[]> {
    const installedFiles: string[] = []

    await Promise.all(
      files.map(async (file) => {
        const content = await this.downloadFile(file.url, auth)
        const filePath = join(targetDir, file.name)
        await this.fileService.write(content, filePath, 'overwrite')
        installedFiles.push(filePath)
      }),
    )

    return installedFiles
  }

  private async downloadFile(url: string, auth?: HubInstallAuthParams): Promise<string> {
    try {
      const headers = buildAuthHeaders(auth ?? {})

      const response = await axios.get<string>(url, {
        headers,
        httpAgent: ProxyConfig.getProxyAgent(),
        httpsAgent: ProxyConfig.getProxyAgent(),
        proxy: false,
        responseType: 'text',
        timeout: 15_000,
      })
      return response.data
    } catch (error) {
      if (isAxiosError(error)) {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          throw new Error(`Download timed out: ${url}`)
        }

        if (!error.response) {
          throw new Error(`Network error downloading: ${url}`)
        }

        throw new Error(`Failed to download file (HTTP ${error.response.status}): ${url}`)
      }

      throw new Error(`Failed to download: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  private getContentFiles(entry: HubEntryDTO): Array<{name: string; url: string}> {
    return entry.file_tree.filter((file) => file.url !== entry.readme_url && file.url !== entry.manifest_url)
  }

  private async installBundle(
    entry: HubEntryDTO,
    projectPath: string,
    auth?: HubInstallAuthParams,
  ): Promise<{installedFiles: string[]; installedPath: string; message: string}> {
    const contextTreeDir = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)
    const contentFiles = this.getContentFiles(entry)

    if (contentFiles.length > 0) {
      const firstFilePath = join(contextTreeDir, contentFiles[0].name)
      if (await this.fileService.exists(firstFilePath)) {
        return {
          installedFiles: [],
          installedPath: contextTreeDir,
          message: `${entry.name} is already installed in context tree`,
        }
      }
    }

    const installedFiles = await this.downloadAndWrite(contentFiles, contextTreeDir, auth)

    return {
      installedFiles,
      installedPath: contextTreeDir,
      message: `Installed ${entry.name} bundle to context tree.`,
    }
  }

  private async installSkill(params: {
    agent?: Agent
    auth?: HubInstallAuthParams
    entry: HubEntryDTO
    projectPath: string
    scope?: 'global' | 'project'
  }): Promise<{installedFiles: string[]; installedPath: string; message: string}> {
    const {agent, auth, entry, projectPath, scope} = params

    const skillConnector = this.skillConnectorFactory(projectPath)
    const contentFiles = this.getContentFiles(entry)

    if (!agent || !skillConnector.isSupported(agent)) {
      throw new Error('Agent does not support skill installation')
    }

    const downloadedFiles = await Promise.all(
      contentFiles.map(async (file) => ({
        content: await this.downloadFile(file.url, auth),
        name: file.name,
      })),
    )

    const result = await skillConnector.writeSkillFiles({agent, files: downloadedFiles, scope, skillName: entry.id})

    if (result.alreadyInstalled) {
      return {
        installedFiles: [],
        installedPath: result.installedPath,
        message: `${entry.name} is already installed for ${agent}`,
      }
    }

    return {
      installedFiles: result.installedFiles,
      installedPath: result.installedPath,
      message: `Installed ${entry.name} skill for ${agent} at ${result.installedPath}/`,
    }
  }
}
