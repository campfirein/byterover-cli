import type {AxiosInstance, AxiosResponse} from 'axios'

import axios, {AxiosError} from 'axios'

import type {AnalyticsBatch} from '../../core/domain/analytics/batch.js'
import type {
  AnalyticsHttpHeaders,
  AnalyticsHttpSendOptions,
  AnalyticsHttpSendResult,
  IAnalyticsHttpClient,
} from '../../core/interfaces/analytics/i-analytics-http-client.js'

import {processLog} from '../../utils/process-logger.js'

const DEFAULT_TIMEOUT_MS = 5000
const EVENTS_PATH = '/v1/events'
// M5.4 (ENG-2658): delay applied when a 429 carries no `Retry-After` hint, or
// when the nginx edge backstop trips with a bare 503 (which never carries one).
const DEFAULT_RETRY_AFTER_MS = 60_000

type AxiosAnalyticsHttpClientOptions = {
  baseUrl: string
  /**
   * Sink for operational WARN lines (M5.4 default-backoff fallback). Defaults
   * to the daemon `processLog`; tests inject a spy to assert the WARN fired.
   */
  log?: (message: string) => void
  /** Override request timeout (default 5000ms). Test-only escape hatch. */
  timeoutMs?: number
}

/**
 * Production analytics HTTP transport over axios.
 *
 * Contract (per `IAnalyticsHttpClient` + ENG-2643):
 *   - One POST per call; no retries — M4.5 owns retry/backoff.
 *   - 5 second timeout enforced via the axios instance config.
 *   - Anonymous-friendly: no `Authorization` header, no token plumbing.
 *     `x-byterover-device-id` is mandatory; `x-byterover-session-id` is
 *     an optional backwards-compat hint (per-event identity is the
 *     authoritative source after M4.1).
 *   - MUST NOT throw. Every failure path returns a tagged
 *     `AnalyticsHttpSendResult` so the caller can keep the daemon up.
 *
 * Reason classification: timeout / 4xx / 5xx / network. Anything else
 * (e.g. axios serialization bug) falls into `network` so callers always
 * see a tagged result.
 */
export class AxiosAnalyticsHttpClient implements IAnalyticsHttpClient {
  private readonly axios: AxiosInstance
  private readonly log: (message: string) => void

  public constructor(options: AxiosAnalyticsHttpClientOptions) {
    this.log = options.log ?? processLog
    this.axios = axios.create({
      baseURL: options.baseUrl.replace(/\/+$/, ''),
      // `validateStatus` returning true delegates HTTP-status classification
      // to `classifyResponse` below; axios won't throw on 4xx/5xx so we can
      // map them to tagged failure reasons without catching.
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
    })
  }

  public async send(
    batch: AnalyticsBatch,
    headers: AnalyticsHttpHeaders,
    options?: AnalyticsHttpSendOptions,
  ): Promise<AnalyticsHttpSendResult> {
    try {
      const response = await this.axios.post(EVENTS_PATH, batch.toJson(), {
        headers: this.composeHeaders(headers),
        // M4.4: surface the caller's AbortSignal so `brv analytics
        // disable` / daemon shutdown can cancel an in-flight POST.
        // Pre-aborted signals are honored by axios (it short-circuits
        // before dispatch). Aborted requests classify as `network`
        // (client-side termination, not a server-side condition).
        ...(options?.signal === undefined ? {} : {signal: options.signal}),
      })
      return classifyResponse(response, this.log)
    } catch (error: unknown) {
      return classifyError(error, this.log)
    }
  }

  private composeHeaders(headers: AnalyticsHttpHeaders): Record<string, string> {
    const composed: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': headers.userAgent,
      'x-byterover-device-id': headers.deviceId,
    }
    if (headers.sessionId !== undefined && headers.sessionId !== '') {
      composed['x-byterover-session-id'] = headers.sessionId
    }

    return composed
  }
}

