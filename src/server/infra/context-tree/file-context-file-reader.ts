import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import type {ContextFileContent, IContextFileReader} from '../../core/interfaces/context-tree/i-context-file-reader.js'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../constants.js'
import {MarkdownWriter} from '../../core/domain/knowledge/markdown-writer.js'
import {parseHtmlContextContent} from './html-context-file-extractor.js'

export type FileContextFileReaderConfig = {
  baseDirectory?: string
}

/**
 * Extracts the title from the first markdown heading in the content.
 * Used as a fallback when neither the MD frontmatter `title` nor the
 * HTML `<bv-topic title="…">` attribute is present.
 *
 * @param content - The file content
 * @param fallbackTitle - The title to use if no heading is found
 * @returns The extracted title or fallback
 */
const extractTitle = (content: string, fallbackTitle: string): string => {
  // Match the first line that starts with "# " (level 1 heading)
  const match = /^# (.+)$/m.exec(content)
  return match ? match[1].trim() : fallbackTitle
}

/**
 * File-based implementation of IContextFileReader.
 *
 * Reads topic files from `.brv/context-tree/` and extracts structured
 * metadata. Format-aware: branches on file extension so HTML topics
 * route through `parseHtmlContextContent` (walks `<bv-topic>` attributes
 * + typed `<bv-*>` elements), markdown topics route through the
 * existing `MarkdownWriter.parseContent` (YAML frontmatter + `##`
 * sections). Same `ContextFileContent` return shape from either path
 * so downstream consumers (`push-handler`, `context-tree-handler`)
 * don't need to know which format they got.
 */
export class FileContextFileReader implements IContextFileReader {
  private readonly config: FileContextFileReaderConfig

  public constructor(config: FileContextFileReaderConfig = {}) {
    this.config = config
  }

  public async read(relativePath: string, directory?: string): Promise<ContextFileContent | undefined> {
    const baseDir = directory ?? this.config.baseDirectory ?? process.cwd()
    const fullPath = join(baseDir, BRV_DIR, CONTEXT_TREE_DIR, relativePath)

    try {
      const content = await readFile(fullPath, 'utf8')

      // Extension-based dispatch: HTML topics go through the bv-* extractor,
      // markdown goes through the existing parser. Same return shape from
      // either path. Fallback-title strategy diverges per format:
      //   - MD: `extractTitle` reads the first `# H1` line (markdown idiom).
      //   - HTML: use the relative path directly — running the H1 regex on
      //     HTML body content could pick up a stray `# ` inside, e.g., a
      //     `<bv-examples>` markdown snippet and surface it as the file's
      //     title.
      if (isHtmlTopic(relativePath)) {
        return parseHtmlContextContent(content, relativePath, relativePath)
      }

      const fallbackTitle = extractTitle(content, relativePath)
      const parsedContent = MarkdownWriter.parseContent(content, fallbackTitle)
      // Frontmatter title takes precedence, then H1 heading, then path fallback
      const title = parsedContent.name || fallbackTitle

      return {
        content,
        keywords: parsedContent.keywords,
        narrative: parsedContent.narrative,
        path: relativePath,
        rawConcept: parsedContent.rawConcept,
        tags: parsedContent.tags,
        title,
      }
    } catch {
      // File doesn't exist or can't be read
      return undefined
    }
  }

  public async readMany(relativePaths: string[], directory?: string): Promise<ContextFileContent[]> {
    const results = await Promise.all(relativePaths.map((path) => this.read(path, directory)))

    // Filter out undefined results (files that couldn't be read)
    return results.filter((result): result is ContextFileContent => result !== undefined)
  }
}

function isHtmlTopic(relativePath: string): boolean {
  const lower = relativePath.toLowerCase()
  return lower.endsWith('.html') || lower.endsWith('.htm')
}
