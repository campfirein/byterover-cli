import type {AnalyticsBatch} from '../../domain/analytics/batch.js'

/**
 * Per-request headers stamped onto every analytics POST.
 *
 * `deviceId` is mandatory — the backend's IdentityResolverGuard rejects
 * anonymous batches without it. `sessionId` is the per-request session
 * token (M3.4 backwards-compat hint); the authoritative per-event identity
 * lives inside each event after M4.1.
 *
 * `userAgent` follows the `brv-cli/<version>` convention; the impl
 * stamps it so backend logs can correlate by CLI version.
 */
export type AnalyticsHttpHeaders = Readonly<{
  deviceId: string
  sessionId?: string
  userAgent: string
}>

/**
 * Outcome of a single send attempt. Tagged-union so the caller
 * (`HttpAnalyticsSender`) can classify the failure mode for the M4.5
 * backoff policy and the M4.6 status command without re-parsing
 * arbitrary error objects.
 *
 * Reasons:
 *   - `timeout`      — request exceeded the 5 second budget.
 *   - `http_4xx`     — backend rejected the payload (validation, auth, etc).
 *   - `http_5xx`     — backend error (non-503); eligible for backoff retry.
 *   - `network`      — connection refused / DNS / TLS / abort before response.
 *   - `rate_limited` — M5.4 (ENG-2658): the app throttler returned 429, or the
 *     nginx edge backstop returned 503. `retryAfterMs` carries the delay the
 *     caller must honor (server `Retry-After` header, then a `retry_after_seconds`
 *     body field, then a 60s default when the server supplies neither).
 *
 * `status` is populated for the HTTP-status paths so the caller can log the
 * exact code. `retryAfterMs` is present only on the `rate_limited` variant.
 */
export type AnalyticsHttpSendResult =
  | Readonly<{
      ok: false
      reason: 'http_4xx' | 'http_5xx' | 'network' | 'timeout'
      status?: number
    }>
  | Readonly<{
      ok: false
      reason: 'rate_limited'
      retryAfterMs: number
      status?: number
    }>
  | Readonly<{ok: true}>

/**
 * Daemon-side HTTP transport for analytics batches. Single attempt per
 * call, no retries (M4.5 owns retry/backoff); 5 second timeout.
 *
 * MUST NOT throw — every failure path returns a structured
 * `AnalyticsHttpSendResult`. Analytics MUST NOT crash the daemon.
 *
 * Implementations:
 *   - `AxiosAnalyticsHttpClient` — production transport over axios.
 *   - In-process fakes in unit tests for offline assertion.
 */
/**
 * Optional per-call controls. `signal` is the M4.4 cancellation hook
 * used by `brv settings set analytics.share false` (and by the daemon shutdown path) to
 * abort an in-flight send so the daemon doesn't half-ship a batch
 * across an enable/disable boundary.
 */
export type AnalyticsHttpSendOptions = Readonly<{
  signal?: AbortSignal
}>

export interface IAnalyticsHttpClient {
  send: (
    batch: AnalyticsBatch,
    headers: AnalyticsHttpHeaders,
    options?: AnalyticsHttpSendOptions,
  ) => Promise<AnalyticsHttpSendResult>
}
