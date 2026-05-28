import {expect} from 'chai'

import type {
  SettingDescriptor,
  SettingItem,
} from '../../../../../src/server/core/domain/entities/settings.js'
import type {
  ISettingsStore,
  SettingsStartupSnapshot,
} from '../../../../../src/server/core/interfaces/storage/i-settings-store.js'
import type {
  SettingsGetRequest,
  SettingsGetResponse,
  SettingsListResponse,
  SettingsResetRequest,
  SettingsResetResponse,
  SettingsSetRequest,
  SettingsSetResponse,
} from '../../../../../src/shared/transport/events/settings-events.js'

import {
  InvalidSettingValueError,
  ReadonlySettingKeyError,
  UnknownSettingKeyError,
} from '../../../../../src/server/infra/storage/settings-validator.js'
import {
  type ReadonlyInfoProvider,
  SettingsHandler,
} from '../../../../../src/server/infra/transport/handlers/settings-handler.js'
import {SettingsEvents} from '../../../../../src/shared/transport/events/settings-events.js'
import {createMockTransportServer} from '../../../../helpers/mock-factories.js'

class StubSettingsStore implements ISettingsStore {
  public readonly calls: Array<{args: unknown[]; method: string}> = []
  public listResult: readonly SettingItem[] = []
  public setBehavior: (key: string, value: unknown) => Promise<void> = async () => {}

  public async get(key: string): Promise<SettingItem> {
    this.calls.push({args: [key], method: 'get'})
    const found = this.listResult.find((item) => item.key === key)
    if (!found) throw new UnknownSettingKeyError(key)
    return found
  }

  public async list(): Promise<readonly SettingItem[]> {
    this.calls.push({args: [], method: 'list'})
    return this.listResult
  }

  public async readStartupSnapshot(): Promise<SettingsStartupSnapshot> {
    return {invalid: [], values: {}}
  }

  public async reset(key: string): Promise<void> {
    this.calls.push({args: [key], method: 'reset'})
    if (key === 'not.a.real.key') throw new UnknownSettingKeyError(key)
  }

  public async set(key: string, value: unknown): Promise<void> {
    this.calls.push({args: [key, value], method: 'set'})
    await this.setBehavior(key, value)
  }
}