const classifyResponse = (response: AxiosResponse, log: (message: string) => void): AnalyticsHttpSendResult => {
  const {status} = response
  if (status >= 200 && status < 300) return {ok: true}
  // M5.4 (ENG-2658): the app throttler (@nestjs/throttler) returns 429 with a
  // server-supplied `Retry-After`. Honor it (header, then `retry_after_seconds`
  // body, then default) rather than treating it as a payload-shape 4xx.
  if (status === 429) return classifyRateLimited(response, status, log)
  if (status >= 400 && status < 500) return {ok: false, reason: 'http_4xx', status}
  // M5.4: a bare 503 is typically the nginx edge backstop tripping (usually no
  // `Retry-After`). Route it through the same rate-limit path as 429 so a 503
  // that DOES carry a server hint (maintenance page, alternate ingress, CDN) is
  // honored rather than forced to the default — otherwise default delay + WARN.
  // NOT an unreachable backend (the endpoint is up, we're being shed). Other
  // 5xx stay `http_5xx` (genuine transient errors that drive exponential backoff).
  if (status === 503) return classifyRateLimited(response, status, log)

  if (status >= 500 && status < 600) return {ok: false, reason: 'http_5xx', status}
  // 1xx / 3xx without redirect handling reach here. Treat as network-level
  // anomaly so callers see a tagged result rather than silently succeeding.
  return {ok: false, reason: 'network'}
}

const classifyRateLimited = (
  response: AxiosResponse,
  status: number,
  log: (message: string) => void,
): AnalyticsHttpSendResult => {
  const fromHeader = parseRetryAfterHeaderMs(response.headers)
  if (fromHeader !== undefined) return {ok: false, reason: 'rate_limited', retryAfterMs: fromHeader, status}
  const fromBody = parseRetryAfterBodyMs(response.data)
  if (fromBody !== undefined) return {ok: false, reason: 'rate_limited', retryAfterMs: fromBody, status}
  log(
    `analytics.http: ${status} without a usable Retry-After header or retry_after_seconds body, ` +
      `applying default ${DEFAULT_RETRY_AFTER_MS}ms backoff`,
  )
  return {ok: false, reason: 'rate_limited', retryAfterMs: DEFAULT_RETRY_AFTER_MS, status}
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Parse a `Retry-After` header (RFC 7231) — delay-seconds OR HTTP-date — to milliseconds. */
const parseRetryAfterHeaderMs = (headers: unknown): number | undefined => {
  if (!isObject(headers)) return undefined
  // axios lowercases response header keys.
  const raw = headers['retry-after']
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined
  // Preferred form: delay-seconds.
  const asSeconds = Number(raw)
  if (Number.isFinite(asSeconds) && asSeconds > 0) return Math.round(asSeconds * 1000)
  // Alternate form: an HTTP-date — convert to a forward-looking delay. A date in
  // the past (or an unparseable value) yields no usable hint. An absurdly
  // far-future date is bounded downstream by the policy's MAX_SERVER_HINT_MS
  // cap, so there is no setTimeout-overflow risk here.
  const targetMs = Date.parse(String(raw))
  if (!Number.isFinite(targetMs)) return undefined
  const deltaMs = targetMs - Date.now()
  return deltaMs > 0 ? deltaMs : undefined
}

/** Parse a `retry_after_seconds` JSON body field (the throttler's fallback). */
const parseRetryAfterBodyMs = (data: unknown): number | undefined => {
  if (!isObject(data)) return undefined
  const seconds = data.retry_after_seconds
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? Math.round(seconds * 1000)
    : undefined
}

const classifyError = (error: unknown, log: (message: string) => void): AnalyticsHttpSendResult => {
  if (axios.isAxiosError(error)) {
    // Timeout: axios surfaces this as `ECONNABORTED` with `code === 'ECONNABORTED'`,
    // or `ETIMEDOUT` on socket-level timeouts.
    if (isTimeoutCode(error)) return {ok: false, reason: 'timeout'}
    // Response present but classifyResponse didn't run (shouldn't happen given
    // `validateStatus: () => true`, but defensively re-classify here).
    if (error.response !== undefined) return classifyResponse(error.response, log)
    return {ok: false, reason: 'network'}
  }

  // Non-axios throws (e.g. JSON.stringify bug from a circular-reference event)
  // map to network so the caller always sees a tagged result.
  return {ok: false, reason: 'network'}
}

const isTimeoutCode = (error: AxiosError): boolean => {
  const {code} = error
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT'
}
