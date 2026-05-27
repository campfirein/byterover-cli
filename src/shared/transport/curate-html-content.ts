import type {CurateMeta} from '../curate-meta.js'

import {CurateMetaSchema} from '../curate-meta.js'

/**
 * Encode/decode helpers for curate-tool-mode task content payloads.
 *
 * Sibling to `query-tool-mode-content.ts`. The transport layer's
 * `TaskCreateRequest` has a single `content: string` field; curate
 * tool mode packs `{html, meta?, confirmOverwrite?}` as JSON so the
 * daemon dispatcher can reconstruct the structured options.
 *
 * Lives in `shared/` because the MCP tool (encoder) and the daemon
 * agent-process (decoder) both depend on it.
 */

/**
 * Encode curate-tool-mode options as a JSON content payload.
 *
 * `userIntent` is the originating prompt that drove the curate (the CLI
 * passes the user's `brv curate "<text>"` argument). Surfacing it on the
 * wire lets the WebUI Tasks panel render a meaningful row title instead
 * of the raw HTML blob. Optional — MCP callers that author HTML without
 * a tracked intent omit it and the row falls back to the topic path.
 */
export function encodeCurateHtmlContent(options: {
  confirmOverwrite?: boolean
  html: string
  meta?: CurateMeta
  userIntent?: string
}): string {
  return JSON.stringify({
    confirmOverwrite: options.confirmOverwrite,
    html: options.html,
    meta: options.meta,
    userIntent: options.userIntent,
  })
}

/**
 * Parse a JSON-encoded curate-tool-mode content payload back into
 * options. Throws on malformed payload — curate-tool-mode is brand-new
 * and has no legacy callers, so a parse failure almost certainly means
 * the MCP build and daemon are on incompatible versions. Letting that
 * surface as a `task:error` (outer `success: false`) is much easier for
 * the calling agent to diagnose than silently treating the entire JSON
 * string as a literal HTML payload.
 *
 * `meta` is best-effort: if present but invalid against `CurateMetaSchema`
 * (typo'd field, wrong enum value), it downgrades to `undefined` so a
 * forward-incompatible payload still curates — just without review
 * surfacing for that entry. The trade-off: silently losing metadata is
 * a small loss; failing the whole curate over a metadata typo would
 * block users from saving knowledge over an HITL feature.
 */
export function decodeCurateHtmlContent(content: string): {
  confirmOverwrite?: boolean
  html: string
  meta?: CurateMeta
  userIntent?: string
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(
      'curate-tool-mode payload is not valid JSON — likely an MCP/daemon version mismatch. Rebuild byterover-cli to align the encoder and decoder.',
    )
  }

  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as {html?: unknown}).html !== 'string') {
    throw new Error('curate-tool-mode payload is missing a string `html` field.')
  }

  const {confirmOverwrite, html, meta, userIntent} = parsed as {
    confirmOverwrite?: unknown
    html: string
    meta?: unknown
    userIntent?: unknown
  }

  const metaResult = meta === undefined ? undefined : CurateMetaSchema.safeParse(meta)
  const validMeta = metaResult?.success ? metaResult.data : undefined

  // Forward-compat downgrade safety net. The path is unreachable from MCP today
  // (BrvCurateInputSchema is .strict() at the boundary), but it protects the
  // wire layer against a newer client sending fields this daemon's schema doesn't
  // know yet. Without observability, a forward-incompat field rename would look
  // identical to a successful curate that just happens not to surface for review.
  // shared/ can't take a logger; guard the signal on BRV_QUEUE_TRACE so production
  // stays quiet and operators diagnosing the symptom can opt in.
  if (meta !== undefined && metaResult && !metaResult.success && process.env.BRV_QUEUE_TRACE) {
    process.stderr.write(
      `decodeCurateHtmlContent: invalid meta downgraded to undefined (${metaResult.error.issues[0]?.message ?? 'unknown'})\n`,
    )
  }

  return {
    confirmOverwrite: typeof confirmOverwrite === 'boolean' ? confirmOverwrite : undefined,
    html,
    meta: validMeta,
    userIntent: typeof userIntent === 'string' && userIntent.length > 0 ? userIntent : undefined,
  }
}
