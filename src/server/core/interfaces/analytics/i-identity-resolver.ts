import type {Identity} from '../../domain/analytics/identity.js'
import type {AuthToken} from '../../domain/entities/auth-token.js'

/**
 * Minimal consumer-side view of the auth state store that the identity
 * resolver needs. Defined here next to the consumer (not in the auth
 * module) per CLAUDE.md "interfaces at the consumer".
 *
 * The full auth state store has additional methods (loadToken,
 * onAuthChanged, etc.); the resolver only needs synchronous access to
 * the current cached token.
 */
export interface IAuthStateReader {
  getToken: () => AuthToken | undefined
}

/**
 * Resolves the per-event analytics Identity. Each `resolve()` call reads
 * the current auth + global config state so auth-state transitions
 * mid-batch are observable to consumers (M2.5 stamps identity per
 * `track()` call).
 *
 * Async because `device_id` is sourced from `IGlobalConfigStore` which
 * is itself async; matches the M2.3 super-properties precedent.
 */
export interface IIdentityResolver {
  resolve: () => Promise<Identity>
}