describe('SettingsHandler', () => {
  let store: StubSettingsStore
  let transport: ReturnType<typeof createMockTransportServer>

  beforeEach(() => {
    store = new StubSettingsStore()
    transport = createMockTransportServer()
    new SettingsHandler({store, transport}).setup()
  })

  describe('setup', () => {
    it('registers all four settings events', () => {
      expect(transport._handlers.has(SettingsEvents.LIST)).to.be.true
      expect(transport._handlers.has(SettingsEvents.GET)).to.be.true
      expect(transport._handlers.has(SettingsEvents.SET)).to.be.true
      expect(transport._handlers.has(SettingsEvents.RESET)).to.be.true
    })
  })

  describe('LIST', () => {
    it('returns items merged with descriptor metadata from the registry', async () => {
      store.listResult = [
        {current: 25, default: 10, key: 'agentPool.maxSize', restartRequired: true},
        {current: 5, default: 5, key: 'agentPool.maxConcurrentTasksPerProject', restartRequired: true},
        {current: 1000, default: 1000, key: 'taskHistory.maxEntries', restartRequired: true},
      ]
      const result = await invokeList()

      expect(result.items.map((i) => i.key).sort()).to.deep.equal([
        'agentPool.maxConcurrentTasksPerProject',
        'agentPool.maxSize',
        'analytics.status',
        'llm.iterationBudgetMs',
        'llm.requestTimeoutMs',
        'taskHistory.maxEntries',
        'update.checkForUpdates',
      ])
      const maxSizeItem = result.items.find((i) => i.key === 'agentPool.maxSize')
      expect(maxSizeItem?.current).to.equal(25)
      expect(maxSizeItem?.default).to.equal(10)
      expect(maxSizeItem?.type).to.equal('integer')
      expect(maxSizeItem?.min).to.be.a('number')
      expect(maxSizeItem?.max).to.be.a('number')
      expect(maxSizeItem?.description).to.be.a('string').and.to.have.length.greaterThan(0)
      expect(maxSizeItem?.restartRequired).to.equal(true)
    })

    it('propagates category from descriptor onto every item (M7 T2)', async () => {
      store.listResult = [
        {current: 10, default: 10, key: 'agentPool.maxSize', restartRequired: true},
      ]
      const result = await invokeList()
      const byKey = new Map(result.items.map((i) => [i.key, i]))
      expect(byKey.get('agentPool.maxSize')?.category).to.equal('concurrency')
      expect(byKey.get('agentPool.maxConcurrentTasksPerProject')?.category).to.equal('concurrency')
      expect(byKey.get('llm.iterationBudgetMs')?.category).to.equal('llm')
      expect(byKey.get('llm.requestTimeoutMs')?.category).to.equal('llm')
      expect(byKey.get('taskHistory.maxEntries')?.category).to.equal('task-history')
    })

    it('propagates unit=ms on llm.*Ms keys and omits unit on count keys (M7 T2)', async () => {
      store.listResult = [
        {current: 10, default: 10, key: 'agentPool.maxSize', restartRequired: true},
      ]
      const result = await invokeList()
      const byKey = new Map(result.items.map((i) => [i.key, i]))
      expect(byKey.get('llm.iterationBudgetMs')?.unit).to.equal('ms')
      expect(byKey.get('llm.requestTimeoutMs')?.unit).to.equal('ms')
      // Count keys: unit is either omitted entirely or set to 'count' explicitly.
      const maxSizeUnit = byKey.get('agentPool.maxSize')?.unit
      expect(maxSizeUnit === undefined || maxSizeUnit === 'count').to.equal(true)
      const historyUnit = byKey.get('taskHistory.maxEntries')?.unit
      expect(historyUnit === undefined || historyUnit === 'count').to.equal(true)
    })

    it('omits scope from every item in v1 (reserved for future project-store ticket)', async () => {
      store.listResult = []
      const result = await invokeList()
      for (const item of result.items) {
        expect(item.scope).to.equal(undefined)
      }
    })
  })

  describe('GET', () => {
    it('returns the current and default for a known key', async () => {
      store.listResult = [{current: 25, default: 10, key: 'agentPool.maxSize', restartRequired: true}]
      const result = await invokeGet({key: 'agentPool.maxSize'})

      expect(result.ok).to.be.true
      if (result.ok) {
        expect(result.current).to.equal(25)
        expect(result.default).to.equal(10)
        expect(result.key).to.equal('agentPool.maxSize')
        expect(result.restartRequired).to.equal(true)
        expect(result.type).to.equal('integer')
      }
    })

    it('propagates category and unit onto the returned item (M7 T2)', async () => {
      store.listResult = [
        {current: 600_000, default: 600_000, key: 'llm.iterationBudgetMs', restartRequired: true},
      ]
      const result = await invokeGet({key: 'llm.iterationBudgetMs'})
      expect(result.ok).to.be.true
      if (result.ok) {
        expect(result.category).to.equal('llm')
        expect(result.unit).to.equal('ms')
        expect(result.scope).to.equal(undefined)
      }
    })

    it('returns a structured unknown_key error for an unknown key', async () => {
      const result = await invokeGet({key: 'not.a.real.key'})

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('unknown_key')
        expect(result.error.key).to.equal('not.a.real.key')
        expect(result.error.message).to.include('not.a.real.key')
      }
    })
  })

  describe('SET', () => {
    it('delegates to store.set and returns ok+restartRequired on success', async () => {
      const result = await invokeSet({key: 'agentPool.maxSize', value: 25})

      expect(result.ok).to.be.true
      if (result.ok) expect(result.restartRequired).to.equal(true)
      const setCalls = store.calls.filter((c) => c.method === 'set')
      expect(setCalls).to.have.lengthOf(1)
      expect(setCalls[0].args).to.deep.equal(['agentPool.maxSize', 25])
    })

    it('maps UnknownSettingKeyError to a structured unknown_key error', async () => {
      store.setBehavior = async (key) => {
        throw new UnknownSettingKeyError(key)
      }

      const result = await invokeSet({key: 'not.a.real.key', value: 1})

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('unknown_key')
        expect(result.error.key).to.equal('not.a.real.key')
      }
    })

    it('maps InvalidSettingValueError to a structured invalid_value error carrying key, value, and message', async () => {
      store.setBehavior = async (key, value) => {
        throw new InvalidSettingValueError(key, value, 'value 0 is outside allowed range [1, 100]')
      }

      const result = await invokeSet({key: 'agentPool.maxSize', value: 0})

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('invalid_value')
        expect(result.error.key).to.equal('agentPool.maxSize')
        expect(result.error.value).to.equal(0)
        expect(result.error.message).to.include('range')
      }
    })

    describe('type pre-validation (T3 invalid_value_type)', () => {
      it('rejects a boolean value sent to an integer key', async () => {
        const result = await invokeSet({key: 'agentPool.maxSize', value: true})

        expect(result.ok).to.be.false
        if (!result.ok) {
          expect(result.error.code).to.equal('invalid_value_type')
          expect(result.error.key).to.equal('agentPool.maxSize')
          expect(result.error.expected).to.equal('integer')
          expect(result.error.got).to.equal('boolean')
        }

        // Pre-validation must happen BEFORE the store is touched.
        expect(store.calls.filter((c) => c.method === 'set')).to.have.lengthOf(0)
      })

      it('rejects a numeric value sent to a boolean key', async () => {
        const result = await invokeSet({key: 'update.checkForUpdates', value: 5})

        expect(result.ok).to.be.false
        if (!result.ok) {
          expect(result.error.code).to.equal('invalid_value_type')
          expect(result.error.key).to.equal('update.checkForUpdates')
          expect(result.error.expected).to.equal('boolean')
          expect(result.error.got).to.equal('number')
        }

        expect(store.calls.filter((c) => c.method === 'set')).to.have.lengthOf(0)
      })

      it('accepts a boolean value sent to a boolean key and forwards to the store', async () => {
        const result = await invokeSet({key: 'update.checkForUpdates', value: false})

        expect(result.ok).to.be.true
        const setCalls = store.calls.filter((c) => c.method === 'set')
        expect(setCalls).to.have.lengthOf(1)
        expect(setCalls[0].args).to.deep.equal(['update.checkForUpdates', false])
      })

      it('falls through to unknown_key when the descriptor itself is missing (does not pre-validate type)', async () => {
        store.setBehavior = async (key) => {
          throw new UnknownSettingKeyError(key)
        }

        const result = await invokeSet({key: 'not.a.real.key', value: 1})

        expect(result.ok).to.be.false
        if (!result.ok) expect(result.error.code).to.equal('unknown_key')
      })

      it('still surfaces a range violation as invalid_value (not invalid_value_type)', async () => {
        store.setBehavior = async (key, value) => {
          throw new InvalidSettingValueError(key, value, 'value 0 is outside allowed range [1, 100]')
        }

        const result = await invokeSet({key: 'agentPool.maxSize', value: 0})

        expect(result.ok).to.be.false
        if (!result.ok) expect(result.error.code).to.equal('invalid_value')
      })
    })
  })

  describe('RESET', () => {
    it('delegates to store.reset and returns ok+restartRequired on success', async () => {
      const result = await invokeReset({key: 'agentPool.maxSize'})

      expect(result.ok).to.be.true
      if (result.ok) expect(result.restartRequired).to.equal(true)
      const resetCalls = store.calls.filter((c) => c.method === 'reset')
      expect(resetCalls).to.have.lengthOf(1)
      expect(resetCalls[0].args).to.deep.equal(['agentPool.maxSize'])
    })

    it('maps UnknownSettingKeyError to a structured unknown_key error', async () => {
      const result = await invokeReset({key: 'not.a.real.key'})

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('unknown_key')
        expect(result.error.key).to.equal('not.a.real.key')
      }
    })
  })

  async function invokeList(): Promise<SettingsListResponse> {
    const handler = transport._handlers.get(SettingsEvents.LIST)
    if (!handler) throw new Error('LIST handler not registered')
    return handler(undefined, 'test-client') as Promise<SettingsListResponse>
  }

  async function invokeGet(payload: SettingsGetRequest): Promise<SettingsGetResponse> {
    const handler = transport._handlers.get(SettingsEvents.GET)
    if (!handler) throw new Error('GET handler not registered')
    return handler(payload, 'test-client') as Promise<SettingsGetResponse>
  }

  async function invokeSet(payload: SettingsSetRequest): Promise<SettingsSetResponse> {
    const handler = transport._handlers.get(SettingsEvents.SET)
    if (!handler) throw new Error('SET handler not registered')
    return handler(payload, 'test-client') as Promise<SettingsSetResponse>
  }

  async function invokeReset(payload: SettingsResetRequest): Promise<SettingsResetResponse> {
    const handler = transport._handlers.get(SettingsEvents.RESET)
    if (!handler) throw new Error('RESET handler not registered')
    return handler(payload, 'test-client') as Promise<SettingsResetResponse>
  }

  describe('readonly-info variant (M16.1)', () => {
    const readonlyInfoRegistry: readonly SettingDescriptor[] = [
    {
      category: 'updates',
      description: 'live operational snapshot for tests',
      key: '_test.snapshot',
      restartRequired: false,
      type: 'readonly-info',
    },
  ]

  let store: StubSettingsStore
  let transport: ReturnType<typeof createMockTransportServer>

  function setupHandler(opts: {
    readonly providers?: ReadonlyMap<string, ReadonlyInfoProvider>
  } = {}): void {
    new SettingsHandler({
      infoProviders: opts.providers,
      registry: readonlyInfoRegistry,
      store,
      transport,
    }).setup()
  }

  async function invokeList(): Promise<SettingsListResponse> {
    const handler = transport._handlers.get(SettingsEvents.LIST)
    if (!handler) throw new Error('LIST handler not registered')
    return handler(undefined, 'test-client') as Promise<SettingsListResponse>
  }

  async function invokeGet(payload: SettingsGetRequest): Promise<SettingsGetResponse> {
    const handler = transport._handlers.get(SettingsEvents.GET)
    if (!handler) throw new Error('GET handler not registered')
    return handler(payload, 'test-client') as Promise<SettingsGetResponse>
  }

  async function invokeSet(payload: SettingsSetRequest): Promise<SettingsSetResponse> {
    const handler = transport._handlers.get(SettingsEvents.SET)
    if (!handler) throw new Error('SET handler not registered')
    return handler(payload, 'test-client') as Promise<SettingsSetResponse>
  }

  async function invokeReset(payload: SettingsResetRequest): Promise<SettingsResetResponse> {
    const handler = transport._handlers.get(SettingsEvents.RESET)
    if (!handler) throw new Error('RESET handler not registered')
    return handler(payload, 'test-client') as Promise<SettingsResetResponse>
  }

  beforeEach(() => {
    store = new StubSettingsStore()
    store.listResult = [{current: undefined, key: '_test.snapshot', restartRequired: false}]
    transport = createMockTransportServer()
  })

  describe('SET', () => {
    it('returns code=read_only without calling store.set', async () => {
      setupHandler()
      const result = await invokeSet({key: '_test.snapshot', value: 1})

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('read_only')
        expect(result.error.key).to.equal('_test.snapshot')
        expect(result.error.message.toLowerCase()).to.include('read')
      }

      const setCalls = store.calls.filter((c) => c.method === 'set')
      expect(setCalls).to.have.lengthOf(0)
    })

    it('maps a ReadonlySettingKeyError thrown from the store to a read_only DTO error', async () => {
      store.setBehavior = async (key) => {
        throw new ReadonlySettingKeyError(key)
      }

      setupHandler()
      // Use a writable key that the registry knows about so we bypass the
      // top-level guard. We simulate the store layer throwing for a key
      // that escalated past pre-validation.
      const writableRegistry: readonly SettingDescriptor[] = [
        {
          category: 'concurrency',
          default: 10,
          description: 'test',
          key: '_test.writable',
          max: 100,
          min: 1,
          restartRequired: true,
          type: 'integer',
        },
      ]
      const localTransport = createMockTransportServer()
      const localStore = new StubSettingsStore()
      localStore.setBehavior = async (key) => {
        throw new ReadonlySettingKeyError(key)
      }

      new SettingsHandler({registry: writableRegistry, store: localStore, transport: localTransport}).setup()

      const handler = localTransport._handlers.get(SettingsEvents.SET)
      if (!handler) throw new Error('SET handler not registered')
      const result = (await handler({key: '_test.writable', value: 1}, 'test-client')) as SettingsSetResponse
      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('read_only')
        expect(result.error.key).to.equal('_test.writable')
      }
    })
  })

  describe('RESET', () => {
    it('returns code=read_only without calling store.reset', async () => {
      setupHandler()
      const result = await invokeReset({key: '_test.snapshot'})

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('read_only')
        expect(result.error.key).to.equal('_test.snapshot')
      }

      const resetCalls = store.calls.filter((c) => c.method === 'reset')
      expect(resetCalls).to.have.lengthOf(0)
    })
  })

  describe('LIST', () => {
    it('resolves current via the registered info provider when present', async () => {
      const providers = new Map<string, ReadonlyInfoProvider>([
        ['_test.snapshot', () => ({endpoint: 'test', queueDepth: 3})],
      ])
      setupHandler({providers})

      const result = await invokeList()
      const snapshot = result.items.find((i) => i.key === '_test.snapshot')
      expect(snapshot, 'readonly-info row must be present').to.exist
      expect(snapshot?.type).to.equal('readonly-info')
      expect(snapshot?.current).to.deep.equal({endpoint: 'test', queueDepth: 3})
      expect(snapshot?.default).to.equal(undefined)
      expect(snapshot?.min).to.equal(undefined)
      expect(snapshot?.max).to.equal(undefined)
      expect(snapshot?.unit).to.equal(undefined)
    })

    it('returns current=undefined when no info provider is registered', async () => {
      setupHandler()
      const result = await invokeList()
      const snapshot = result.items.find((i) => i.key === '_test.snapshot')
      expect(snapshot?.current).to.equal(undefined)
    })

    it('awaits an async info provider before responding', async () => {
      const providers = new Map<string, ReadonlyInfoProvider>([
        ['_test.snapshot', async () => ({lastFlush: 'now'})],
      ])
      setupHandler({providers})
      const result = await invokeList()
      const snapshot = result.items.find((i) => i.key === '_test.snapshot')
      expect(snapshot?.current).to.deep.equal({lastFlush: 'now'})
    })

    it('isolates a throwing provider so the row surfaces with current=undefined instead of crashing the whole list', async () => {
      const providers = new Map<string, ReadonlyInfoProvider>([
        ['_test.snapshot', () => {
          throw new Error('provider boom')
        }],
      ])
      setupHandler({providers})

      const result = await invokeList()
      const snapshot = result.items.find((i) => i.key === '_test.snapshot')
      expect(snapshot, 'readonly-info row must still be present').to.exist
      expect(snapshot?.current).to.equal(undefined)
    })

    it('isolates a single throwing provider while resolving other readonly-info rows in the same response', async () => {
      const multiRegistry: readonly SettingDescriptor[] = [
        {
          category: 'updates',
          description: 'broken snapshot',
          key: '_test.broken',
          restartRequired: false,
          type: 'readonly-info',
        },
        {
          category: 'updates',
          description: 'healthy snapshot',
          key: '_test.healthy',
          restartRequired: false,
          type: 'readonly-info',
        },
      ]

      const providers = new Map<string, ReadonlyInfoProvider>([
        ['_test.broken', () => {
          throw new Error('provider boom')
        }],
        ['_test.healthy', () => ({queueDepth: 5})],
      ])

      const localStore = new StubSettingsStore()
      localStore.listResult = []
      const localTransport = createMockTransportServer()
      new SettingsHandler({
        infoProviders: providers,
        registry: multiRegistry,
        store: localStore,
        transport: localTransport,
      }).setup()

      const handler = localTransport._handlers.get(SettingsEvents.LIST)
      if (!handler) throw new Error('LIST handler not registered')
      const result = (await handler(undefined, 'test-client')) as SettingsListResponse

      const broken = result.items.find((i) => i.key === '_test.broken')
      const healthy = result.items.find((i) => i.key === '_test.healthy')
      expect(broken?.current).to.equal(undefined)
      expect(healthy?.current).to.deep.equal({queueDepth: 5})
    })
  })

  describe('GET', () => {
    it('resolves current via the registered info provider when present', async () => {
      const providers = new Map<string, ReadonlyInfoProvider>([
        ['_test.snapshot', () => ({queueDepth: 7})],
      ])
      setupHandler({providers})

      const result = await invokeGet({key: '_test.snapshot'})
      expect(result.ok).to.be.true
      if (result.ok) {
        expect(result.type).to.equal('readonly-info')
        expect(result.current).to.deep.equal({queueDepth: 7})
        expect(result.default).to.equal(undefined)
      }
    })

    it('returns current=undefined when no info provider is registered', async () => {
      setupHandler()
      const result = await invokeGet({key: '_test.snapshot'})
      expect(result.ok).to.be.true
      if (result.ok) {
        expect(result.current).to.equal(undefined)
      }
    })

    it('returns invalid_value when the info provider throws (does not crash)', async () => {
      const providers = new Map<string, ReadonlyInfoProvider>([
        ['_test.snapshot', () => {
          throw new Error('provider boom')
        }],
      ])
      setupHandler({providers})

      const result = await invokeGet({key: '_test.snapshot'})
      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('invalid_value')
        expect(result.error.key).to.equal('_test.snapshot')
        expect(result.error.message.toLowerCase()).to.include('boom')
      }
    })
  })
  })

  describe('analytics.status routing (M16.3 — production registry)', () => {
    it('GET resolves analytics.status via the registered provider against the production registry', async () => {
      const localStore = new StubSettingsStore()
      // Real FileSettingsStore returns `{current: undefined, key, restartRequired: false}`
      // for readonly-info keys. Stub mirrors that so the handler's GET path
      // reaches the provider resolution step.
      localStore.listResult = [{current: undefined, key: 'analytics.status', restartRequired: false}]
      const localTransport = createMockTransportServer()
      const snapshot = {
        backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'healthy' as const},
        droppedCount: 0,
        enabled: true,
        endpoint: 'https://telemetry-dev.byterover.dev',
        lastFlushAt: 1_700_000_000_000,
        queueDepth: 4,
      }
      const providers = new Map<string, ReadonlyInfoProvider>([
        ['analytics.status', () => snapshot],
      ])
      new SettingsHandler({infoProviders: providers, store: localStore, transport: localTransport}).setup()

      const handler = localTransport._handlers.get(SettingsEvents.GET)
      if (!handler) throw new Error('GET handler not registered')
      const result = (await handler({key: 'analytics.status'}, 'test-client')) as SettingsGetResponse

      expect(result.ok).to.be.true
      if (result.ok) {
        expect(result.type).to.equal('readonly-info')
        expect(result.current).to.deep.equal(snapshot)
        expect(result.category).to.equal('analytics')
        expect(result.default).to.equal(undefined)
      }
    })

    it('SET on analytics.status returns code=read_only against the production registry', async () => {
      const localStore = new StubSettingsStore()
      const localTransport = createMockTransportServer()
      new SettingsHandler({store: localStore, transport: localTransport}).setup()

      const handler = localTransport._handlers.get(SettingsEvents.SET)
      if (!handler) throw new Error('SET handler not registered')
      const result = (await handler({key: 'analytics.status', value: 1}, 'test-client')) as SettingsSetResponse

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('read_only')
        expect(result.error.key).to.equal('analytics.status')
      }
    })

    it('RESET on analytics.status returns code=read_only against the production registry', async () => {
      const localStore = new StubSettingsStore()
      const localTransport = createMockTransportServer()
      new SettingsHandler({store: localStore, transport: localTransport}).setup()

      const handler = localTransport._handlers.get(SettingsEvents.RESET)
      if (!handler) throw new Error('RESET handler not registered')
      const result = (await handler({key: 'analytics.status'}, 'test-client')) as SettingsResetResponse

      expect(result.ok).to.be.false
      if (!result.ok) {
        expect(result.error.code).to.equal('read_only')
        expect(result.error.key).to.equal('analytics.status')
      }
    })

    it('LIST includes analytics.status as a readonly-info row with current resolved by the provider', async () => {
      const localStore = new StubSettingsStore()
      const localTransport = createMockTransportServer()
      const snapshot = {
        backoff: {consecutiveFailures: 0, nextDelayMs: 30_000, state: 'healthy' as const},
        droppedCount: 0,
        enabled: false,
        endpoint: 'https://telemetry-dev.byterover.dev',
        queueDepth: 0,
      }
      const providers = new Map<string, ReadonlyInfoProvider>([
        ['analytics.status', () => snapshot],
      ])
      new SettingsHandler({infoProviders: providers, store: localStore, transport: localTransport}).setup()

      const handler = localTransport._handlers.get(SettingsEvents.LIST)
      if (!handler) throw new Error('LIST handler not registered')
      const result = (await handler(undefined, 'test-client')) as SettingsListResponse

      const row = result.items.find((i) => i.key === 'analytics.status')
      expect(row, 'analytics.status row present in LIST').to.exist
      expect(row?.type).to.equal('readonly-info')
      expect(row?.category).to.equal('analytics')
      expect(row?.current).to.deep.equal(snapshot)
      expect(row?.default).to.equal(undefined)
    })
  })
})
