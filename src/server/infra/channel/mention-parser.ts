/**
 * Parse `@<handle>` mentions out of a prompt string (DESIGN.md §5.4).
 *
 * Multi-mention aware: returns every distinct handle in first-occurrence
 * order, preserving the `@` prefix (canonical Phase-2 handle format). Pure
 * function — the orchestrator (Slice 2.4) is the one that caps the
 * effective dispatch set at 1 for Phase 2.
 *
 * Edge cases:
 *  - `@` followed by whitespace/end-of-string is NOT a mention
 *    (e.g. `email me @ work@x.com` parses to []).
 *  - Trailing punctuation is not part of the handle (`@a,` → `@a`).
 */

const HANDLE_REGEX = /(^|[\s,;:.!?(){}[\]<>"'])@([a-zA-Z0-9_-]+)/g

export const parseMentions = (text: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(HANDLE_REGEX)) {
    const handle = `@${match[2]}`
    if (!seen.has(handle)) {
      seen.add(handle)
      out.push(handle)
    }
  }

  return out
}
