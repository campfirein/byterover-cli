/**
 * Phase 9.5.4 — shared channelId validation used by both `brv channel new`
 * and the auto-create path in `BridgeTranscriptService`.
 *
 * Pattern mirrors the existing `brv channel new` rules: lowercase alphanumeric
 * + hyphens, 1–64 characters, must start with alphanumeric.
 */

const CHANNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Returns `true` if the channelId matches the allowed pattern.
 * Exported for use in validation helpers + tests.
 */
export function isValidChannelId(channelId: string): boolean {
  return CHANNEL_ID_PATTERN.test(channelId)
}

/**
 * Returns the regex as a string (used in error messages so the rule is
 * surfaced inline without repeating the literal).
 */
export const CHANNEL_ID_PATTERN_STRING = '^[a-z0-9][a-z0-9-]{0,63}$'
