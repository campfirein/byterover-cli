import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'

/**
 * Subscribe the analytics client to identity-changing auth transitions.
 *
 * M4.1 contract: `AuthStateStore.onAuthChanged` fires on login, logout,
 * account switch, AND token refresh. Only the identity-changing
 * transitions (login / logout / account switch) drop the analytics
 * queue. A pure access-token refresh keeps the same user_id and must
 * NOT clear pending events.
 *
 * The closure tracks the previously-seen userId locally so the callback
 * distinguishes "same user, new accessToken" (skip) from "different
 * identity" (clear). `previousUserId` is seeded from the current cached
 * token so the first callback after subscribe doesn't fire a spurious
 * clear when the token was already loaded.
 *
 * Extracted from `feature-handlers.ts` so the wiring is testable in
 * isolation — booting the full feature-handler graph would require
 * stubbing every HTTP service and config store the daemon uses. Keeping
 * this a 1-call function with two collaborators makes the
 * `IAuthStateStore` multi-listener contract (M4.1) testable end-to-end
 * without infrastructure ceremony.
 */
export function wireAnalyticsAuthTransition(
  authStateStore: IAuthStateStore,
  analyticsClient: IAnalyticsClient,
): void {
  let previousUserId: string | undefined = authStateStore.getToken()?.userId
  authStateStore.onAuthChanged((token) => {
    const nextUserId = token?.userId
    if (nextUserId === previousUserId) return
    previousUserId = nextUserId
    // eslint-disable-next-line no-void
    void analyticsClient.onAuthTransition()
  })
}
