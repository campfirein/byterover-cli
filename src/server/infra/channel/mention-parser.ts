/** Matches an `@handle` only at the start of the text or after whitespace. */
const MENTION_PATTERN = /(?:^|\s)(@[A-Za-z0-9_-]+)/g

/**
 * Extracts `@handle` mentions from prompt text, deduped in first-occurrence
 * order. The leading boundary keeps email addresses (`name@host`) from being
 * read as mentions.
 */
export const parseMentions = (text: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const handle = match[1]
    if (handle !== undefined && !seen.has(handle)) {
      seen.add(handle)
      out.push(handle)
    }
  }

  return out
}
