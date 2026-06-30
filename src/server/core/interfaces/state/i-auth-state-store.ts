import type {AuthToken} from '../../domain/entities/auth-token.js'

/**
 * Callback fired when auth state changes (login, refresh, logout).
 *
 * @param token - The new auth token, or undefined if logged out
 */
export type AuthChangedCallback = (token: AuthToken | undefined) => void

/**
 * Callback fired BEFORE the cached auth token is mutated. Listeners
 * can read `getToken()` and observe the OLD token, which is the
 * critical guarantee for M4.4's auth-transition force-flush: the
 * analytics client needs to flush events under the OLD session header
 * before the new token replaces the cache.
 *
 * Listeners are awaited in registration order. A listener that hangs
 * is bounded by `beforeAuthChangeTimeoutMs` (default 6s) so a wedged
 * subsystem cannot deadlock the auth transition.
 */
export type BeforeAuthChangedCallback = (
  oldToken: AuthToken | undefined,
  newToken: AuthToken | undefined,
) => Promise<void> | void

/**
 * Callback fired when auth token has expired.
 * Separate from AuthChanged because an expired token is still "present" —
 * it signals the need for refresh, not that the user logged out.
 */
export type AuthExpiredCallback = (token: AuthToken) => void

/**
 * Global auth state store shared across all projects.
 *
 * Polls the underlying token store to detect external changes
 * (login, token refresh, logout) and notifies listeners via callbacks.
 *
 * The daemon is the centralized auth state owner and broadcasts
 * auth:updated / auth:expired events to all connected clients.
 *
 * Consumed by brv-server.ts wiring.
 */
export interface IAuthStateStore {
  /**
   * Get the current cached auth token.
   * Returns undefined if not loaded yet or user is logged out.
   */
  getToken(): AuthToken | undefined

  /**
   * Force a reload from the underlying token store.
   * Useful on daemon startup to populate the initial cache,
   * or when a client signals that auth state has changed.
   *
   * @returns The loaded token, or undefined if not found
   */
  loadToken(): Promise<AuthToken | undefined>

  /**
   * Register a callback for auth state changes.
   * Fired when: login (new token), token refresh (changed token), logout (undefined).
   *
   * Multiple callbacks supported. Listeners fire in registration order on
   * each transition; one listener throwing does NOT prevent the others
   * from running (impl catches and logs per-callback).
   *
   * @param callback - Function called with the new token (or undefined on logout)
   */
  onAuthChanged(callback: AuthChangedCallback): void

  /**
   * Register a callback for token expiry.
   * Fired when a token that was valid transitions to expired.
   * Only fires once per expiry (not on every poll cycle).
   *
   * Multiple callbacks supported. Listeners fire in registration order;
   * one throwing does NOT prevent the others from running.
   *
   * @param callback - Function called with the expired token
   */
  onAuthExpired(callback: AuthExpiredCallback): void

  /**
   * Register a pre-transition callback that fires BEFORE `cachedToken`
   * mutates. The store awaits the callback (bounded by
   * `beforeAuthChangeTimeoutMs`) before committing the new token and
   * firing `onAuthChanged`. This is the M4.4 hook used by the analytics
   * client to flush events under the OLD session header.
   *
   * Multiple callbacks are awaited in registration order, in series. A
   * rejecting callback is logged best-effort and does NOT block
   * subsequent callbacks or the transition itself.
   *
   * @param callback - Function called with `(oldToken, newToken)`; may
   *                   return a Promise (will be awaited) or void.
   */
  onBeforeAuthChange(callback: BeforeAuthChangedCallback): void

  /**
   * Start polling the token store for changes.
   * Must be called after construction to begin monitoring.
   */
  startPolling(): void

  /**
   * Stop polling and clean up resources.
   * Must be called during shutdown.
   */
  stopPolling(): void
}
