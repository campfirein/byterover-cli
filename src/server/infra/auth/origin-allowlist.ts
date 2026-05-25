/**
 * Phase-3 Origin allowlist (Slice 3.5b).
 *
 * CHANNEL_PROTOCOL.md §13.1 (Phase-3 spec edit) requires hosts to validate
 * the Origin header against an allowlist BEFORE completing the Socket.IO
 * handshake. Non-allowlisted origins MUST be rejected with
 * `CHANNEL_UNAUTHORIZED` BEFORE any `channel:*` event handler fires.
 *
 * Default allowlist:
 *   - `http://127.0.0.1[:port]`
 *   - `http://localhost[:port]`
 *   - `http://[::1][:port]`
 *
 * Extension surface:
 *   - `extraOrigins`: explicit list, exact host:port matches. The web UI in
 *     dev mode (cross-origin Vite) supplies its own origin via the
 *     `BRV_ALLOWED_ORIGINS` env var, which the daemon plumbs into this
 *     allowlist.
 *
 * Matching is host:port-only (path/query ignored) so the same allowlist
 * entry covers every endpoint served from the allowed origin.
 */

export type OriginAllowlistOptions = {
  readonly extraOrigins?: readonly string[]
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

const parseOrigin = (raw: string): undefined | URL => {
  try {
    return new URL(raw)
  } catch {
    return undefined
  }
}

const hostKey = (url: URL): string => {
  // URL.host strips default ports; URL.port is '' when default. Use both so
  // explicit-port entries (`http://localhost:7700`) match exact-port origins.
  const hostname = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname
  return url.port === '' ? `${url.protocol}//${hostname}` : `${url.protocol}//${hostname}:${url.port}`
}

const isLoopback = (url: URL): boolean => LOOPBACK_HOSTNAMES.has(url.hostname.replaceAll(/[[\]]/g, ''))

type Next = (err?: Error) => void

export type OriginAllowlist = {
  socketioMiddleware(socket: {handshake: {headers: Record<string, string | undefined>}}, next: Next): void
  test(origin?: string): boolean
}

export const makeOriginAllowlist = (options: OriginAllowlistOptions = {}): OriginAllowlist => {
  const extras = new Set<string>()
  for (const raw of options.extraOrigins ?? []) {
    const url = parseOrigin(raw)
    if (url !== undefined) extras.add(hostKey(url))
  }

  const test = (origin?: string): boolean => {
    if (origin === undefined || origin === '') return false
    const url = parseOrigin(origin)
    if (url === undefined) return false
    // Only http/https; reject other schemes outright.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (isLoopback(url)) return true
    return extras.has(hostKey(url))
  }

  return {
    socketioMiddleware(socket, next) {
      const {origin} = socket.handshake.headers
      // Allow connections without an Origin header (Node CLI clients via
      // socket.io-client v4 omit Origin entirely). Browser clients SET the
      // header and are subject to allowlist checks.
      if (origin === undefined) {
        next()
        return
      }

      if (test(origin)) {
        next()
        return
      }

      next(new Error(`CHANNEL_UNAUTHORIZED: origin "${origin}" is not on the allowlist`))
    },
    test,
  }
}

/**
 * Convenience: parse `BRV_ALLOWED_ORIGINS` (comma-separated) into the
 * options array consumed by {@link makeOriginAllowlist}.
 */
export const allowlistFromEnv = (env: NodeJS.ProcessEnv = process.env): OriginAllowlistOptions => {
  const raw = env.BRV_ALLOWED_ORIGINS
  if (raw === undefined || raw.trim() === '') return {}
  const extras = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  return {extraOrigins: extras}
}
