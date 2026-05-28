/**
 * Encode/decode helpers for query-tool-mode task content payloads.
 *
 * Sibling to `search-content.ts`. The transport layer's
 * TaskCreateRequest has a single `content: string` field; tool-mode
 * query packs {query, limit?} as JSON so the agent process can
 * reconstruct the structured options.
 *
 * Lives in shared/ because both the CLI (encoder) and the daemon
 * agent-process (decoder) depend on it.
 */

/**
 * Encode tool-mode query options as JSON content payload.
 */
export function encodeQueryToolModeContent(options: {limit?: number; query: string}): string {
  return JSON.stringify({
    limit: options.limit,
    query: options.query,
  })
}

/**
 * Parse a JSON-encoded tool-mode query content payload back into
 * options. Throws on malformed payload — unlike the lenient
 * `decodeSearchContent`, tool mode is brand-new and has no legacy
 * callers, so a parse failure almost certainly means the CLI and
 * daemon are on incompatible versions. Letting that surface as a
 * `task:error` (outer envelope `success: false`) is much easier for
 * the calling agent to diagnose than silently synthesising an answer
 * about the JSON-encoded string itself.
 */
export function decodeQueryToolModeContent(content: string): {limit?: number; query: string} {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(
      'query-tool-mode payload is not valid JSON — likely a CLI/daemon version mismatch. Rebuild byterover-cli to align the encoder and decoder.',
    )
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as {query?: unknown}).query !== 'string'
  ) {
    throw new Error('query-tool-mode payload is missing a string `query` field.')
  }

  const {limit, query} = parsed as {limit?: unknown; query: string}
  return {
    limit: typeof limit === 'number' ? limit : undefined,
    query,
  }
}
