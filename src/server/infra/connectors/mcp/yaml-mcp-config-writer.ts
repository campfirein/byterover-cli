import {dump as yamlDump, load as yamlLoad} from 'js-yaml'
import {has, set, unset} from 'lodash-es'

import type {IFileService} from '../../../core/interfaces/services/i-file-service.js'
import type {
  IMcpConfigWriter,
  McpConfigExistsResult,
  McpServerConfig,
} from '../../../core/interfaces/storage/i-mcp-config-writer.js'

import {isRecord} from '../../../utils/type-guards.js'

export type YamlMcpConfigWriterOptions = {
  fileService: IFileService
  /**
   * YAML key path to the MCP server entry, including server name.
   * e.g., ['mcp_servers', 'brv'] navigates to { mcp_servers: { brv: ... } }
   */
  serverKeyPath: readonly string[]
}

function parseYamlAsRecord(content: string): Record<string, unknown> {
  const parsed: unknown = yamlLoad(content)
  if (!isRecord(parsed)) {
    throw new TypeError('Expected YAML root to be a mapping')
  }

  return parsed
}

/**
 * MCP config writer for YAML format files.
 * Used by agents whose MCP server list lives in a YAML config (e.g. Hermes).
 * Comments and key order are not preserved across round-trip — that is an
 * accepted trade-off given js-yaml's capabilities.
 */
export class YamlMcpConfigWriter implements IMcpConfigWriter {
  private readonly fileService: IFileService
  private readonly serverKeyPath: readonly string[]

  constructor(options: YamlMcpConfigWriterOptions) {
    this.fileService = options.fileService
    this.serverKeyPath = options.serverKeyPath
  }

  async exists(filePath: string): Promise<McpConfigExistsResult> {
    const fileExists = await this.fileService.exists(filePath)

    if (!fileExists) {
      return {fileExists: false, serverExists: false}
    }

    try {
      const content = await this.fileService.read(filePath)
      const data = parseYamlAsRecord(content)
      return {
        fileExists: true,
        serverExists: has(data, this.serverKeyPath),
      }
    } catch {
      return {fileExists: true, serverExists: false}
    }
  }

  async remove(filePath: string): Promise<boolean> {
    const fileExists = await this.fileService.exists(filePath)

    if (!fileExists) {
      return false
    }

    let data: Record<string, unknown>
    try {
      data = parseYamlAsRecord(await this.fileService.read(filePath))
    } catch {
      return false
    }

    if (!has(data, this.serverKeyPath)) {
      return false
    }

    unset(data, this.serverKeyPath)
    await this.fileService.write(yamlDump(data), filePath, 'overwrite')
    return true
  }

  async write(filePath: string, serverConfig: McpServerConfig): Promise<void> {
    let data: Record<string, unknown> = {}

    if (await this.fileService.exists(filePath)) {
      try {
        data = parseYamlAsRecord(await this.fileService.read(filePath))
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error)
        throw new Error(`Cannot update YAML MCP config at ${filePath}: ${details}`)
      }
    }

    set(data, this.serverKeyPath, {...serverConfig})
    await this.fileService.write(yamlDump(data), filePath, 'overwrite')
  }
}
