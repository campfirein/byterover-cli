import type {StoredAnalyticsRecord} from '../../../shared/analytics/stored-record.js'
import type {IAnalyticsHttpClient} from '../../core/interfaces/analytics/i-analytics-http-client.js'
import type {
  AnalyticsSenderOptions,
  IAnalyticsSender,
  SendResult,
} from '../../core/interfaces/analytics/i-analytics-sender.js'
import type {IAuthStateReader} from '../../core/interfaces/analytics/i-identity-resolver.js'
import type {IGlobalConfigStore} from '../../core/interfaces/storage/i-global-config-store.js'

import {toWireEvent} from '../../../shared/analytics/stored-record.js'
import {AnalyticsBatch} from '../../core/domain/analytics/batch.js'

export interface HttpAnalyticsSenderDeps {
  authStateReader: IAuthStateReader
  globalConfigStore: IGlobalConfigStore
  httpClient: IAnalyticsHttpClient
  userAgent: string
}

/**
 * Bridges the M10.1 `IAnalyticsSender` contract over an
 * `IAnalyticsHttpClient`. The sender owns wire-format composition
 * (records → `AnalyticsBatch`) and request-level header assembly
 * (device id, session id, user-agent); the http client owns transport
 * (timeout, status classification, network errors).
 *
 * Mapping rules:
 *   - Empty input → `{succeeded: [], failed: []}` without an HTTP call.
 *   - HTTP success → every input id classified as `succeeded`.
 *   - HTTP failure (timeout / 4xx / 5xx / network) → every input id
 *     classified as `failed`; M9.2's retry-cap inside `JsonlAnalyticsStore.
 *     updateStatus(_, 'failed')` increments `attempts` and terminates rows
 *     at MAX_ATTEMPTS. Backoff (M4.5) reacts to the structured failure
 *     reason later.
 *
 * Per-record granularity is intentionally collapsed here: the backend's
 * 200 response is batch-level (it counts accepted/rejected internally
 * via `IngestBatchResult` but does not surface per-event ids). All-or-
 * nothing matches that contract.
 *
 * MUST NOT throw — analytics MUST NOT crash the daemon. Collaborator
 * failures (e.g. globalConfigStore disk error) are caught and surface
 * as `failed` so the retry policy can react.
 */
export class HttpAnalyticsSender implements IAnalyticsSender {
  private readonly deps: HttpAnalyticsSenderDeps

  public constructor(deps: HttpAnalyticsSenderDeps) {
    this.deps = deps
  }

  public async send(
    records: readonly StoredAnalyticsRecord[],
    options?: AnalyticsSenderOptions,
  ): Promise<SendResult> {
    if (records.length === 0) return {failed: [], succeeded: []}

    const ids = records.map((r) => r.id)
    try {
      const config = await this.deps.globalConfigStore.read()
      const deviceId = config?.deviceId
      if (deviceId === undefined || deviceId === '') {
        // Backend requires `x-byterover-device-id` on every batch.
        // Without it the request would be rejected with 400; ship the
        // records as failed so the retry-cap policy bumps attempts and
        // eventually terminates them rather than looping forever.
        return {failed: [...ids], succeeded: []}
      }

      const sessionKey = this.deps.authStateReader.getToken()?.sessionKey
      const batch = AnalyticsBatch.create(records.map((r) => toWireEvent(r)))
      const httpResult = await this.deps.httpClient.send(
        batch,
        {
          deviceId,
          ...(sessionKey !== undefined && sessionKey !== '' ? {sessionId: sessionKey} : {}),
          userAgent: this.deps.userAgent,
        },
        // M4.4: forward the cancellation signal so `brv analytics disable`
        // (or shutdown) can abort an in-flight POST. The http client
        // classifies aborted requests as `network`, which maps here to
        // an all-failed result — same as any other transport failure.
        options?.signal === undefined ? undefined : {signal: options.signal},
      )

      if (httpResult.ok) return {failed: [], succeeded: [...ids]}
      // M4.5: surface the http-level failure reason so AnalyticsClient
      // can feed it into the backoff policy. `http_4xx` is intentionally
      // forwarded as-is so the caller can suppress backoff advancement
      // (4xx is a payload-shape problem, not a transient signal).
      return {failed: [...ids], reason: httpResult.reason, succeeded: []}
    } catch {
      // Defensive: any collaborator surprise (config read throws,
      // toWireEvent edge case, etc.) maps to a batch-level failure.
      // The retry-cap policy owns terminal classification. Tagged as
      // `network` for M4.5 — internal collaborator failures are treated
      // as transient (try again later), not as permanent payload-shape
      // errors. M4.5's `AnalyticsClient` advances the backoff policy
      // when it sees this reason.
      return {failed: [...ids], reason: 'network', succeeded: []}
    }
  }
}
