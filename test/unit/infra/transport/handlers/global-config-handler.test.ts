import type {SinonStubbedInstance} from 'sinon'

import {expect} from 'chai'
import {restore, stub} from 'sinon'

import type {IGlobalConfigStore} from '../../../../../src/server/core/interfaces/storage/i-global-config-store.js'

import {GLOBAL_CONFIG_VERSION} from '../../../../../src/server/constants.js'
import {GlobalConfig} from '../../../../../src/server/core/domain/entities/global-config.js'
import {GlobalConfigHandler} from '../../../../../src/server/infra/transport/handlers/global-config-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {GlobalConfigEvents} from '../../../../../src/shared/transport/events/global-config-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

function createMockGlobalConfigStore(): SinonStubbedInstance<IGlobalConfigStore> {
  return {
    read: stub<[], Promise<GlobalConfig | undefined>>().resolves(),
    write: stub<[GlobalConfig], Promise<void>>().resolves(),
  }
}

// M4.4: minimal analytics client double whose only relevant member for
// the disable-side-effect tests is `abort`. Hoisted to module scope to
// satisfy `unicorn/consistent-function-scoping`.
function makeAnalyticsClientStub(): {abort: ReturnType<typeof stub>} {
  return {abort: stub()}
}

// Full analytics client double for the analytics_disabled emit tests.
// Same module-scope hoist rationale as makeAnalyticsClientStub above.
function makeTrackingClient(): {
  abort: ReturnType<typeof stub>
  flush: ReturnType<typeof stub>
  getRuntimeState: ReturnType<typeof stub>
  onAuthTransition: ReturnType<typeof stub>
  track: ReturnType<typeof stub>
} {
  return {
    abort: stub(),
    flush: stub().resolves({events: []}),
    getRuntimeState: stub().resolves({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: stub().resolves(),
    track: stub(),
  }
}

describe('GlobalConfigHandler', () => {
  let store: SinonStubbedInstance<IGlobalConfigStore>
  let transport: MockTransportServer
  let handler: GlobalConfigHandler

  beforeEach(() => {
    store = createMockGlobalConfigStore()
    transport = createMockTransportServer()
    handler = new GlobalConfigHandler({globalConfigStore: store, transport})
    handler.setup()
  })

  afterEach(() => {
    restore()
  })

  async function callGet(): Promise<{analytics: boolean; deviceId: string; version: string}> {
    const fn = transport._handlers.get(GlobalConfigEvents.GET)
    if (!fn) throw new Error(`handler not registered: ${GlobalConfigEvents.GET}`)
    return fn(undefined, 'client-1')
  }

  async function callSet(analytics: boolean): Promise<{current: boolean; previous: boolean}> {
    const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
    if (!fn) throw new Error(`handler not registered: ${GlobalConfigEvents.SET_ANALYTICS}`)
    return fn({analytics}, 'client-1')
  }

  describe('setup', () => {
    it('registers GET and SET_ANALYTICS handlers', () => {
      expect(transport._handlers.has(GlobalConfigEvents.GET)).to.be.true
      expect(transport._handlers.has(GlobalConfigEvents.SET_ANALYTICS)).to.be.true
    })
  })

  describe('getCachedAnalytics', () => {
    it('throws before refreshCache() resolves', () => {
      expect(() => handler.getCachedAnalytics()).to.throw(/refreshCache/)
    })

    it('returns the cached flag after refreshCache() populates from disk', async () => {
      const config = GlobalConfig.create('device-abc').withAnalytics(true)
      store.read.resolves(config)

      await handler.refreshCache()

      expect(handler.getCachedAnalytics()).to.be.true
    })
  })

  describe('ensureDeviceId', () => {
    const uuidRegex = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i

    it('generates and persists a device_id for a fresh user (no config on disk)', async () => {
      store.read.resolves()

      const deviceId = await handler.ensureDeviceId()

      expect(deviceId, 'returns a non-empty UUID').to.match(uuidRegex)
      expect(store.write.calledOnce, 'persists the seeded config').to.be.true
      const written = store.write.firstCall.args[0]
      expect(written.deviceId).to.equal(deviceId)
      // device_id seeding is independent of analytics — stays opt-in (false).
      expect(written.analytics).to.equal(false)
    })

    it('returns the existing device_id WITHOUT writing (idempotent, no drift)', async () => {
      store.read.resolves(GlobalConfig.create('existing-device-id').withAnalytics(true))

      const deviceId = await handler.ensureDeviceId()

      expect(deviceId).to.equal('existing-device-id')
      expect(store.write.called, 'must not regenerate or rewrite when present').to.be.false
    })

    it('is stable across calls — never produces a divergent id once seeded', async () => {
      store.read.resolves()
      const first = await handler.ensureDeviceId()
      // simulate persistence: subsequent reads now see the seeded config
      store.read.resolves(GlobalConfig.create(first))

      const second = await handler.ensureDeviceId()

      expect(second).to.equal(first)
    })
  })

  describe('refreshCache', () => {
    it('sets cache to false when no config exists on disk', async () => {
      store.read.resolves()

      await handler.refreshCache()

      expect(handler.getCachedAnalytics()).to.be.false
    })

    it('swallows store.read errors and sets cache to false (fail-safe)', async () => {
      store.read.rejects(new Error('disk failure'))

      await handler.refreshCache()

      expect(handler.getCachedAnalytics()).to.be.false
    })
  })

  describe('GET handler', () => {
    it('returns disk values when config exists', async () => {
      const config = GlobalConfig.create('device-xyz').withAnalytics(true)
      store.read.resolves(config)

      const result = await callGet()

      expect(result).to.deep.equal({
        analytics: true,
        deviceId: 'device-xyz',
        version: config.version,
      })
      expect(store.write.called, 'must not write on read').to.be.false
    })

    it('returns synthetic defaults and does NOT write when no config exists (D1 invariant)', async () => {
      store.read.resolves()

      const result = await callGet()

      expect(result).to.deep.equal({
        analytics: false,
        deviceId: '',
        version: GLOBAL_CONFIG_VERSION,
      })
      expect(store.write.called, 'read() must be pure — no write on missing config').to.be.false
    })

    it('updates the cached flag when config exists', async () => {
      const config = GlobalConfig.create('device-1').withAnalytics(true)
      store.read.resolves(config)

      await callGet()

      expect(handler.getCachedAnalytics()).to.be.true
    })
  })

  describe('SET_ANALYTICS handler', () => {
    it('idempotent fast-path: no write when requested value matches current', async () => {
      const config = GlobalConfig.create('device-1').withAnalytics(true)
      store.read.resolves(config)

      const result = await callSet(true)

      expect(result).to.deep.equal({current: true, previous: true})
      expect(store.write.called, 'must not write on idempotent SET').to.be.false
    })

    it('idempotent fast-path: no write when toggling from default (no config) to false', async () => {
      store.read.resolves()

      const result = await callSet(false)

      expect(result).to.deep.equal({current: false, previous: false})
      expect(store.write.called, 'must not seed a config just to match the default').to.be.false
    })

    it('round-trip: writes updated config and returns previous/current', async () => {
      const config = GlobalConfig.create('device-1').withAnalytics(false)
      store.read.resolves(config)

      const result = await callSet(true)

      expect(result).to.deep.equal({current: true, previous: false})
      expect(store.write.calledOnce).to.be.true
      const written = store.write.firstCall.args[0]
      expect(written.deviceId).to.equal('device-1')
      expect(written.analytics).to.be.true
    })

    it('seeds a new deviceId when enabling for the first time (no config on disk)', async () => {
      store.read.resolves()

      const result = await callSet(true)

      expect(result.current).to.be.true
      expect(result.previous).to.be.false
      expect(store.write.calledOnce).to.be.true
      const written = store.write.firstCall.args[0]
      expect(written.deviceId.length).to.be.greaterThan(0)
      expect(written.analytics).to.be.true
    })

    it('updates the cached flag after a successful write', async () => {
      const config = GlobalConfig.create('device-1').withAnalytics(false)
      store.read.resolves(config)

      await callSet(true)

      expect(handler.getCachedAnalytics()).to.be.true
    })

    it('serializes concurrent enables from a fresh install: writes once, single deviceId persists', async () => {
      // Both callers observe the same fresh-install (no config). Without
      // serialization both would create a different deviceId and both would
      // write — last-write wins and the loser's response carries a deviceId
      // that no longer exists on disk. With serialization the first writes
      // a fresh uuid and the second hits the idempotent fast-path.
      store.read.resolves()
      const writtenDeviceIds: string[] = []
      store.write.callsFake(async (cfg: GlobalConfig) => {
        // Simulate the on-disk seeding so the second serialized caller's
        // read sees the now-written config.
        writtenDeviceIds.push(cfg.deviceId)
        store.read.resolves(cfg)
      })

      const [first, second] = await Promise.all([callSet(true), callSet(true)])

      expect(store.write.callCount, 'concurrent enables must serialize to a single write').to.equal(1)
      expect(writtenDeviceIds, 'exactly one deviceId persisted').to.have.lengthOf(1)
      expect(first.current).to.be.true
      expect(second.current).to.be.true
    })
  })

  describe('M4.4 abort-on-disable side effect', () => {
    // Disable does NOT drop the queue or clear JSONL — those stay so a
    // future re-enable ships the backlog. The only side effect is
    // cancelling an in-flight HTTP send so the daemon doesn't
    // half-ship a batch across an enable/disable boundary.

    it('calls analyticsClient.abort() exactly once when analytics flips true → false', async () => {
      const analyticsClient = makeAnalyticsClientStub()
      const handlerWithClient = new GlobalConfigHandler({
        analyticsClient: {
          abort: analyticsClient.abort,
          flush: stub().resolves(),
          getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
          onAuthTransition: stub().resolves(),
          // Hand-rolled noop preserves the generic `track<E>` signature.
          track(): void {
            /* no-op */
          },
        },
        globalConfigStore: store,
        transport,
      })
      handlerWithClient.setup()

      // Seed disk as currently enabled.
      const enabled = GlobalConfig.create('device-x').withAnalytics(true)
      store.read.resolves(enabled)

      // Now disable.
      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      await fn({analytics: false}, 'client-1')

      expect(analyticsClient.abort.calledOnce, 'abort must fire on enable→disable transition').to.be.true
    })

    it('does NOT call abort() when the disable is an idempotent no-op (already disabled)', async () => {
      const analyticsClient = makeAnalyticsClientStub()
      const handlerWithClient = new GlobalConfigHandler({
        analyticsClient: {
          abort: analyticsClient.abort,
          flush: stub().resolves(),
          getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
          onAuthTransition: stub().resolves(),
          // Hand-rolled noop preserves the generic `track<E>` signature.
          track(): void {
            /* no-op */
          },
        },
        globalConfigStore: store,
        transport,
      })
      handlerWithClient.setup()

      // Already disabled (or never enabled). previous === false, requested === false.
      store.read.resolves()

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      await fn({analytics: false}, 'client-1')

      expect(analyticsClient.abort.called, 'no transition = no abort').to.be.false
    })

    it('does NOT call abort() when the user enables (false → true)', async () => {
      const analyticsClient = makeAnalyticsClientStub()
      const handlerWithClient = new GlobalConfigHandler({
        analyticsClient: {
          abort: analyticsClient.abort,
          flush: stub().resolves(),
          getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
          onAuthTransition: stub().resolves(),
          // Hand-rolled noop preserves the generic `track<E>` signature.
          track(): void {
            /* no-op */
          },
        },
        globalConfigStore: store,
        transport,
      })
      handlerWithClient.setup()

      const disabled = GlobalConfig.create('device-x').withAnalytics(false)
      store.read.resolves(disabled)

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      await fn({analytics: true}, 'client-1')

      expect(analyticsClient.abort.called, 'enable is not a transition that requires abort').to.be.false
    })

    it('still completes the config write when abort() throws', async () => {
      const handlerWithClient = new GlobalConfigHandler({
        analyticsClient: {
          abort() {
            throw new Error('abort boom')
          },
          flush: stub().resolves(),
          getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
          onAuthTransition: stub().resolves(),
          // Hand-rolled noop preserves the generic `track<E>` signature.
          track(): void {
            /* no-op */
          },
        },
        globalConfigStore: store,
        transport,
      })
      handlerWithClient.setup()

      const enabled = GlobalConfig.create('device-x').withAnalytics(true)
      store.read.resolves(enabled)

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      const response = await fn({analytics: false}, 'client-1')

      expect(response.current, 'config write must complete even if abort threw').to.be.false
      expect(response.previous).to.be.true
      expect(store.write.calledOnce, 'config flush still happens').to.be.true
    })

    it('does not require analyticsClient (backwards-compat: dep is optional)', async () => {
      // Pre-M4.4 callers (or test harnesses) don't wire analyticsClient.
      // The handler must still work — the abort side-effect is skipped.
      const handlerNoClient = new GlobalConfigHandler({globalConfigStore: store, transport})
      handlerNoClient.setup()

      const enabled = GlobalConfig.create('device-x').withAnalytics(true)
      store.read.resolves(enabled)

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      const response = await fn({analytics: false}, 'client-1')

      expect(response.current, 'works without analyticsClient').to.be.false
    })
  })

  describe('rotateDeviceId', () => {
    it('returns false and does NOT write when no config file exists', async () => {
      store.read.resolves()

      const rotated = await handler.rotateDeviceId()

      expect(rotated).to.be.false
      expect(store.write.called, 'must not seed a config just to rotate').to.be.false
    })

    it('writes a new deviceId, preserves analytics flag + version, and returns true', async () => {
      const before = GlobalConfig.create('device-old').withAnalytics(true)
      store.read.resolves(before)

      const rotated = await handler.rotateDeviceId()

      expect(rotated).to.be.true
      expect(store.write.calledOnce).to.be.true
      const written = store.write.firstCall.args[0]
      expect(written.deviceId).to.not.equal('device-old')
      // Pin UUID v4 shape so a regression that swaps in a non-UUID source
      // (e.g. Date.now().toString()) fails loudly at the test boundary.
      expect(written.deviceId, 'rotated to a UUID v4').to.match(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      expect(written.analytics, 'analytics flag preserved').to.equal(before.analytics)
      expect(written.version, 'version preserved').to.equal(before.version)
    })

    it('serializes concurrent rotate + setAnalytics through writeChain', async () => {
      // Pre-existing config so neither call hits the idempotent no-op path.
      const before = GlobalConfig.create('device-A').withAnalytics(false)
      store.read.resolves(before)

      const writeOrder: string[] = []
      let resolveFirst!: () => void
      const firstWriteGate = new Promise<void>((resolve) => {
        resolveFirst = resolve
      })

      // First write call (rotation) gates on firstWriteGate so we can
      // observe whether the second call (setAnalytics) waits for it.
      // Label by call ordinal (operation identity), NOT by `cfg.analytics`
      // — the seed could change in the future and a content-based label
      // would silently mislabel.
      store.write.callsFake(async (_cfg: GlobalConfig) => {
        const ordinal = store.write.callCount
        if (ordinal === 1) {
          await firstWriteGate
        }

        writeOrder.push(ordinal === 1 ? 'rotate' : 'setAnalytics')
        store.read.resolves(_cfg)
      })

      const rotatePromise = handler.rotateDeviceId()
      const setPromise = (async () => {
        const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
        if (!fn) throw new Error('SET_ANALYTICS handler not registered')
        return fn({analytics: true}, 'client-1')
      })()

      // Give the event loop a tick so both calls enter the chain.
      await new Promise((resolve) => {
        setImmediate(resolve)
      })

      expect(writeOrder, 'second write must NOT have started while first is gated').to.have.lengthOf(0)
      resolveFirst()

      await Promise.all([rotatePromise, setPromise])

      expect(writeOrder).to.deep.equal(['rotate', 'setAnalytics'])
    })

    it('does NOT mutate cachedAnalytics', async () => {
      const before = GlobalConfig.create('device-1').withAnalytics(true)
      store.read.resolves(before)
      await handler.refreshCache()
      expect(handler.getCachedAnalytics(), 'cache starts true').to.be.true

      await handler.rotateDeviceId()

      expect(handler.getCachedAnalytics(), 'rotation must leave the cached flag untouched').to.be.true
    })

    it('does NOT emit any analytics event', async () => {
      const analyticsClient = makeTrackingClient()
      const handlerWithClient = new GlobalConfigHandler({analyticsClient, globalConfigStore: store, transport})
      handlerWithClient.setup()

      const before = GlobalConfig.create('device-old').withAnalytics(true)
      store.read.resolves(before)

      await handlerWithClient.rotateDeviceId()

      expect(analyticsClient.track.called, 'rotation is implicit — no analytics event fires').to.be.false
    })
  })

  describe('analytics_disabled emit', () => {
    it('emits analytics_disabled exactly once on enable→disable transition', async () => {
      const analyticsClient = makeTrackingClient()
      const handlerWithClient = new GlobalConfigHandler({analyticsClient, globalConfigStore: store, transport})
      handlerWithClient.setup()

      const enabled = GlobalConfig.create('device-x').withAnalytics(true)
      store.read.resolves(enabled)

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      await fn({analytics: false}, 'client-1')

      const trackCalls = analyticsClient.track
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.ANALYTICS_DISABLED)
      expect(trackCalls.length, 'analytics_disabled fires exactly once on disable transition').to.equal(1)
    })

    it('emits BEFORE cachedAnalytics flips (so isEnabled reads true at track time)', async () => {
      const analyticsClient = makeTrackingClient()
      const handlerWithClient = new GlobalConfigHandler({analyticsClient, globalConfigStore: store, transport})
      handlerWithClient.setup()

      const enabled = GlobalConfig.create('device-x').withAnalytics(true)
      store.read.resolves(enabled)
      await handlerWithClient.refreshCache()
      expect(handlerWithClient.getCachedAnalytics(), 'cache starts true after refresh').to.be.true

      // Capture the value of cachedAnalytics at the moment track() is called.
      let cacheAtTrack: boolean | undefined
      analyticsClient.track.callsFake(() => {
        cacheAtTrack = handlerWithClient.getCachedAnalytics()
      })

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      await fn({analytics: false}, 'client-1')

      expect(cacheAtTrack, 'cache still reports true at the moment track fires').to.equal(true)
      expect(handlerWithClient.getCachedAnalytics(), 'cache flips to false after the call returns').to.equal(false)
    })

    it('does NOT emit on idempotent disable (false → false)', async () => {
      const analyticsClient = makeTrackingClient()
      const handlerWithClient = new GlobalConfigHandler({analyticsClient, globalConfigStore: store, transport})
      handlerWithClient.setup()

      store.read.resolves() // no config = previous false

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      await fn({analytics: false}, 'client-1')

      const trackCalls = analyticsClient.track
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.ANALYTICS_DISABLED)
      expect(trackCalls.length, 'no transition = no emit').to.equal(0)
    })

    it('does NOT emit on enable (false → true) — analytics_enabled is intentionally not tracked', async () => {
      const analyticsClient = makeTrackingClient()
      const handlerWithClient = new GlobalConfigHandler({analyticsClient, globalConfigStore: store, transport})
      handlerWithClient.setup()

      const disabled = GlobalConfig.create('device-x').withAnalytics(false)
      store.read.resolves(disabled)

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      await fn({analytics: true}, 'client-1')

      const trackCalls = analyticsClient.track
        .getCalls()
        .filter((c: {args: unknown[]}) => c.args[0] === AnalyticsEventNames.ANALYTICS_DISABLED)
      expect(trackCalls.length, 'enable must never produce analytics_disabled').to.equal(0)
    })

    it('does not crash the SET when track throws', async () => {
      const analyticsClient = makeTrackingClient()
      analyticsClient.track.throws(new Error('boom'))
      const handlerWithClient = new GlobalConfigHandler({analyticsClient, globalConfigStore: store, transport})
      handlerWithClient.setup()

      const enabled = GlobalConfig.create('device-x').withAnalytics(true)
      store.read.resolves(enabled)

      const fn = transport._handlers.get(GlobalConfigEvents.SET_ANALYTICS)
      if (!fn) throw new Error('SET_ANALYTICS handler not registered')
      const response = await fn({analytics: false}, 'client-1')

      expect(response.current, 'disable completes even when track throws').to.be.false
      expect(response.previous).to.be.true
    })
  })
})
