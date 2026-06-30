import type {AuthToken} from '../../core/domain/entities/auth-token.js'
import type {ITokenStore} from '../../core/interfaces/auth/i-token-store.js'
import type {
  AuthChangedCallback,
  AuthExpiredCallback,
  BeforeAuthChangedCallback,
  IAuthStateStore,
} from '../../core/interfaces/state/i-auth-state-store.js'

import {AUTH_STATE_POLL_INTERVAL_MS} from '../../constants.js'

const DEFAULT_BEFORE_AUTH_CHANGE_TIMEOUT_MS = 6000

type AuthStateStoreOptions = {
  /**
   * Hang-guard for `onBeforeAuthChange` listeners. Each pre-listener is
   * raced against this timeout so a wedged subsystem (e.g. analytics
   * flush stuck on a slow backend) cannot deadlock auth transitions.
   * Default 6000ms = HTTP-client 5s timeout + 1s slack.
   */
  beforeAuthChangeTimeoutMs?: number
  /** Logging function (optional, defaults to no-op) */
  log?: (message: string) => void
  /** Polling interval in milliseconds (optional, defaults to AUTH_STATE_POLL_INTERVAL_MS) */
  pollIntervalMs?: number
  /** The underlying token store to poll */
  tokenStore: ITokenStore
}

/**
 * Global auth state store.
 *
 * Polls ITokenStore at a configurable interval to detect external changes
 * (login via TUI/CLI, token refresh, logout). Maintains an in-memory cache
 * of the current AuthToken and fires callbacks on state transitions.
 *
 * Change detection: compares accessToken strings.
 * - New token (was undefined, now has value): fires onAuthChanged
 * - Changed token (different accessToken): fires onAuthChanged
 * - Removed token (was present, now undefined): fires onAuthChanged(undefined)
 * - Expired token (was valid, now expired): fires onAuthExpired (once)
 *
 * Uses an isPolling guard to prevent overlapping poll cycles.
 */
export class AuthStateStore implements IAuthStateStore {
  private readonly authChangedCallbacks: AuthChangedCallback[] = []
  private readonly authExpiredCallbacks: AuthExpiredCallback[] = []
  private readonly beforeAuthChangeCallbacks: BeforeAuthChangedCallback[] = []
  private readonly beforeAuthChangeTimeoutMs: number
  private cachedToken: AuthToken | undefined
  private isPolling = false
  private readonly log: (message: string) => void
  private pollInterval: ReturnType<typeof setInterval> | undefined
  private readonly pollIntervalMs: number
  private readonly tokenStore: ITokenStore
  /** Track whether previous poll found the token expired (avoid repeat callbacks) */
  private wasExpired = false

  constructor(options: AuthStateStoreOptions) {
    this.tokenStore = options.tokenStore
    this.pollIntervalMs = options.pollIntervalMs ?? AUTH_STATE_POLL_INTERVAL_MS
    this.beforeAuthChangeTimeoutMs = options.beforeAuthChangeTimeoutMs ?? DEFAULT_BEFORE_AUTH_CHANGE_TIMEOUT_MS
    this.log = options.log ?? (() => {})
  }

  getToken(): AuthToken | undefined {
    return this.cachedToken
  }

  async loadToken(): Promise<AuthToken | undefined> {
    try {
      const token = await this.tokenStore.load()
      await this.updateCachedToken(token)
      return this.cachedToken
    } catch (error) {
      this.log(`Failed to load token: ${error instanceof Error ? error.message : String(error)}`)
      return this.cachedToken
    }
  }

  onAuthChanged(callback: AuthChangedCallback): void {
    this.authChangedCallbacks.push(callback)
  }

  onAuthExpired(callback: AuthExpiredCallback): void {
    this.authExpiredCallbacks.push(callback)
  }

  onBeforeAuthChange(callback: BeforeAuthChangedCallback): void {
    this.beforeAuthChangeCallbacks.push(callback)
  }

