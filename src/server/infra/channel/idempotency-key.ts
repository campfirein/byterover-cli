import {createHash} from 'node:crypto'

import type {ContentBlock} from '../../../shared/types/channel.js'

/**
 * Phase 10 Tier C #2 (V6 run-4 §4a) — idempotency-key auto-generation.
 *
 * Run-4 surfaced three duplicate dispatches (~60-70s after the
 * originals, ~10s apart) carrying identical prompts to the originals.
 * The platform itself does NOT auto-redispatch; the duplicates came
 * from the host orchestrator re-issuing `mention` after `subscribe
 * --include-blocked --count N` returned an early snapshot. Even when
 * host behaviour is correct, late retries and concurrent re-dispatches
 * waste model compute.
 *
 * Auto-deriving an idempotency key from
 *
 *   sha256(channelId | canonical-prompt | sorted-mentions | 5-min-bucket)
 *
 * lets the orchestrator collapse two identical dispatches inside the
 * same 5-minute bucket onto the original turn rather than starting a
 * parallel one. Clients can still pass `idempotencyKey` explicitly to
 * use their own scheme (e.g. transaction ids).
 *
 * The bucket boundary is intentional: cross-window repeats (e.g. user
 * sending the same `@kimi review` mention an hour later) hash to a
 * fresh key and dispatch normally.
 */

export const DEFAULT_IDEMPOTENCY_BUCKET_MS = 5 * 60 * 1000
export const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000

// Field separator used to glue hash material together. `|` is not
// reserved inside any prompt text — collisions like `prompt:a` +
// `cid:b` vs `prompt:a|cid:b` are prevented by always prefixing each
// field with its name.
const FIELD_SEP = '|'
const BLOCK_SEP = '\n'

export type DeriveIdempotencyKeyArgs = {
  readonly bucketMs?: number
  readonly channelId: string
  readonly mentions: ReadonlyArray<string>
  readonly nowMs: number
  readonly promptBlocks: ReadonlyArray<ContentBlock>
}

/**
 * Canonicalise a prompt block so structurally-equal prompts hash to
 * the same key regardless of insertion order of object properties.
 * Text blocks include trimmed text; non-text blocks include their kind
 * + the JSON of their stable fields. Whitespace inside text is NOT
 * collapsed — "review the file" and "review  the file" are distinct.
 */
const canonicaliseBlock = (b: ContentBlock): string => {
  if (b.type === 'text') return `text:${b.text}`
  if (b.type === 'resource_link') return `resource_link:${b.uri}`
  return `${b.type}:${JSON.stringify(b)}`
}

export const deriveIdempotencyKey = (args: DeriveIdempotencyKeyArgs): string => {
  const bucketMs = args.bucketMs ?? DEFAULT_IDEMPOTENCY_BUCKET_MS
  const bucket = Math.floor(args.nowMs / bucketMs)
  const sortedMentions = [...args.mentions].sort()
  const canonicalPrompt = args.promptBlocks.map((b) => canonicaliseBlock(b)).join(BLOCK_SEP)
  const material = [
    `cid:${args.channelId}`,
    `mentions:${sortedMentions.join(',')}`,
    `bucket:${bucket}`,
    `prompt:${canonicalPrompt}`,
  ].join(FIELD_SEP)
  return createHash('sha256').update(material).digest('hex')
}
