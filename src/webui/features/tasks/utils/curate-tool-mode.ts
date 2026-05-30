/**
 * Parsers for `curate-tool-mode` task payloads.
 *
 * Both the input (`task.content`) and the result (`task.result`) are JSON
 * strings packed by the MCP encoder and the daemon executor respectively.
 * The renderers in `task-detail-sections.tsx` use these to switch into a
 * structured view instead of dumping the raw JSON.
 */

export interface CurateHtmlDirectInputPayload {
  confirmOverwrite?: boolean
  html: string
  /**
   * The user's original `brv curate "<text>"` argument when this task
   * originated from the CLI session protocol. MCP-dispatched curates
   * have no tracked intent and omit this field.
   */
  userIntent?: string
}

export type CurateHtmlDirectResultPayload =
  | {
      errors: readonly CurateHtmlWriteError[]
      status: 'validation-failed'
    }
  | {
      filePath: string
      overwrote: boolean
      status: 'ok'
      topicPath: string
    }

export interface CurateHtmlWriteError {
  existingContent?: string
  kind: string
  message: string
}

export function isCurateHtmlDirectType(type: string): boolean {
  return type === 'curate-tool-mode'
}

export function parseCurateHtmlDirectInput(content: string): CurateHtmlDirectInputPayload | undefined {
  const parsed = safeJsonParse(content)
  if (!parsed || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  if (typeof obj.html !== 'string') return undefined
  return {
    confirmOverwrite: typeof obj.confirmOverwrite === 'boolean' ? obj.confirmOverwrite : undefined,
    html: obj.html,
    userIntent: typeof obj.userIntent === 'string' && obj.userIntent.length > 0 ? obj.userIntent : undefined,
  }
}

/**
 * Derive the row-title string for a curate-tool-mode task. Falls back
 * through three sources, in order of preference:
 *
 *   1. `userIntent` — set by the CLI's session protocol (`brv curate "<text>"`).
 *   2. Topic path attribute pulled from the `<bv-topic>` HTML — set by MCP
 *      callers and any other dispatcher that omits userIntent.
 *   3. `undefined` — caller falls back to the raw JSON or the "(empty)" state.
 *
 * Kept here so both the list table and the detail header can render the
 * same string without re-parsing the JSON blob twice.
 */
export function curateHtmlDirectRowTitle(content: string): string | undefined {
  const payload = parseCurateHtmlDirectInput(content)
  if (!payload) return undefined
  if (payload.userIntent) return payload.userIntent

  // Lightweight regex grab — pulling in a full HTML parser for a row
  // title would balloon the WebUI bundle. The `<bv-topic path="…">`
  // contract is stable (writer rejects malformed roots), so a single-
  // attribute match is safe.
  const match = /<bv-topic\b[^>]*\bpath="([^"]+)"/i.exec(payload.html)
  return match ? decodeHtmlEntities(match[1]) : undefined
}

/**
 * Decode the five HTML entities the writer might emit inside an
 * attribute value (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&#39;`). Path
 * content is lowercase-letters/slashes today, so this is a forward-
 * compat normalization — without it a path like `foo&amp;bar` would
 * render as `foo&amp;bar` instead of `foo&bar`.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

export function parseCurateHtmlDirectResult(content: string): CurateHtmlDirectResultPayload | undefined {
  const parsed = safeJsonParse(content)
  if (!parsed || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>

  if (obj.status === 'ok' && typeof obj.topicPath === 'string' && typeof obj.filePath === 'string') {
    return {
      filePath: obj.filePath,
      overwrote: Boolean(obj.overwrote),
      status: 'ok',
      topicPath: obj.topicPath,
    }
  }

  if (obj.status === 'validation-failed' && Array.isArray(obj.errors)) {
    return {
      errors: obj.errors.filter((element) => isWriteError(element)),
      status: 'validation-failed',
    }
  }

  return undefined
}

function isWriteError(value: unknown): value is CurateHtmlWriteError {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.kind === 'string' && typeof obj.message === 'string'
}

function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}
