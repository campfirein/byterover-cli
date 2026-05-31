import path from 'node:path'
import {fileURLToPath} from 'node:url'

import type {IFileService} from '../../../core/interfaces/services/i-file-service.js'

/**
 * Loads static skill markdown files from the templates/skill/ directory
 * and shared section files from templates/sections/.
 * Uses the same import.meta.url path resolution pattern as FsTemplateLoader.
 */
export class SkillContentLoader {
  private readonly agentDir: string
  private readonly skillDir: string
  private readonly templatesDir: string

  constructor(private readonly fileService: IFileService) {
    const currentFilePath = fileURLToPath(import.meta.url)
    const currentDir = path.dirname(currentFilePath)

    // Navigate from src/server/infra/connectors/skill/ to src/server/templates/
    this.templatesDir = path.join(currentDir, '..', '..', '..', 'templates')
    this.skillDir = path.join(this.templatesDir, 'skill')
    this.agentDir = path.join(this.templatesDir, 'agent')
  }

  /**
   * Loads a saved sub-agent definition file by name from the templates/agent/ directory.
   *
   * @param fileName - Name of the agent file including extension (e.g., 'brv-curate.md', 'brv-curate.toml')
   * @returns Promise resolving to the file content
   * @throws Error if the file cannot be read
   */
  async loadAgentFile(fileName: string): Promise<string> {
    const fullPath = path.join(this.agentDir, fileName)

    try {
      return await this.fileService.read(fullPath)
    } catch (error) {
      throw new Error(
        `Failed to load agent file '${fileName}': ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Loads a section file by name from the templates/sections/ directory.
   *
   * @param sectionName - Section file name without extension
   * @returns Promise resolving to the file content
   * @throws Error if the file cannot be read
   */
  async loadSectionFile(sectionName: string): Promise<string> {
    const fullPath = path.join(this.templatesDir, 'sections', `${sectionName}.md`)

    try {
      return await this.fileService.read(fullPath)
    } catch (error) {
      throw new Error(
        `Failed to load section file '${sectionName}': ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Loads a skill file by name from the templates/skill/ directory.
   *
   * @param fileName - Name of the skill file (e.g., 'SKILL.md')
   * @returns Promise resolving to the file content
   * @throws Error if the file cannot be read
   */
  async loadSkillFile(fileName: string): Promise<string> {
    const fullPath = path.join(this.skillDir, fileName)

    try {
      return await this.fileService.read(fullPath)
    } catch (error) {
      throw new Error(
        `Failed to load skill file '${fileName}': ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
