import type {AxiosInstance, AxiosResponse} from 'axios'

import axios, {AxiosError} from 'axios'

import type {AnalyticsBatch} from '../../core/domain/analytics/batch.js'
import type {
  AnalyticsHttpHeaders,
  AnalyticsHttpSendOptions,
  AnalyticsHttpSendResult,
  IAnalyticsHttpClient,
} from '../../core/interfaces/analytics/i-analytics-http-client.js'

const DEFAULT_TIMEOUT_MS = 5000
const EVENTS_PATH = '/v1/events'

type AxiosAnalyticsHttpClientOptions = {
  baseUrl: string
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

  public constructor(options: AxiosAnalyticsHttpClientOptions) {
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
      return classifyResponse(response)
    } catch (error: unknown) {
      return classifyError(error)
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

const classifyResponse = (response: AxiosResponse): AnalyticsHttpSendResult => {
  const {status} = response
  if (status >= 200 && status < 300) return {ok: true}
  if (status >= 400 && status < 500) return {ok: false, reason: 'http_4xx', status}
  if (status >= 500 && status < 600) return {ok: false, reason: 'http_5xx', status}
  // 1xx / 3xx without redirect handling reach here. Treat as network-level
  // anomaly so callers see a tagged result rather than silently succeeding.
  return {ok: false, reason: 'network'}
}

const classifyError = (error: unknown): AnalyticsHttpSendResult => {
  if (axios.isAxiosError(error)) {
    // Timeout: axios surfaces this as `ECONNABORTED` with `code === 'ECONNABORTED'`,
    // or `ETIMEDOUT` on socket-level timeouts.
    if (isTimeoutCode(error)) return {ok: false, reason: 'timeout'}
    // Response present but classifyResponse didn't run (shouldn't happen given
    // `validateStatus: () => true`, but defensively re-classify here).
    if (error.response !== undefined) return classifyResponse(error.response)
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
