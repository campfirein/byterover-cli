import {existsSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {isAbsolute, join, resolve as pathResolve, sep as pathSep} from 'node:path'

import {BRV_DIR, CONTEXT_TREE_DIR} from '../../server/constants.js'
import {renderHtmlTopicForLlm} from '../../server/infra/render/reader/html-renderer.js'

/**
 * Read a single topic file from `.brv/context-tree/<relPath>` and
 * return its content (rendered or raw). Consumed by `brv read` and
 * by any other tool that needs a focused single-topic fetch — the
 * curate skill's UPDATE path is the canonical caller, since today's
 * `brv search` returns excerpts only.
 *
 * Behaviour:
 *   - `.html` topic → routed through `renderHtmlTopicForLlm` to give
 *     the calling agent clean markdown (severity / id / subject /
 *     value preserved, raw `<bv-*>` markup stripped). With `raw: true`,
 *     the source bytes pass through unchanged.
 *   - `.md` (or any non-`.html`) topic → source bytes pass through
 *     unchanged. Markdown is already markdown; no rendering layer.
 *
 * Path safety:
 *   - Rejects absolute paths.
 *   - Rejects `..` / `.` segments.
 *   - Defence-in-depth: resolved path must stay inside the
 *     `.brv/context-tree/` root.
 */

export type ReadTopicResult =
  | {content: string; format: 'html' | 'markdown'; ok: true; path: string}
  | {error: ReadTopicError; ok: false; path: string}

export type ReadTopicError =
  | {kind: 'not-found'; message: string}
  | {kind: 'read-failed'; message: string}
  | {kind: 'unsafe-path'; message: string}

export type ReadTopicOptions = {
  /** When true, return the source bytes unchanged (no HTML→markdown render). */
  raw?: boolean
}

/**
 * Read a topic from `<projectRoot>/.brv/context-tree/<relPath>`.
 *
 * `relPath` is the path relative to `.brv/context-tree/` —
 * matches the shape the search service emits in `results[].path`
 * and the shape the curate envelope's `filePath` carries on `done`.
 */
export async function readTopic(
  projectRoot: string,
  relPath: string,
  options: ReadTopicOptions = {},
): Promise<ReadTopicResult> {
  const safety = checkPathSafety(relPath)
  if (!safety.ok) {
    return {error: {kind: 'unsafe-path', message: safety.message}, ok: false, path: relPath}
  }

  const contextTreeRoot = pathResolve(projectRoot, BRV_DIR, CONTEXT_TREE_DIR)
  const fullPath = pathResolve(contextTreeRoot, relPath)

  // Defence-in-depth: after resolve(), confirm the absolute path is
  // still inside the context-tree root. Catches edge-case traversals
  // that slip past the segment check (e.g. on case-insensitive FS
  // or with unicode normalisation surprises).
  if (!fullPath.startsWith(contextTreeRoot + pathSep) && fullPath !== contextTreeRoot) {
    return {
      error: {kind: 'unsafe-path', message: `Resolved path escapes context-tree root: ${relPath}`},
      ok: false,
      path: relPath,
    }
  }

  if (!existsSync(fullPath)) {
    return {
      error: {kind: 'not-found', message: `Topic not found at .brv/context-tree/${relPath}`},
      ok: false,
      path: relPath,
    }
  }

  let raw: string
  try {
    raw = await readFile(fullPath, 'utf8')
  } catch (error) {
    return {
      error: {kind: 'read-failed', message: error instanceof Error ? error.message : String(error)},
      ok: false,
      path: relPath,
    }
  }

  const format = relPath.toLowerCase().endsWith('.html') ? 'html' : 'markdown'
  const content = format === 'html' && !options.raw ? renderHtmlTopicForLlm(raw) : raw

  return {content, format, ok: true, path: relPath}
}

function checkPathSafety(relPath: string): {message: string; ok: false} | {ok: true} {
  if (relPath.length === 0) {
    return {message: 'Path is empty.', ok: false}
  }

  if (isAbsolute(relPath)) {
    return {message: `Path must be relative to .brv/context-tree/, got absolute: ${relPath}`, ok: false}
  }

  const normalized = relPath.replaceAll('\\', '/').replace(/^\/+/, '')
  const segments = normalized.split('/').filter((s) => s.length > 0)
  for (const segment of segments) {
    if (segment === '..' || segment === '.') {
      return {message: `Path may not contain "${segment}" segment: ${relPath}`, ok: false}
    }
  }

  return {ok: true}
}

/**
 * Convenience helper for the CLI: resolve the project root from
 * cwd, then read. Wraps `readTopic` so callers don't repeat the
 * walk-up logic.
 *
 * Importing the existing `resolveProjectRoot` from `curate-session`
 * (where it already lives) instead of duplicating the walk-up,
 * keeping changes additive — no other module is touched by this
 * feature.
 */
export {resolveProjectRoot} from './curate-session.js'

/** Re-export `join` so call sites that need to log the absolute path can compose it. */
export function topicAbsolutePath(projectRoot: string, relPath: string): string {
  return join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR, relPath)
}
