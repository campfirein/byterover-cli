import {randomUUID} from 'node:crypto'

import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {IGlobalConfigStore} from '../../../core/interfaces/storage/i-global-config-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  GlobalConfigEvents,
  type GlobalConfigGetResponse,
  type GlobalConfigSetAnalyticsRequest,
  type GlobalConfigSetAnalyticsResponse,
} from '../../../../shared/transport/events/global-config-events.js'
import {GLOBAL_CONFIG_VERSION} from '../../../constants.js'
import {GlobalConfig} from '../../../core/domain/entities/global-config.js'

export interface GlobalConfigHandlerDeps {
  /**
   * M4.4: optional analytics client used to cancel any in-flight HTTP
   * send when `brv analytics disable` flips the flag from true → false.
   * Disable does NOT drop the queue or clear JSONL — those stay so a
   * future re-enable ships the backlog. Optional for back-compat with
   * test harnesses that don't construct a real analytics client.
   */
  analyticsClient?: IAnalyticsClient
  globalConfigStore: IGlobalConfigStore
  transport: ITransportServer
}

/**
 * Handles globalConfig:get and globalConfig:setAnalytics events.
 * Re-reads the file every call (no in-memory cache for transport responses)
 * so the daemon always reflects the latest on-disk state.
 *
 * `read()` is a pure read: when no config file exists yet, returns
 * synthetic defaults (analytics: false, empty deviceId). Persistence is
 * deferred to the first SET_ANALYTICS write path, where deviceId is
 * generated and stored atomically — keeping read() pure avoids a race
 * where two concurrent GETs each create+write a different deviceId.
 *
 * SET_ANALYTICS is idempotent: if the requested state matches current
 * state, the file is not rewritten.
 *
 * Maintains a SYNC in-process cache of the analytics flag for consumers
 * that need a synchronous getter (AnalyticsClient.isEnabled). The cache
 * is populated by an explicit `await refreshCache()` (the daemon
 * bootstrap awaits this once before constructing AnalyticsClient) and
 * refreshed after every successful SET_ANALYTICS write or read of an
 * existing on-disk config. Transport responses still read fresh from
 * disk — the cache is purely an in-process bridge for sync consumers.
 */
export class GlobalConfigHandler {
  private analyticsClient: IAnalyticsClient | undefined
  private cachedAnalytics: boolean | undefined
  private readonly globalConfigStore: IGlobalConfigStore
  private readonly transport: ITransportServer
  // Serializes SET_ANALYTICS write paths. Two concurrent enables on a
  // fresh install would otherwise both observe `existing=undefined`, both
  // generate a different `randomUUID()` deviceId, and both write — the
  // persisted deviceId would be whichever lost the write race. Chain
  // pattern mirrors `JsonlAnalyticsStore.writeChain`.
  private writeChain: Promise<void> = Promise.resolve()

  constructor(deps: GlobalConfigHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.globalConfigStore = deps.globalConfigStore
    this.transport = deps.transport
  }

  /**
   * Synchronous getter for the cached analytics flag. Used by daemon-side
   * consumers (M2.5's AnalyticsClient) that cannot await the async store.
   *
   * THROWS if called before `refreshCache()` has resolved (or before any
   * GET/SET handler has populated the cache). A silent default-false here
   * caused a real product-correctness bug during M2.5 development —
   * `daemon_start` would observe analytics=false even when the user had it
   * enabled on disk. Failing loud forces the lifecycle requirement to
   * surface during bootstrap rather than silently miscount.
   */
  getCachedAnalytics(): boolean {
    if (this.cachedAnalytics === undefined) {
      throw new Error(
        'GlobalConfigHandler.getCachedAnalytics() called before refreshCache() resolved. ' +
          'Daemon bootstrap must `await handler.refreshCache()` before constructing any consumer that reads the cache.',
      )
    }

    return this.cachedAnalytics
  }

