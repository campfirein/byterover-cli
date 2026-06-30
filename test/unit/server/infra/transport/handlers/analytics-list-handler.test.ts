/* eslint-disable camelcase */
import {expect} from 'chai'
import {spy} from 'sinon'

import type {
  IJsonlAnalyticsStore,
  JsonlAnalyticsStoreListOptions,
  JsonlAnalyticsStoreListResult,
} from '../../../../../../src/server/core/interfaces/analytics/i-jsonl-analytics-store.js'
import type {StoredAnalyticsRecord} from '../../../../../../src/shared/analytics/stored-record.js'

import {AnalyticsListHandler} from '../../../../../../src/server/infra/transport/handlers/analytics-list-handler.js'
import {AnalyticsEvents} from '../../../../../../src/shared/transport/events/analytics-events.js'
import {createMockTransportServer} from '../../../../../helpers/mock-factories.js'

type AnalyticsListRequestHandler = (
  data: unknown,
  clientId: string,
) => Promise<{rows: StoredAnalyticsRecord[]; total: number}>

const validIdentity = {device_id: '550e8400-e29b-41d4-a716-446655440000'}

function makeRecord(overrides: Partial<StoredAnalyticsRecord> = {}): StoredAnalyticsRecord {
  return {
    attempts: 0,
    id: `rec-${Math.random().toString(16).slice(2, 8)}`,
    identity: validIdentity,
    name: 'cli_invocation',
    properties: {},
    status: 'pending',
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

type FakeJsonlStore = IJsonlAnalyticsStore & {
  listSpy: ReturnType<typeof spy>
}

function makeFakeJsonlStore(rows: StoredAnalyticsRecord[]): FakeJsonlStore {
  const listImpl = async (opts: JsonlAnalyticsStoreListOptions): Promise<JsonlAnalyticsStoreListResult> => {
    const filtered = rows.filter((row) => {
      if (opts.eventName !== undefined && row.name !== opts.eventName) return false
      if (opts.status !== undefined && row.status !== opts.status) return false
      return true
    })
    return {rows: filtered.slice(opts.offset, opts.offset + opts.limit), total: filtered.length}
  }

  const listSpy = spy(listImpl)
  return {
    async append() {},
    async clear() {},
    droppedFullCount: () => 0,
    droppedSentCount: () => 0,
    list: listSpy,
    listSpy,
    loadPending: async () => rows.filter((r) => r.status === 'pending'),
    async updateStatus() {},
  }
}

describe('AnalyticsListHandler (M11.2)', () => {
  it('should register a handler for analytics:list on setup()', () => {
    const transport = createMockTransportServer()
    new AnalyticsListHandler({jsonlStore: makeFakeJsonlStore([]), transport}).setup()

    expect(transport._handlers.has(AnalyticsEvents.LIST)).to.equal(true)
  })

  it('should return {rows: [], total: 0} for a malformed payload (no throw)', async () => {
    const transport = createMockTransportServer()
    const jsonlStore = makeFakeJsonlStore([makeRecord()])
    new AnalyticsListHandler({jsonlStore, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.LIST) as AnalyticsListRequestHandler

    for (const malformed of [null, undefined, {}, {limit: 'not-a-number'}, {limit: 10}, {offset: 0}]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await handler(malformed, 'client-1')
      expect(result).to.deep.equal({rows: [], total: 0})
    }

    expect(jsonlStore.listSpy.called, 'malformed payload must NOT reach the store').to.equal(false)
  })

  it('should forward offset/limit to jsonlStore.list and return its result', async () => {
    const records = [
      makeRecord({id: 'r1', name: 'a'}),
      makeRecord({id: 'r2', name: 'b'}),
      makeRecord({id: 'r3', name: 'c'}),
    ]
    const transport = createMockTransportServer()
    const jsonlStore = makeFakeJsonlStore(records)
    new AnalyticsListHandler({jsonlStore, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.LIST) as AnalyticsListRequestHandler

    const result = await handler({limit: 2, offset: 1}, 'client-1')

    expect(jsonlStore.listSpy.calledOnce).to.equal(true)
    expect(jsonlStore.listSpy.firstCall.args[0]).to.deep.equal({limit: 2, offset: 1})
    expect(result.total).to.equal(3)
    expect(result.rows.map((r) => r.id)).to.deep.equal(['r2', 'r3'])
  })

  it('should forward eventName + status filter combos correctly', async () => {
    const transport = createMockTransportServer()
    const jsonlStore = makeFakeJsonlStore([])
    new AnalyticsListHandler({jsonlStore, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.LIST) as AnalyticsListRequestHandler

    await handler({eventName: 'cli_invocation', limit: 10, offset: 0, status: 'pending'}, 'client-1')

    expect(jsonlStore.listSpy.firstCall.args[0]).to.deep.equal({
      eventName: 'cli_invocation',
      limit: 10,
      offset: 0,
      status: 'pending',
    })
  })

  it('should redact forbidden keys from row.properties before returning', async () => {
    const records = [
      makeRecord({
        id: 'r1',
        properties: {command_id: 'status', password: 'leak', token: 'jwt-xxx'},
      }),
    ]
    const transport = createMockTransportServer()
    const jsonlStore = makeFakeJsonlStore(records)
    new AnalyticsListHandler({jsonlStore, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.LIST) as AnalyticsListRequestHandler
    const result = await handler({limit: 10, offset: 0}, 'client-1')

    expect(result.rows[0].properties).to.deep.equal({command_id: 'status'})
    // Source rows must NOT have been mutated.
    expect(records[0].properties).to.have.property('password', 'leak')
  })

  it('should NOT redact identity (locked decision: identity block stays intact)', async () => {
    const records = [
      makeRecord({
        id: 'r1',
        identity: {device_id: validIdentity.device_id, email: 'alice@example.com', name: 'Alice', user_id: 'u-1'},
        properties: {command_id: 'status'},
      }),
    ]
    const transport = createMockTransportServer()
    const jsonlStore = makeFakeJsonlStore(records)
    new AnalyticsListHandler({jsonlStore, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.LIST) as AnalyticsListRequestHandler
    const result = await handler({limit: 10, offset: 0}, 'client-1')

    expect(result.rows[0].identity).to.deep.equal({
      device_id: validIdentity.device_id,
      email: 'alice@example.com',
      name: 'Alice',
      user_id: 'u-1',
    })
  })

  it('should return {rows: [], total: 0} when the store throws (no daemon crash)', async () => {
    const transport = createMockTransportServer()
    const throwingStore: IJsonlAnalyticsStore = {
      async append() {},
      async clear() {},
      droppedFullCount: () => 0,
      droppedSentCount: () => 0,
      async list() {
        throw new Error('store boom')
      },
      loadPending: async () => [],
      async updateStatus() {},
    }
    new AnalyticsListHandler({jsonlStore: throwingStore, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.LIST) as AnalyticsListRequestHandler

    let result: undefined | {rows: StoredAnalyticsRecord[]; total: number}
    let threw = false
    try {
      result = await handler({limit: 10, offset: 0}, 'client-1')
    } catch {
      threw = true
    }

    expect(threw, 'handler MUST NOT propagate store throws').to.equal(false)
    expect(result).to.deep.equal({rows: [], total: 0})
  })
})
