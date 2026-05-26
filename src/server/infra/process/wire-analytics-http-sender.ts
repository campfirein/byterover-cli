import type {IAnalyticsSender} from '../../core/interfaces/analytics/i-analytics-sender.js'
import type {IAuthStateReader} from '../../core/interfaces/analytics/i-identity-resolver.js'
import type {IGlobalConfigStore} from '../../core/interfaces/storage/i-global-config-store.js'

import {AxiosAnalyticsHttpClient} from '../analytics/axios-analytics-http-client.js'
import {HttpAnalyticsSender} from '../analytics/http-analytics-sender.js'

export type AnalyticsHttpSenderWiring = {
  analyticsBaseUrl: string
  authStateReader: IAuthStateReader
  globalConfigStore: IGlobalConfigStore
  /** CLI semver string (e.g. `3.12.0`). Wrapped into the user-agent header. */
  version: string
}

/**
 * Compose the production analytics sender stack:
 *   AxiosAnalyticsHttpClient (transport — axios POST, 5s timeout, status
 *     classification) wrapped by HttpAnalyticsSender (sender contract —
 *     batch composition + header assembly).
 *
 * Extracted from `feature-handlers.ts` so the wiring is testable in
 * isolation. Booting the full feature-handler graph would require
 * stubbing every HTTP service the daemon uses; this helper exposes only
 * the analytics-relevant collaborators so unit tests can assert the
 * composition shape without infrastructure ceremony.
 *
 * Mirrors the M4.1 `wireAnalyticsAuthTransition` precedent — every
 * composition-root binding gets a thin pure factory + a focused test so
 * a future swap (e.g. swapping axios for undici, or wrapping the sender
 * for M4.5 backoff) lands at one obvious seam.
 *
 * The returned value is the `IAnalyticsSender` consumed by
 * `AnalyticsClient.flush()`.
 */
export function wireAnalyticsHttpSender(wiring: AnalyticsHttpSenderWiring): IAnalyticsSender {
  const httpClient = new AxiosAnalyticsHttpClient({baseUrl: wiring.analyticsBaseUrl})
  return new HttpAnalyticsSender({
    authStateReader: wiring.authStateReader,
    globalConfigStore: wiring.globalConfigStore,
    httpClient,
    userAgent: `brv-cli/${wiring.version}`,
  })
}