  /**
   * Synchronously refreshes the cached analytics flag from disk. Daemon
   * bootstrap awaits this once before constructing AnalyticsClient so
   * the very first `track()` (e.g. `daemon_start`) sees the correct
   * enabled state. Subsequent updates happen automatically inside
   * SET_ANALYTICS without any caller involvement.
   */
  async refreshCache(): Promise<void> {
    try {
      const existing = await this.globalConfigStore.read()
      this.cachedAnalytics = existing?.analytics ?? false
    } catch {
      // Fail-safe: explicitly set the cache to false on any read failure so
      // a subsequent getCachedAnalytics() does NOT throw. Production
      // FileGlobalConfigStore catches its own errors and never throws, but
      // we MUST handle a hypothetical store that does — otherwise a
      // bootstrap read failure would crash the daemon when track() runs.
      this.cachedAnalytics = false
    }
  }

  /**
   * M4.4: late-bound analytics client setter. The composition root
   * constructs `GlobalConfigHandler` BEFORE `AnalyticsClient` exists
   * (the cached-analytics flag must be populated before the client
   * reads it). This setter closes that loop: once the client is built,
   * the daemon wires it in so disable-time `abort()` works.
   *
   * Calling this more than once silently replaces the reference. Idempotent.
   */
  setAnalyticsClient(client: IAnalyticsClient): void {
    this.analyticsClient = client
  }

  setup(): void {
    this.transport.onRequest<void, GlobalConfigGetResponse>(GlobalConfigEvents.GET, async () => this.read())
    this.transport.onRequest<GlobalConfigSetAnalyticsRequest, GlobalConfigSetAnalyticsResponse>(
      GlobalConfigEvents.SET_ANALYTICS,
      async (data) => this.setAnalytics(data.analytics),
    )
  }

  private async doSetAnalytics(analytics: boolean): Promise<GlobalConfigSetAnalyticsResponse> {
    const existing = await this.globalConfigStore.read()
    const previous = existing?.analytics ?? false

    // Idempotent fast path: short-circuit before generating a deviceId.
    // If existing is undefined and the requested value matches the default
    // (false), no file is created — the next GET will seed.
    if (previous === analytics) {
      this.cachedAnalytics = previous
      return {current: previous, previous}
    }

    const current = existing ?? GlobalConfig.create(randomUUID())
    const updated = current.withAnalytics(analytics)
    await this.globalConfigStore.write(updated)
    // Cache is in-process-authoritative — we trust the value just written.
    // Cross-process changes (another daemon writing the same file, manual
    // edits) are NOT observable until the next daemon restart. The
    // single-daemon model makes this safe today.
    this.cachedAnalytics = updated.analytics

    // M4.4: on enable → disable, abort any in-flight analytics HTTP so
    // the daemon doesn't half-ship a batch across the boundary. Disable
    // does NOT drop the queue or clear JSONL — the backlog persists and
    // ships on re-enable. abort() errors are swallowed: a failed cancel
    // MUST NOT block the config write the user explicitly requested.
    if (previous && !analytics) {
      try {
        this.analyticsClient?.abort()
      } catch {
        /* swallow — analytics MUST NOT block config writes */
      }
    }

    return {current: updated.analytics, previous}
  }

  private async read(): Promise<GlobalConfigGetResponse> {
    const existing = await this.globalConfigStore.read()
    if (existing) {
      this.cachedAnalytics = existing.analytics
      return {
        analytics: existing.analytics,
        deviceId: existing.deviceId,
        version: existing.version,
      }
    }

    // No config on disk yet — return synthetic defaults. Persistence is
    // deferred to the first SET_ANALYTICS write path, where deviceId is
    // generated and stored atomically. Keeping read() side-effect-free
    // closes the race where two concurrent GETs would each create+write a
    // different deviceId. Cache population for synchronous consumers
    // happens via refreshCache() at daemon bootstrap, not here.
    return {
      analytics: false,
      deviceId: '',
      version: GLOBAL_CONFIG_VERSION,
    }
  }

  private async setAnalytics(analytics: boolean): Promise<GlobalConfigSetAnalyticsResponse> {
    // Serialize against any in-flight SET_ANALYTICS so concurrent enables
    // on a fresh install do not both seed independent deviceIds.
    const next = this.writeChain.then(async () => this.doSetAnalytics(analytics))
    // Chain itself swallows errors so a failure in one call does NOT
    // reject all subsequent calls; the awaiter still observes its own error.
    this.writeChain = next.then(
      () => {},
      () => {},
    )
    return next
  }
}
