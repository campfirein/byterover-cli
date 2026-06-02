export function safeJsonParse(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}
