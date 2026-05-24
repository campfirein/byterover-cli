const REASON_PREFIX_PATTERN = /^\[([^/\]]+)\/([^/\]]+)]\s*(.*)$/s

export function splitReasonPrefix(text: string): {body: string; prefix: string | undefined} {
  const match = REASON_PREFIX_PATTERN.exec(text)
  if (!match) return {body: text, prefix: undefined}
  return {body: match[3], prefix: `${match[1]}:${match[2]}`}
}
