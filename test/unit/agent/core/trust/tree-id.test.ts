import {expect} from 'chai'

import {generateTreeId, isValidUuidV7} from '../../../../../src/agent/core/trust/tree-id.js'

// Phase 9 / AMENDMENT_TOFU §A3.2 — tree_id = UUIDv7 (RFC 9562).
//
// Locally-generated in peer mode, CA-assigned in org mode. The verifier
// MUST validate variant + version bits and reject malformed values with
// `TREE_ID_MALFORMED`.

describe('tree-id (UUIDv7) primitives', () => {
  describe('generateTreeId()', () => {
    it('returns a 36-char string in canonical UUID dash-form', () => {
      const id = generateTreeId()
      expect(id).to.match(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/)
    })

    it('encodes version 7 in the 13th hex position', () => {
      const id = generateTreeId()
      expect(id.charAt(14)).to.equal('7')
    })

    it('encodes variant 10xx (RFC 4122) in the 17th hex position', () => {
      const id = generateTreeId()
      // 17th char (index 19) MUST be one of 8, 9, a, b — i.e. high 2 bits = 10.
      expect(['8', '9', 'a', 'b']).to.include(id.charAt(19))
    })

    it('embeds a Unix epoch ms timestamp in the leading 48 bits that is close to now', () => {
      const before = Date.now()
      const id = generateTreeId()
      const after = Date.now()
      // Strip dashes, take first 12 hex chars = 48 bits = Unix ms.
      const hex = id.replaceAll('-', '').slice(0, 12)
      const ts = Number.parseInt(hex, 16)
      expect(ts).to.be.gte(before - 1)
      expect(ts).to.be.lte(after + 1)
    })

    it('produces ids sortable by timestamp prefix across ms ticks', async () => {
      const a = generateTreeId()
      await new Promise<void>((r) => { setTimeout(r, 2) })
      const b = generateTreeId()
      // Across distinct ms ticks the leading 12 hex chars (48-bit big-
      // endian timestamp) are strictly increasing, so the canonical
      // string form is lexicographically sortable too. Within a single
      // ms the random tail may invert, which is RFC 9562 compliant.
      expect(a.slice(0, 12).localeCompare(b.slice(0, 12))).to.be.lessThanOrEqual(0)
    })

    it('two calls within the same millisecond produce different ids (random low bits)', () => {
      const ids = new Set<string>()
      for (let i = 0; i < 50; i++) ids.add(generateTreeId())
      expect(ids.size).to.equal(50)
    })
  })

  describe('isValidUuidV7(s)', () => {
    it('accepts a freshly generated tree_id', () => {
      expect(isValidUuidV7(generateTreeId())).to.equal(true)
    })

    it('rejects an empty string', () => {
      expect(isValidUuidV7('')).to.equal(false)
    })

    it('rejects the all-zero UUID (no version + variant bits set)', () => {
      expect(isValidUuidV7('00000000-0000-0000-0000-000000000000')).to.equal(false)
    })

    it('rejects a UUIDv4 (version nibble is 4, not 7)', () => {
      expect(isValidUuidV7('123e4567-e89b-42d3-a456-426614174000')).to.equal(false)
    })

    it('rejects a UUIDv7 with wrong variant bits (high nibble of byte 8 is not 10xx)', () => {
      // Position 19 = '0' (high bits 00xx, NOT 10xx).
      expect(isValidUuidV7('0190a2e0-6b9e-7000-0000-000000000000')).to.equal(false)
    })

    it('rejects a non-string input without throwing', () => {
      const unsafe = isValidUuidV7 as (x: unknown) => boolean
      // eslint-disable-next-line unicorn/no-useless-undefined
      expect(unsafe(undefined)).to.equal(false)
      expect(unsafe(null)).to.equal(false)
      expect(unsafe(42)).to.equal(false)
      expect(unsafe({})).to.equal(false)
    })

    it('rejects a string missing dashes', () => {
      expect(isValidUuidV7('0190a2e06b9e70008000000000000000')).to.equal(false)
    })

    it('rejects uppercase hex (canonical form is lowercase)', () => {
      expect(isValidUuidV7('0190A2E0-6B9E-7000-8000-000000000000')).to.equal(false)
    })
  })
})
