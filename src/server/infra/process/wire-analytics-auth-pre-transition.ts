import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {IAuthStateStore} from '../../core/interfaces/state/i-auth-state-store.js'

/**
 * Subscribe the analytics client to the pre-transition hook so it can
 * flush events under the OLD session header before the auth state
 * commits.
 *
 * The hook fires for any accessToken change, but we only want to flush
 * when the IDENTITY actually changed: login (anon → auth), logout
 * (auth → anon), or account switch (userA → userB). A pure access-token
 * refresh keeps the same userId and would just waste an HTTP call.
 *
 * Errors from flush() are swallowed: analytics MUST NOT block the auth
 * transition. The store's hang-guard provides the upper bound; this
 * helper provides the error-tolerance.
 *
 * Pairs with `wireAnalyticsAuthTransition` (M4.1): pre-hook ships
 * surviving events, then the post-hook drops anything left behind
 * (e.g. records the flush couldn't deliver before the backend timed
 * out).
 */
export function wireAnalyticsAuthPreTransition(
  authStateStore: IAuthStateStore,
  analyticsClient: IAnalyticsClient,
): void {
  authStateStore.onBeforeAuthChange(async (oldToken, newToken) => {
    // Identity-change guard: same userId across the transition (typical
    // access-token refresh) is NOT an identity change. Skip the flush.
    if (oldToken?.userId === newToken?.userId) return

    try {
      await analyticsClient.flush()
    } catch {
      // Swallowed: analytics failures MUST NOT block auth transitions.
      // M4.5 will surface failure reasons via a different channel.
    }
  })
}
