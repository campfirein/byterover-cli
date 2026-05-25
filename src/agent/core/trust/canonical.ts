/**
 * RFC 8785 — JSON Canonicalization Scheme (JCS).
 *
 * Phase 9 / AMENDMENT_TOFU §A3.2 picks JCS as the canonical-form
 * algorithm for every signed payload. Two distinct JSON values that
 * are JCS-canonically equal MUST produce byte-identical signed bytes;
 * a verifier that canonicalises first will reject ANY shape variation.
 *
 * Spec: https://datatracker.ietf.org/doc/html/rfc8785
 *
 * v1 supports:
 *   - object key sort by UTF-16 code-unit order
 *   - integer + float number serialisation via ECMAScript ToString
 *   - string escaping per RFC 8259 + RFC 8785 §3.2.2.2 (lowercase \\uXXXX)
 *   - null / true / false literals
 *   - arrays preserve order
 *
 * v1 explicitly rejects:
 *   - NaN, +Infinity, -Infinity — not JSON values; throw rather than emit invalid output
 *   - undefined values — caller's bug; throw rather than silently drop
 *   - cyclic references — throw rather than infinite-loop
 *   - non-plain-object instances (Date, Map, Set, ...) — caller MUST serialise first
 */

export class CanonicalizationError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'CanonicalizationError'
  }
}

/**
 * Serialise `value` to its RFC 8785 canonical UTF-8 string form.
 * Returns the exact bytes a verifier MUST reconstruct.
 */
export function canonicalize(value: unknown): string {
  return encode(value, new WeakSet())
}

function encode(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'number') return encodeNumber(value)
  if (typeof value === 'string') return encodeString(value)
  if (Array.isArray(value)) return encodeArray(value, seen)
  if (typeof value === 'object') return encodeObject(value, seen)

  if (value === undefined) {
    throw new CanonicalizationError(
      'undefined is not a JSON value; remove the key or set it to null',
    )
  }

  throw new CanonicalizationError(
    `cannot canonicalize value of type ${typeof value}`,
  )
}

// ─── numbers ────────────────────────────────────────────────────────────────
//
// RFC 8785 §3.2.2.3: numbers serialise via ECMAScript's `Number.prototype
// .toString()`. v8/Node's built-in number-to-string is the right answer
// for every finite value EXCEPT signed-zero: ECMAScript renders -0 as
// "0" via ToString but `(-0).toString()` in Node returns "0" too, so
// no special-case is needed. We DO need to reject NaN / ±Infinity
// because they have no JSON encoding.

function encodeNumber(n: number): string {
  if (Number.isNaN(n)) {
    throw new CanonicalizationError('NaN is not a JSON value')
  }

  if (!Number.isFinite(n)) {
    throw new CanonicalizationError('Infinity / -Infinity are not JSON values')
  }

  // Object.is(-0, n) catches the IEEE-754 negative zero case. ECMAScript
  // ToString renders both +0 and -0 as "0"; we mirror that exactly.
  if (Object.is(n, -0)) return '0'
  return n.toString()
}

// ─── strings ────────────────────────────────────────────────────────────────
//
// RFC 8785 §3.2.2.2: only escape the JSON-mandated set. Everything
// else passes through as UTF-8.
//
// Mandated escapes:
//   - `"` → `\"`
//   - `\` → `\\`
//   - U+0008 → `\b`
//   - U+0009 → `\t`
//   - U+000A → `\n`
//   - U+000C → `\f`
//   - U+000D → `\r`
//   - Other U+0000..U+001F → `\uXXXX` (lowercase hex)
//
// Note: forward slash `/` is NOT escaped (legal in JSON without escape).
// Note: U+007F (DEL) is NOT escaped (JSON spec doesn't require it).

const SHORT_ESCAPES: Record<string, string> = {
  '\t': String.raw`\t`,
  '\n': String.raw`\n`,
  '\f': String.raw`\f`,
  '\r': String.raw`\r`,
  '\b': String.raw`\b`,
  '"': String.raw`\"`,
  '\\': '\\\\',
}

function encodeString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (SHORT_ESCAPES[ch] !== undefined) {
      out += SHORT_ESCAPES[ch]
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else {
      out += ch
    }
  }

  out += '"'
  return out
}

// ─── arrays ─────────────────────────────────────────────────────────────────

function encodeArray(arr: readonly unknown[], seen: WeakSet<object>): string {
  if (seen.has(arr)) {
    throw new CanonicalizationError('cyclic reference')
  }

  seen.add(arr)
  try {
    const parts = arr.map((item) => encode(item, seen))
    return `[${parts.join(',')}]`
  } finally {
    seen.delete(arr)
  }
}

// ─── objects ────────────────────────────────────────────────────────────────
//
// RFC 8785 §3.2.3: object keys MUST be sorted by UTF-16 code-unit
// lexical order. JavaScript's default `<` on strings already does
// this for BMP characters; for supplementary-plane characters, `<`
// compares by code unit (i.e. by surrogate-pair value), which is
// exactly what RFC 8785 mandates. So a stable Array.prototype.sort
// with the default comparator is correct.
//
// Keys mapped to `undefined` values are OMITTED (matches JSON.stringify).

function encodeObject(obj: object, seen: WeakSet<object>): string {
  if (seen.has(obj)) {
    throw new CanonicalizationError('cyclic reference')
  }

  seen.add(obj)
  try {
    // Reject Date, Map, Set, etc. — caller must serialise them first.
    const proto = Object.getPrototypeOf(obj)
    if (proto !== null && proto !== Object.prototype) {
      throw new CanonicalizationError(
        `cannot canonicalize non-plain-object instance (${proto.constructor?.name ?? 'unknown'}); serialise to a plain object first`,
      )
    }

    const entries: Array<[string, unknown]> = []
    for (const k of Object.keys(obj)) {
      const v = (obj as Record<string, unknown>)[k]
      if (v === undefined) continue
      entries.push([k, v])
    }

    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

    const parts = entries.map(([k, v]) => `${encodeString(k)}:${encode(v, seen)}`)
    return `{${parts.join(',')}}`
  } finally {
    seen.delete(obj)
  }
}