  startPolling(): void {
    if (this.pollInterval) return

    this.pollInterval = setInterval(() => {
      // eslint-disable-next-line no-void
      void this.pollOnce()
    }, this.pollIntervalMs)

    this.log('Auth state polling started')
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = undefined
    }

    this.log('Auth state polling stopped')
  }

  /**
   * Dispatch to every registered onAuthChanged listener. One listener
   * throwing must NOT prevent the others from firing or break the
   * polling loop; we log and continue.
   */
  private fireAuthChanged(token: AuthToken | undefined): void {
    for (const callback of this.authChangedCallbacks) {
      try {
        callback(token)
      } catch (error) {
        this.log(`onAuthChanged callback threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private fireAuthExpired(token: AuthToken): void {
    for (const callback of this.authExpiredCallbacks) {
      try {
        callback(token)
      } catch (error) {
        this.log(`onAuthExpired callback threw: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /**
   * Fire pre-transition listeners in registration order, each bounded by
   * `beforeAuthChangeTimeoutMs`. A listener that rejects or hangs is
   * logged best-effort and does NOT block subsequent listeners or the
   * transition itself — this is the contract the analytics force-flush
   * relies on (must not deadlock auth on a wedged backend).
   *
   * The cached token is NOT mutated yet — `getToken()` still returns the
   * old token throughout this call. That guarantee is what lets the
   * analytics flush carry the OLD session header.
   */
  private async fireBeforeAuthChange(
    oldToken: AuthToken | undefined,
    newToken: AuthToken | undefined,
  ): Promise<void> {
    for (const callback of this.beforeAuthChangeCallbacks) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        // eslint-disable-next-line no-await-in-loop
        await Promise.race([
          Promise.resolve(callback(oldToken, newToken)),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.beforeAuthChangeTimeoutMs)
          }),
        ])
      } catch (error) {
        this.log(`onBeforeAuthChange callback rejected: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        // Always clear the hang-guard timer when the callback wins the
        // race (the common fast path). Without this clear, every
        // transition leaks a pending Node timer that keeps the event
        // loop alive for `beforeAuthChangeTimeoutMs` after the callback
        // settled — a shutdown triggered shortly after a transition
        // would block up to that budget waiting for the phantom timer.
        if (timer !== undefined) clearTimeout(timer)
      }
    }
  }

  /**
   * Single poll cycle. Loads token from store and compares with cached.
   * Skips if a poll is already in-flight.
   */
  private async pollOnce(): Promise<void> {
    if (this.isPolling) return

    this.isPolling = true
    try {
      const token = await this.tokenStore.load()
      await this.updateCachedToken(token)
    } catch (error) {
      this.log(`Auth poll error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.isPolling = false
    }
  }

  /**
   * Compare loaded token with cached, fire pre-transition listeners
   * (M4.4), then mutate the cache and fire post-transition listeners.
   *
   * Ordering is load-bearing: the pre-listeners observe the OLD token
   * via `getToken()` because `this.cachedToken` only mutates AFTER they
   * resolve. Without that ordering, M4.4's flush-then-drop hybrid would
   * ship events with the NEW session header but OLD per-event identity,
   * tripping the backend's identity-mismatch path and downgrading those
   * events to anonymous.
   */
  private async updateCachedToken(token: AuthToken | undefined): Promise<void> {
    const previousAccessToken = this.cachedToken?.accessToken
    const newAccessToken = token?.accessToken

    // Detect change: different accessToken (including undefined <-> defined)
    if (previousAccessToken !== newAccessToken) {
      const oldToken = this.cachedToken
      await this.fireBeforeAuthChange(oldToken, token)
      this.cachedToken = token
      this.wasExpired = false
      this.log(`Auth state changed: ${token ? 'token present' : 'token removed'}`)
      this.fireAuthChanged(token)
      return
    }

    // Same token, check for expiry transition
    if (token && token.isExpired() && !this.wasExpired) {
      this.wasExpired = true
      this.log('Auth token expired')
      this.fireAuthExpired(token)
    }

    // Update cached reference (same accessToken but other fields may differ)
    this.cachedToken = token
  }
}
