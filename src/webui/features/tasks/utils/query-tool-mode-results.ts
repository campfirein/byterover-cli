import {safeJsonParse} from './safe-json-parse'

export type QueryToolModeMatchedDoc = {
  format?: string
  path: string
  rendered_md?: string
  score: number
  title: string
}

export function isQueryToolModeType(type: string): boolean {
  return type === 'query-tool-mode'
}

export function parseQueryToolModeResult(content: string): QueryToolModeMatchedDoc[] | undefined {
  const parsed = safeJsonParse(content)
  if (!parsed || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.matchedDocs)) return undefined
  return obj.matchedDocs.filter((element) => isMatchedDoc(element))
}

export function queryToolModeRowTitle(content: string): string | undefined {
  const parsed = safeJsonParse(content)
  if (!parsed || typeof parsed !== 'object') return undefined
  const obj = parsed as Record<string, unknown>
  return typeof obj.query === 'string' ? obj.query : undefined
}

function isMatchedDoc(value: unknown): value is QueryToolModeMatchedDoc {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return typeof obj.title === 'string' && typeof obj.path === 'string' && typeof obj.score === 'number'
}
