import path from 'node:path'

/**
 * The two context-tree file formats currently on disk.
 *
 * Curate writes HTML; existing markdown topic files are still read
 * transparently via the extension-based dispatcher below.
 * `getFormatForRead` exists so the query/search path can route legacy
 * `.md` files that predate the HTML format.
 */
export type ContextTreeFormat = 'html' | 'markdown'

/**
 * Decide which format a topic file is in by inspecting its path's
 * extension. The query/search read path uses this to route between the
 * existing markdown reader and the HTML reader.
 *
 * Unknown or extension-less paths default to `markdown` for backwards
 * compatibility with legacy files. Add explicit branches when new
 * formats land.
 */
export function getFormatForRead(filePath: string): ContextTreeFormat {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.html' || ext === '.htm') return 'html'
  return 'markdown'
}
