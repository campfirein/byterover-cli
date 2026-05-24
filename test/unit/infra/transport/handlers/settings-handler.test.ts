import {expect} from 'chai'

import type {SettingItem} from '../../../../../src/server/core/domain/entities/settings.js'
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
  UnknownSettingKeyError,
} from '../../../../../src/server/infra/storage/settings-validator.js'
import {SettingsHandler} from '../../../../../src/server/infra/transport/handlers/settings-handler.js'
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
        'llm.iterationBudgetMs',
        'llm.requestTimeoutMs',
        'taskHistory.maxEntries',
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
})
