/* eslint-disable perfectionist/sort-objects */
// Test fixtures here are INTENTIONALLY unsorted. The whole point is to
// prove the canonicalizer sorts them and produces sorted output regardless
// of input order. Auto-sorting the fixtures would make the tests trivially
// true (sorted in → sorted out).

import {expect} from 'chai'

import {canonicalize} from '../../../../../src/agent/core/trust/canonical.js'

// Phase 9 / AMENDMENT_TOFU §A3.2 — RFC 8785 JSON Canonicalization Scheme.
//
// The spec mandates: (1) keys sorted by UTF-16 code-unit lexical order;
// (2) no whitespace between tokens; (3) numbers serialised per ECMAScript
// `ToString` (no trailing zeros, no `+e`, etc.); (4) strings JSON-quoted
// per RFC 8259 (control chars `\uXXXX`-escaped, surrogate pairs preserved);
// (5) arrays preserve order; (6) `null` literal; (7) booleans `true`/`false`.
//
// Fixed vectors below match the official examples in
// https://datatracker.ietf.org/doc/html/rfc8785#section-3.2.3 and
// https://github.com/cyberphone/json-canonicalization/tree/master/testdata.

describe('canonicalize (RFC 8785 JCS)', () => {
  describe('primitive values', () => {
    it('serialises null as `null`', () => {
      expect(canonicalize(null)).to.equal('null')
    })

    it('serialises true as `true`', () => {
      expect(canonicalize(true)).to.equal('true')
    })

    it('serialises false as `false`', () => {
      expect(canonicalize(false)).to.equal('false')
    })

    it('serialises positive integer with no fractional part', () => {
      expect(canonicalize(42)).to.equal('42')
    })

    it('serialises negative integer', () => {
      expect(canonicalize(-7)).to.equal('-7')
    })

    it('serialises zero as `0`', () => {
      expect(canonicalize(0)).to.equal('0')
    })

    it('serialises -0 as `0` (RFC 8785 collapses signed zero)', () => {
      // Per RFC 8785 §3.2.2.3, -0 MUST serialise as "0".
      expect(canonicalize(-0)).to.equal('0')
    })

    it('serialises a string with no escaping needed', () => {
      expect(canonicalize('hello')).to.equal('"hello"')
    })

    it('serialises empty string', () => {
      expect(canonicalize('')).to.equal('""')
    })
  })

  describe('strings — escaping', () => {
    it(String.raw`escapes the standard short forms (\", \\, \b, \f, \n, \r, \t)`, () => {
      expect(canonicalize('quote: "')).to.equal(String.raw`"quote: \""`)
      expect(canonicalize('back: \\')).to.equal(String.raw`"back: \\"`)
      expect(canonicalize('bs: \b')).to.equal(String.raw`"bs: \b"`)
      expect(canonicalize('ff: \f')).to.equal(String.raw`"ff: \f"`)
      expect(canonicalize('nl: \n')).to.equal(String.raw`"nl: \n"`)
      expect(canonicalize('cr: \r')).to.equal(String.raw`"cr: \r"`)
      expect(canonicalize('tab: \t')).to.equal(String.raw`"tab: \t"`)
    })

    it(String.raw`escapes other control characters (U+0000 — U+001F) as \uXXXX (lowercase hex per RFC 8785)`, () => {
      // Per RFC 8785 §3.2.2.2, control chars outside the short-form set are
      // \uXXXX-escaped with LOWERCASE hex digits.
      expect(canonicalize('')).to.equal(String.raw`"\u0001"`)
      expect(canonicalize('')).to.equal(String.raw`"\u001f"`)
      // U+007F (DEL) is NOT escaped — it's a printable-range control char per JSON spec.
      expect(canonicalize('')).to.equal('""')
    })

    it(String.raw`preserves non-ASCII printable characters verbatim (no \uXXXX escaping)`, () => {
      // RFC 8785 §3.2.2.2: only escape what JSON-spec requires; everything
      // else passes through as UTF-8.
      expect(canonicalize('café')).to.equal('"café"')
      expect(canonicalize('日本語')).to.equal('"日本語"')
      expect(canonicalize('🎉')).to.equal('"🎉"')
    })

    it('preserves surrogate pairs in supplementary-plane chars', () => {
      // U+1D11E (𝄞) is encoded as the surrogate pair D834 DD1E in UTF-16.
      // JCS passes the UTF-8 bytes through; the JSON output renders the
      // codepoint directly, not as a surrogate-pair escape.
      expect(canonicalize('\u{1D11E}')).to.equal('"\u{1D11E}"')
    })
  })

  describe('objects — key sorting', () => {
    it('sorts keys by UTF-16 code-unit order', () => {
      // Input is INTENTIONALLY out-of-order; canonicalizer must sort.
      expect(canonicalize({c: 3, a: 1, b: 2})).to.equal('{"a":1,"b":2,"c":3}')
    })

    it('sorts keys with non-ASCII characters by UTF-16 code unit', () => {
      // 'a' (U+0061) < 'é' (U+00E9) < 'ü' (U+00FC); input out-of-order.
      expect(canonicalize({ü: 3, é: 2, a: 1})).to.equal('{"a":1,"é":2,"ü":3}')
    })

    it('emits no whitespace between tokens', () => {
      expect(canonicalize({b: 2, a: 1})).to.equal('{"a":1,"b":2}')
    })

    it('handles empty objects', () => {
      expect(canonicalize({})).to.equal('{}')
    })

    it('canonicalizes nested objects recursively', () => {
      // Outer keys out-of-order AND inner keys out-of-order.
      expect(canonicalize({outer: {b: 2, a: 1}, first: 0}))
        .to.equal('{"first":0,"outer":{"a":1,"b":2}}')
    })

    it('sorts keys at every nesting level', () => {
      const input = {z: {y: 1, x: {b: 2, a: 1}}, a: 0}
      expect(canonicalize(input)).to.equal('{"a":0,"z":{"x":{"a":1,"b":2},"y":1}}')
    })
  })

  describe('arrays — order preservation', () => {
    it('preserves insertion order of arrays', () => {
      expect(canonicalize([3, 1, 2])).to.equal('[3,1,2]')
    })

    it('handles empty arrays', () => {
      expect(canonicalize([])).to.equal('[]')
    })

    it('canonicalizes objects inside arrays', () => {
      // Inner object keys out-of-order; canonicalizer sorts them.
      expect(canonicalize([{b: 2, a: 1}])).to.equal('[{"a":1,"b":2}]')
    })
  })

  describe('numbers — ECMAScript ToString rules', () => {
    it('serialises 1.5 without trailing zeros', () => {
      expect(canonicalize(1.5)).to.equal('1.5')
    })

    it('serialises a number that ECMAScript renders in exponential form', () => {
      // Per RFC 8785, numbers serialise via ECMAScript ToString rules.
      // 1e+21 is the threshold above which ECMAScript uses exponential.
      expect(canonicalize(1e21)).to.equal('1e+21')
    })

    it('serialises sub-1e-6 in exponential form (ECMAScript threshold)', () => {
      // ECMAScript ToString uses exponential for |x| < 1e-6.
      expect(canonicalize(1e-7)).to.equal('1e-7')
    })

    it('serialises integers via ECMAScript ToString (no `.0` suffix)', () => {
      expect(canonicalize(1000)).to.equal('1000')
    })

    it('rejects NaN and Infinity as non-JSON values', () => {
      // RFC 8785 inherits JSON's prohibition on NaN/±Infinity. The JCS
      // implementation MUST throw rather than emit invalid JSON.
      expect(() => canonicalize(Number.NaN)).to.throw(/NaN/)
      expect(() => canonicalize(Number.POSITIVE_INFINITY)).to.throw(/Infinity/)
      expect(() => canonicalize(Number.NEGATIVE_INFINITY)).to.throw(/Infinity/)
    })
  })

  describe('reproducibility — equivalent inputs canonicalize identically', () => {
    it('produces the same output regardless of key insertion order', () => {
      // Two literals with the SAME keys/values but DIFFERENT insertion
      // order. The whole reason JCS exists: these MUST canonicalize to
      // the same bytes so signatures over them match.
      const a = canonicalize({foo: 1, bar: 2, baz: 3})
      const b = canonicalize({baz: 3, bar: 2, foo: 1})
      expect(a).to.equal(b)
    })

    it('produces the same output regardless of whitespace in source JSON', () => {
      // Two equivalent objects from different JSON sources must yield
      // identical canonical forms.
      const a = canonicalize(JSON.parse('{"x": 1, "y": 2}'))
      const b = canonicalize(JSON.parse('{"y":2,"x":1}'))
      expect(a).to.equal(b)
    })
  })
})
