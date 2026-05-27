/**
 * v4 UUID generator that works in non-secure contexts.
 *
 * `crypto.randomUUID()` is restricted to secure contexts (HTTPS, localhost,
 * 127.0.0.1, file://). When the daemon binds on 0.0.0.0 and a LAN peer opens
 * the WebUI at `http://<host-ip>:7700`, the browser treats it as insecure and
 * `randomUUID` is undefined. `crypto.getRandomValues` IS available in those
 * contexts, so this helper falls back to building a v4 UUID from raw bytes.
 *
 * Last-resort `Math.random` branch covers the (very unlikely) absence of
 * `crypto` entirely; the client-side task ID is just a correlation token, not
 * a security boundary, so this is acceptable.
 */
export function generateUuid(): string {
  // DOM lib types `globalThis.crypto` as mandatory, but at runtime it may
  // legitimately be absent (Node SSR pre-20, test stubs via
  // `Object.defineProperty(globalThis, 'crypto', {value: undefined})`).
  // Plain `!== undefined` is the canonical guard; `typeof` is forbidden by
  // the `unicorn/no-typeof-undefined` rule, and `as` casts are forbidden
  // by the CLAUDE.md TS rule.
  const c = globalThis.crypto
  if (c !== undefined && typeof c.randomUUID === 'function') {
    return c.randomUUID()
  }

  const bytes = new Uint8Array(16)
  if (c !== undefined && typeof c.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256)
  }

  // RFC 4122 section 4.4 — set version (4) and variant (10xx) bits.
  // eslint-disable-next-line no-bitwise
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  // eslint-disable-next-line no-bitwise
  bytes[8] = (bytes[8] & 0x3f) | 0x80

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'))
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`
}
