/**
 * Transport Configuration Types
 *
 * These are configuration types for Socket.IO server/client setup.
 * For message schemas and payloads, see ./schemas.ts
 */

/**
 * Dynamic CORS origin check signature, matching Socket.IO's underlying `cors`
 * option callback. Receives the request `Origin` header (may be undefined for
 * non-CORS requests) and invokes `cb(null, true)` to allow or `cb(null, false)`
 * to reject. Pass an `Error` as the first argument to fail the request.
 *
 * Introduced for the channel-protocol auth design (DESIGN §5.6): channel
 * handlers need callback-shaped origin checks for dynamic loopback rules. Not
 * dead weight — see Phase 3 of the channel rollout for the consumer.
 *
 * @see TransportServerConfig.corsOrigin
 */
export type OriginCallback = (
  origin: string | undefined,
  cb: (err: Error | null, allow?: boolean) => void,
) => void

/**
 * Configuration for transport server.
 */
export type TransportServerConfig = {
  /**
   * CORS origin configuration. Accepts any shape Socket.IO's `cors.origin`
   * option supports — a literal `'*'`, a specific origin string, an array of
   * allowed origins, a regex or array of regexes (useful for wildcard ports
   * on loopback), or a callback for dynamic checks.
   *
   * @default '*' for localhost trust
   */
  corsOrigin?: OriginCallback | RegExp | RegExp[] | string | string[]

  /**
   * Phase-3 handshake middleware (Slice 3.5b). Runs BEFORE `connection`
   * fires, so middleware that calls `next(err)` rejects the handshake.
   * Used by the channel-protocol Origin allowlist to block non-localhost
   * origins per CHANNEL_PROTOCOL.md §13.1.
   */
  handshakeMiddleware?: (
    socket: {handshake: {headers: Record<string, string | undefined>}},
    next: (err?: Error) => void,
  ) => void

  /**
   * Ping interval in milliseconds for heartbeat.
   * Lower = faster disconnect detection, higher network overhead.
   */
  pingIntervalMs?: number

  /**
   * Ping timeout in milliseconds.
   * If client doesn't respond within this time, considered disconnected.
   */
  pingTimeoutMs?: number
}

/**
 * Socket.IO transport types.
 * 'websocket' is preferred for sandboxed environments (like IDE terminals).
 * 'polling' uses HTTP long-polling which may be blocked by some sandboxes.
 */
export type SocketTransport = 'polling' | 'websocket'

/**
 * Configuration for transport client.
 */
export type TransportClientConfig = {
  /**
   * Connection timeout in milliseconds.
   */
  connectTimeoutMs?: number

  /**
   * Number of reconnection attempts before giving up.
   */
  reconnectionAttempts?: number

  /**
   * Maximum reconnection delay in milliseconds.
   */
  reconnectionDelayMaxMs?: number

  /**
   * Initial reconnection delay in milliseconds.
   */
  reconnectionDelayMs?: number

  /**
   * Default request timeout in milliseconds.
   */
  requestTimeoutMs?: number

  /**
   * Room operation timeout in milliseconds.
   */
  roomTimeoutMs?: number

  /**
   * Socket.IO transport types to use.
   * Defaults to ['websocket'] to avoid HTTP polling issues in sandboxed environments.
   * Set to ['polling', 'websocket'] for default Socket.IO behavior.
   */
  transports?: SocketTransport[]
}
