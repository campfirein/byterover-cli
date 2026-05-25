/**
 * Parsers for `curate-html-direct` task payloads.
 *
 * Both the input (`task.content`) and the result (`task.result`) are JSON
 * strings packed by the MCP encoder and the daemon executor respectively.
 * The renderers in `task-detail-sections.tsx` use these to switch into a
 * structured view instead of dumping the raw JSON.
 */

export interface CurateHtmlDirectInputPayload {
  confirmOverwrite?: boolean
  html: string
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
  return type === 'curate-html-direct'
}

export function parseCurateHtmlDirectInput(content: string): CurateHtmlDirectInputPayload | undefined {
  const parsed = safeJsonParse(content)
  if (!parsed || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  if (typeof obj.html !== 'string') return undefined
  return {
    confirmOverwrite: typeof obj.confirmOverwrite === 'boolean' ? obj.confirmOverwrite : undefined,
    html: obj.html,
  }
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
