import {createHash} from 'node:crypto'

import {readOrCreateDaemonAuthToken, rotateDaemonAuthToken} from './daemon-token-store.js'

/**
 * Mutable wrapper around the on-disk daemon-auth-token (Slice 3.5a).
 *
 * The Phase-1 `makeChannelAuthMiddleware(token)` captured the token in a
 * closure at daemon bootstrap, so rotation could only take effect on
 * restart. The middleware now reads from `provider.getCurrent()` per
 * request, and `provider.rotate()` updates BOTH the on-disk file and the
 * in-memory cache atomically.
 *
 * `rotate()` returns `{tokenFingerprint, disconnectedClients}`. The
 * fingerprint is `sha256(token).slice(0, 12)` per CHANNEL_PROTOCOL.md
 * §8.3.1 (informational + log-safe; never the token itself).
 * `disconnectedClients` is 0 unless a `disconnectAllChannelClients` hook
 * is supplied — Slice 3.5b will wire that to the Socket.IO transport.
 */
export type DaemonTokenProviderBootArgs = {
  /** Override the data directory (test isolation). Defaults to `BRV_DATA_DIR`. */
  readonly dataDir?: string
  /**
   * Optional hook called AFTER the cache + disk are updated. Returns the
   * count of disconnected clients (surfaced in the rotate-token response).
   */
  readonly disconnectAllChannelClients?: () => Promise<number>
}

const fingerprintOf = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 12)

export class DaemonTokenProvider {
  private current: string
  private readonly dataDir: string | undefined
  private readonly disconnectAllChannelClients: (() => Promise<number>) | undefined

  private constructor(initial: string, options: DaemonTokenProviderBootArgs) {
    this.current = initial
    this.dataDir = options.dataDir
    this.disconnectAllChannelClients = options.disconnectAllChannelClients
  }

  static async boot(options: DaemonTokenProviderBootArgs = {}): Promise<DaemonTokenProvider> {
    const initial = await readOrCreateDaemonAuthToken({dataDir: options.dataDir})
    return new DaemonTokenProvider(initial, options)
  }

  getCurrent(): string {
    return this.current
  }

  async rotate(): Promise<{disconnectedClients: number; tokenFingerprint: string}> {
    const fresh = await rotateDaemonAuthToken({dataDir: this.dataDir})
    // CRITICAL: update the in-memory cache BEFORE any awaited side-effect
    // so any callback (e.g. the disconnect hook) observes the new token.
    // The middleware's next read returns `fresh` from this point on.
    this.current = fresh
    const disconnectedClients = this.disconnectAllChannelClients === undefined
      ? 0
      : await this.disconnectAllChannelClients()
    return {disconnectedClients, tokenFingerprint: fingerprintOf(fresh)}
  }

  tokenFingerprint(): string {
    return fingerprintOf(this.current)
  }
}
