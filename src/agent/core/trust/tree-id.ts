/* eslint-disable no-bitwise */
// UUIDv7 (RFC 9562) requires direct bit manipulation to set the version
// nibble and variant bits at fixed byte offsets — there is no algebraic
// alternative. Bitwise is the spec-compliant tool here.

import {randomBytes} from 'node:crypto'

/**
 * Phase 9 / AMENDMENT_TOFU §A3.2 — `tree_id` is a UUIDv7 (RFC 9562):
 *
 *   - bytes[0..6)   48-bit big-endian Unix epoch milliseconds
 *   - bytes[6][hi]  4-bit version (= 7)
 *   - bytes[6][lo]  4-bit random
 *   - bytes[7]      8-bit random
 *   - bytes[8][hi]  2-bit variant (= 0b10)
 *   - bytes[8][lo]  6-bit random
 *   - bytes[9..16) 56-bit random
 *
 * Locally generated in peer mode, CA-assigned in org mode. The brv L2
 * tree identity is a fresh UUIDv7 per tree; it's NOT derived from any
 * public key. The L1→L2 binding lives in the cert's signature path
 * (see `peer-tree-signer.ts`).
 *
 * UUIDv7 was chosen over UUIDv4 because:
 *   - Lexicographic sort ≈ creation-time sort: easier audit-log ordering.
 *   - Embedded timestamp aids debugging without a second field.
 *
 * Canonical string form: lowercase hex with dashes, 36 chars.
 */

const UUID_V7_RE = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/

/** Generate a fresh UUIDv7 (RFC 9562) in canonical lowercase dash-form. */
export function generateTreeId(): string {
  const bytes = randomBytes(16)
  const ts = Date.now()

  // 48-bit big-endian timestamp.
  bytes[0] = (ts / 0x1_00_00_00_00_00) & 0xff
  bytes[1] = (ts / 0x1_00_00_00_00) & 0xff
  bytes[2] = (ts / 0x1_00_00_00) & 0xff
  bytes[3] = (ts / 0x1_00_00) & 0xff
  bytes[4] = (ts / 0x1_00) & 0xff
  bytes[5] = ts & 0xff

  // Version = 7: clear high nibble of byte 6, set to 0x7.
  bytes[6] = 0x70 | (bytes[6] & 0x0f)
  // Variant = 10xx: clear high 2 bits of byte 8, set to 0b10.
  bytes[8] = 0x80 | (bytes[8] & 0x3f)

  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/**
 * Validate `s` is a canonical UUIDv7 dash-form string (lowercase hex,
 * version nibble == 7, variant high bits == 10).
 *
 * Total (never throws) — safe to call on arbitrary input.
 */
export function isValidUuidV7(s: unknown): boolean {
  if (typeof s !== 'string') return false
  return UUID_V7_RE.test(s)
}
