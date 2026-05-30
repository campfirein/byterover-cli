/* eslint-disable camelcase, max-lines -- this file accumulates AnalyticsClient cases across M2-M4.6; splitting would scatter the contract surface. */
import {expect} from 'chai'
import {spy, stub} from 'sinon'

import type {Identity} from '../../../../../src/server/core/domain/analytics/identity.js'
import type {IAnalyticsSender, SendResult} from '../../../../../src/server/core/interfaces/analytics/i-analytics-sender.js'
import type {IIdentityResolver} from '../../../../../src/server/core/interfaces/analytics/i-identity-resolver.js'
import type {IJsonlAnalyticsStore, JsonlAnalyticsStoreUpdateStatus} from '../../../../../src/server/core/interfaces/analytics/i-jsonl-analytics-store.js'
import type {ISuperPropertiesResolver, SuperProperties} from '../../../../../src/server/core/interfaces/analytics/i-super-properties-resolver.js'
import type {CurateOperationAppliedProps} from '../../../../../src/shared/analytics/events/curate-operation-applied.js'
import type {StoredAnalyticsRecord} from '../../../../../src/shared/analytics/stored-record.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {AnalyticsClient} from '../../../../../src/server/infra/analytics/analytics-client.js'
import {BoundedQueue} from '../../../../../src/server/infra/analytics/bounded-queue.js'
import {NoOpAnalyticsSender} from '../../../../../src/server/infra/analytics/no-op-analytics-sender.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'

/**
 * Valid CurateOperationAppliedProps payload used for tests that need a real
 * typed event with non-trivial properties (e.g. property merge / precedence).
 * DAEMON_START is used elsewhere where the call shape only needs to fire.
 */
function makeCurateOpProps(overrides: Partial<CurateOperationAppliedProps> = {}): CurateOperationAppliedProps {
  return {
    keywords: [],
    knowledge_path: 'cli_architecture/test.md',
    needs_review: false,
    operation_type: 'ADD',
    relative_path: 'tmp/file.md',
    tags: [],
    task_id: 'task-1',
    ...overrides,
  }
}

type FakeJsonlStore = IJsonlAnalyticsStore & {
  appendSpy: ReturnType<typeof spy>
  readonly records: StoredAnalyticsRecord[]
  readonly updateStatusCalls: Array<{ids: readonly string[]; status: JsonlAnalyticsStoreUpdateStatus}>
}

function makeFakeJsonlStore(opts: {appendError?: Error} = {}): FakeJsonlStore {
  const records: StoredAnalyticsRecord[] = []
  const updateStatusCalls: Array<{ids: readonly string[]; status: JsonlAnalyticsStoreUpdateStatus}> = []
  const appendImpl = async (record: StoredAnalyticsRecord): Promise<void> => {
    if (opts.appendError) throw opts.appendError
    records.push(record)
  }

  const appendSpy = spy(appendImpl)
  return {
    append: appendSpy,
    appendSpy,
    async clear(): Promise<void> {
      records.length = 0
    },
    droppedFullCount: () => 0,
    droppedSentCount: () => 0,
    list: async () => ({rows: [...records], total: records.length}),
    loadPending: async () => records.filter((r) => r.status === 'pending'),
    records,
    // Simplified mirror of M9.2's updateStatus for unit tests: 'sent' is a terminal flip;
    // 'failed' flips status directly. The real retry-cap (increment attempts, stay
    // 'pending' until cap) lives in M9.2 and is verified end-to-end in M10.3.
    async updateStatus(ids: readonly string[], status: JsonlAnalyticsStoreUpdateStatus): Promise<void> {
      updateStatusCalls.push({ids: [...ids], status})
      if (ids.length === 0) return
      const idSet = new Set(ids)
      for (let i = 0; i < records.length; i++) {
        if (idSet.has(records[i].id)) records[i] = {...records[i], status}
      }
    },
    updateStatusCalls,
  }
}

type FakeSender = IAnalyticsSender & {
  readonly calls: Array<readonly StoredAnalyticsRecord[]>
}

type FakeSenderOpts =
  | {error: Error; kind: 'throw';}
  | {failedIds: readonly string[]; kind: 'mixed'; succeededIds: readonly string[]}
  | {kind: 'all-failed'}
  | {kind: 'all-succeeded'}

function makeFakeSender(opts?: FakeSenderOpts): FakeSender {
  const resolved: FakeSenderOpts = opts ?? {kind: 'all-succeeded'}
  const calls: Array<readonly StoredAnalyticsRecord[]> = []
  return {
    calls,
    async send(records: readonly StoredAnalyticsRecord[]): Promise<SendResult> {
      calls.push([...records])
      switch (resolved.kind) {
        case 'all-failed': {
          return {failed: records.map((r) => r.id), succeeded: []}
        }

        case 'all-succeeded': {
          return {failed: [], succeeded: records.map((r) => r.id)}
        }

        case 'mixed': {
          return {failed: [...resolved.failedIds], succeeded: [...resolved.succeededIds]}
        }

        case 'throw': {
          throw resolved.error
        }
      }
    },
  }
}

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

function makeAnonIdentity(): Identity {
  return {device_id: validDeviceId}
}

function makeRegisteredIdentity(): Identity {
  return {
    device_id: validDeviceId,
    email: 'alice@example.com',
    name: 'Alice',
    user_id: 'user-123',
  }
}

function makeSuperProps(): SuperProperties {
  return {
    cli_version: '3.10.3',
    device_id: validDeviceId,
    environment: 'production',
    node_version: 'v24.13.1',
    os: 'darwin',
  }
}

function makeStubIdentityResolver(identity: Identity): IIdentityResolver {
  return {resolve: stub().resolves(identity)}
}

function makeStubSuperPropsResolver(props: SuperProperties): ISuperPropertiesResolver {
  return {resolve: stub().resolves(props)}
}

async function flushMicrotasks(): Promise<void> {
  // Drain the microtask queue so fire-and-forget async work completes
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
}

async function seedPending(client: AnalyticsClient, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    client.track(AnalyticsEventNames.DAEMON_START)
  }

  await flushMicrotasks()
}

// M4.5: hand-rolled sender that returns a tagged failure on demand.
// Hoisted to module scope to satisfy unicorn/consistent-function-scoping.
// `reason` is optional so the success-path callers can omit it
// (the autofix would otherwise rewrite `(undefined)` to `()`).
function makeSenderWithReason(
  reason?: 'http_4xx' | 'http_5xx' | 'network' | 'rate_limited' | 'timeout',
  retryAfterMs?: number,
): IAnalyticsSender {
  return {
    async send(records) {
      if (reason === undefined) {
        return {failed: [], succeeded: records.map((r) => r.id)}
      }

      return {
        failed: records.map((r) => r.id),
        reason,
        ...(retryAfterMs === undefined ? {} : {retryAfterMs}),
        succeeded: [],
      }
    },
  }
}

describe('AnalyticsClient', () => {
  describe('disabled state (M4.4 semantic: track local-only)', () => {
    // Pre-M4.4 this test asserted "no-op when disabled" (no JSONL append,
    // no queue push, no resolver calls). Post-M4.4 the semantic is
    // "local tracking always; remote send only when enabled" — disable
    // gates the FLUSH layer, not the TRACK layer. `brv settings set analytics.share false`
    // means "stop shipping to remote", not "stop collecting locally".
    it('still tracks (JSONL + queue + resolvers) when isEnabled returns false; flush is the gate', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      const identityResolver = makeStubIdentityResolver(makeAnonIdentity())
      const superPropsResolver = makeStubSuperPropsResolver(makeSuperProps())
      const sender = makeFakeSender()

      const client = new AnalyticsClient({
        identityResolver,
        isEnabled: () => false,
        jsonlStore,
        queue,
        sender,
        superPropsResolver,
      })

      for (let i = 0; i < 5; i++) {
        client.track(AnalyticsEventNames.DAEMON_START)
      }

      await flushMicrotasks()

      expect(queue.size(), 'queue STILL grows when disabled (local tracking unconditional)').to.equal(5)
      expect(jsonlStore.records.length, 'JSONL STILL appended when disabled').to.equal(5)
      expect((identityResolver.resolve as ReturnType<typeof stub>).called, 'resolvers still run').to.be.true

      // Flush is the gate now: it must NOT call sender when disabled.
      await client.flush()
      expect(sender.calls.length, 'flush must NOT call sender when disabled').to.equal(0)
    })
  })

  describe('enabled state (ticket scenario 2)', () => {
    it('should resolve identity + super-props and push to queue with timestamp', async () => {
      const queue = new BoundedQueue()
      const identity = makeRegisteredIdentity()
      const superProps = makeSuperProps()
      const jsonlStore = makeFakeJsonlStore()

      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(identity),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(superProps),
      })

      const before = Date.now()
      const opProps = makeCurateOpProps({relative_path: 'tmp/merge-fixture.md'})
      client.track(AnalyticsEventNames.CURATE_OPERATION_APPLIED, opProps)
      await flushMicrotasks()
      const after = Date.now()

      const batch = await client.flush()

      expect(batch.events).to.have.lengthOf(1)
      const [event] = batch.events
      expect(event.name).to.equal(AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      expect(event.identity).to.deep.equal(identity)
      // Local numeric `timestamp` is captured at call-site at millisecond precision.
      expect(jsonlStore.records[0].timestamp).to.be.at.least(before)
      expect(jsonlStore.records[0].timestamp).to.be.at.most(after)
      // Wire `created_at` is the ISO 8601 string derived from the same `new Date()`
      // read. `formatISO` drops millis, so it describes the same instant floored
      // to the second.
      expect(event.created_at).to.be.a('string')
      expect(Date.parse(event.created_at)).to.equal(
        Math.floor(jsonlStore.records[0].timestamp / 1000) * 1000,
      )

      // user properties merged through
      expect(event.properties.relative_path).to.equal('tmp/merge-fixture.md')
      expect(event.properties.operation_type).to.equal('ADD')
      // all 5 super properties stamped
      expect(event.properties.cli_version).to.equal('3.10.3')
      expect(event.properties.device_id).to.equal(validDeviceId)
      expect(event.properties.environment).to.equal('production')
      expect(event.properties.node_version).to.equal('v24.13.1')
      expect(event.properties.os).to.equal('darwin')
    })
  })

  describe('auth transition mid-batch (ticket scenario 3)', () => {
    it('should reflect per-track identity resolution when auth state flips', async () => {
      const queue = new BoundedQueue()
      let currentIdentity: Identity = makeAnonIdentity()
      const identityResolver: IIdentityResolver = {
        resolve: async () => currentIdentity,
      }
      const superPropsResolver = makeStubSuperPropsResolver(makeSuperProps())

      const client = new AnalyticsClient({
        identityResolver,
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue,
        sender: makeFakeSender(),
        superPropsResolver,
      })

      client.track(AnalyticsEventNames.DAEMON_START)
      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      currentIdentity = makeRegisteredIdentity()
      client.track(AnalyticsEventNames.DAEMON_START)
      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      const batch = await client.flush()
      expect(batch.events).to.have.lengthOf(4)
      expect(batch.events[0].identity).to.deep.equal(makeAnonIdentity())
      expect(batch.events[1].identity).to.deep.equal(makeAnonIdentity())
      expect(batch.events[2].identity).to.deep.equal(makeRegisteredIdentity())
      expect(batch.events[3].identity).to.deep.equal(makeRegisteredIdentity())
    })
  })

  describe('M10.2 burst-overflow regression: flush reads from JSONL, not the bounded queue', () => {
    it('should ship every tracked event even when the in-memory queue dropped half during a burst', async () => {
      // M10.2's central architectural call: flush() reads from JSONL via loadPending(),
      // NOT from the in-memory queue. Without this, events tracked beyond queue.maxSize
      // would be silently dropped from the active flush path until daemon restart.
      const queue = new BoundedQueue(5)
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      for (let i = 0; i < 10; i++) {
        client.track(AnalyticsEventNames.DAEMON_START)
      }

      await flushMicrotasks()

      const batch = await client.flush()
      // All 10 events durably stored and flushed — JSONL is the source of truth.
      expect(batch.events).to.have.lengthOf(10)
      expect(jsonlStore.records).to.have.lengthOf(10)
      // The queue still honors its cap (the regression here is independent of queue eviction).
      expect(queue.droppedCount()).to.equal(5)
    })
  })

  describe('flush returns valid AnalyticsBatch (ticket scenario 5)', () => {
    it('should return a batch that round-trips through fromJson', async () => {
      const queue = new BoundedQueue()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      const batch = await client.flush()
      const restored = AnalyticsBatch.fromJson(batch.toJson())

      expect(restored).to.not.be.undefined
      expect(restored?.events).to.have.lengthOf(1)
      expect(restored?.events[0].name).to.equal(AnalyticsEventNames.DAEMON_START)
    })

    it('should return an empty batch when the queue has been fully drained', async () => {
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      const first = await client.flush()
      expect(first.events).to.deep.equal([])
    })
  })

  describe('error containment (analytics must not crash consumers)', () => {
    it('should silently drop the event when identity resolution rejects', async () => {
      const queue = new BoundedQueue()
      const identityResolver: IIdentityResolver = {
        resolve: () => Promise.reject(new Error('identity boom')),
      }

      const client = new AnalyticsClient({
        identityResolver,
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // Must not throw to the caller
      expect(() => client.track(AnalyticsEventNames.DAEMON_START)).to.not.throw()

      await flushMicrotasks()

      expect(queue.size()).to.equal(0)
    })

    it('should silently drop the event when super-properties resolution rejects', async () => {
      const queue = new BoundedQueue()
      const superPropsResolver: ISuperPropertiesResolver = {
        resolve: () => Promise.reject(new Error('super-props boom')),
      }

      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue,
        sender: makeFakeSender(),
        superPropsResolver,
      })

      expect(() => client.track(AnalyticsEventNames.DAEMON_START)).to.not.throw()

      await flushMicrotasks()

      expect(queue.size()).to.equal(0)
    })
  })

  describe('timestamp captured at call site, not resolver settle time', () => {
    it('should stamp timestamp when track() is called even if resolvers settle later', async () => {
      const queue = new BoundedQueue()
      let resolveIdentity!: (id: Identity) => void
      const slowIdentityResolver: IIdentityResolver = {
        resolve: () =>
          new Promise<Identity>((resolve) => {
            resolveIdentity = resolve
          }),
      }

      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: slowIdentityResolver,
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      const before = Date.now()
      client.track(AnalyticsEventNames.DAEMON_START)
      const after = Date.now()

      // Hold the resolver pending across a real timer gap so settle-time and
      // call-time diverge meaningfully — without this the bug is too subtle to detect.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })

      const settleStart = Date.now()
      resolveIdentity(makeAnonIdentity())
      await flushMicrotasks()

      const batch = await client.flush()
      expect(batch.events).to.have.lengthOf(1)
      // Captured-at-call: local numeric `timestamp` (millisecond precision)
      // falls within the call-site window…
      const stored = jsonlStore.records[0]
      expect(stored.timestamp).to.be.at.least(before)
      expect(stored.timestamp).to.be.at.most(after)
      // …and is BEFORE the resolver settled (proving capture-at-call, not capture-at-settle).
      expect(stored.timestamp).to.be.lessThan(settleStart)
      // The wire-bound `created_at` is derived from the same `new Date()` read,
      // floored to the second by formatISO.
      expect(Date.parse(batch.events[0].created_at)).to.equal(
        Math.floor(stored.timestamp / 1000) * 1000,
      )
    })
  })

  describe('M9.3 JSONL-first persistence (dual write)', () => {
    it('should append to JSONL before pushing to queue (happy path)', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      client.track(AnalyticsEventNames.CURATE_OPERATION_APPLIED, makeCurateOpProps())
      await flushMicrotasks()

      // JSONL has the row
      expect(jsonlStore.records).to.have.lengthOf(1)
      const stored = jsonlStore.records[0]
      expect(stored.name).to.equal(AnalyticsEventNames.CURATE_OPERATION_APPLIED)
      expect(stored.status).to.equal('pending')
      expect(stored.attempts).to.equal(0)
      expect(stored.id).to.be.a('string').and.have.length.greaterThan(0)
      // Queue mirror has the same record (id propagates)
      expect(queue.size()).to.equal(1)
      const [drained] = queue.drain()
      expect(drained.id).to.equal(stored.id)
    })

    it('should generate distinct uuid id per track call', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      for (let i = 0; i < 5; i++) {
        client.track(AnalyticsEventNames.DAEMON_START)
      }

      await flushMicrotasks()

      const ids = jsonlStore.records.map((r) => r.id)
      expect(new Set(ids).size).to.equal(5) // all distinct
      expect(jsonlStore.records).to.have.lengthOf(5)
    })

    it('should NOT push to queue when JSONL append fails', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore({appendError: new Error('disk full')})
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      expect(() => client.track(AnalyticsEventNames.DAEMON_START)).to.not.throw()
      await flushMicrotasks()

      // JSONL append rejected (called once, but no record persisted)
      expect(jsonlStore.appendSpy.calledOnce).to.equal(true)
      expect(jsonlStore.records).to.have.lengthOf(0)
      // Queue must NOT receive the event when JSONL persist failed
      expect(queue.size()).to.equal(0)
    })

    it('should NOT push to queue and NOT crash when JSONL fails on every track', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore({appendError: new Error('persistent disk error')})
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      for (let i = 0; i < 100; i++) {
        expect(() => client.track(AnalyticsEventNames.DAEMON_START)).to.not.throw()
      }

      await flushMicrotasks()

      expect(queue.size()).to.equal(0)
    })

    it('should track queue.size() growth equal to JSONL row count under non-burst load', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      const N = 20
      for (let i = 0; i < N; i++) {
        client.track(AnalyticsEventNames.DAEMON_START)
      }

      await flushMicrotasks()

      expect(queue.size()).to.equal(N)
      expect(jsonlStore.records).to.have.lengthOf(N)
    })

    it('STILL calls jsonlStore.append when analytics disabled (M4.4: local tracking unconditional)', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => false,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      expect(jsonlStore.appendSpy.calledOnce, 'append fires regardless of enable state').to.be.true
      expect(jsonlStore.records).to.have.lengthOf(1)
      expect(queue.size()).to.equal(1)
    })
  })

  describe('M4.3 onAfterTrack hook (threshold notification)', () => {
    it('fires onAfterTrack after a successful JSONL+queue persist', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const onAfterTrack = spy()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        onAfterTrack: () => onAfterTrack(),
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      expect(onAfterTrack.calledOnce).to.equal(true)
    })

    it('does NOT fire onAfterTrack when JSONL append fails (no record landed)', async () => {
      const jsonlStore = makeFakeJsonlStore({appendError: new Error('disk full')})
      const onAfterTrack = spy()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        onAfterTrack: () => onAfterTrack(),
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      expect(onAfterTrack.called, 'failed persist must not signal the scheduler').to.equal(false)
    })

    it('fires onAfterTrack once per successful track', async () => {
      const onAfterTrack = spy()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        onAfterTrack: () => onAfterTrack(),
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      for (let i = 0; i < 5; i++) client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      expect(onAfterTrack.callCount).to.equal(5)
    })

    it('does NOT crash when onAfterTrack throws (analytics no-crash guarantee)', async () => {
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        onAfterTrack() {
          throw new Error('scheduler boom')
        },
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      expect(() => client.track(AnalyticsEventNames.DAEMON_START)).to.not.throw()
      await flushMicrotasks()
    })
  })

  describe('M10.2 mirror flush: invokes sender, mirrors result back to JSONL via updateStatus', () => {
    it('should pass loadPending records to sender.send exactly once per flush', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const sender = makeFakeSender()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 3)
      await client.flush()

      expect(sender.calls).to.have.lengthOf(1)
      const [shipped] = sender.calls
      expect(shipped).to.have.lengthOf(3)
      // All seeded via DAEMON_START so every shipped row carries the same name.
      expect(shipped.map((r) => r.name)).to.deep.equal([
        AnalyticsEventNames.DAEMON_START,
        AnalyticsEventNames.DAEMON_START,
        AnalyticsEventNames.DAEMON_START,
      ])
    })

    it('should mirror all-succeeded result by flipping rows to status=sent', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender: makeFakeSender({kind: 'all-succeeded'}),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 3)
      await client.flush()

      expect(jsonlStore.records.map((r) => r.status)).to.deep.equal(['sent', 'sent', 'sent'])
      // updateStatus(succeeded, 'sent') called with all 3 ids; updateStatus(failed, 'failed') called with empty
      const calls = jsonlStore.updateStatusCalls
      expect(calls.find((c) => c.status === 'sent')?.ids).to.have.lengthOf(3)
      expect(calls.find((c) => c.status === 'failed')?.ids).to.have.lengthOf(0)
    })

    it('should mirror all-failed result by flipping rows to status=failed', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender: makeFakeSender({kind: 'all-failed'}),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 2)
      await client.flush()

      // Note: real M9.2 keeps rows at 'pending' until MAX_ATTEMPTS — the FAKE store flips to
      // 'failed' immediately for unit-test simplicity. End-to-end retry-cap composition is
      // verified in M10.3 against the real JsonlAnalyticsStore.
      expect(jsonlStore.records.map((r) => r.status)).to.deep.equal(['failed', 'failed'])
      const calls = jsonlStore.updateStatusCalls
      expect(calls.find((c) => c.status === 'failed')?.ids).to.have.lengthOf(2)
      expect(calls.find((c) => c.status === 'sent')?.ids).to.have.lengthOf(0)
    })

    it('should mirror mixed result: some ids to sent, some to failed', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        // Late-bound: build the mixed sender with the actual record ids after seeding.
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 4)
      const ids = jsonlStore.records.map((r) => r.id)
      // Re-construct client with a mixed sender keyed off the seeded ids.
      const jsonlStore2 = makeFakeJsonlStore()
      const client2 = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: jsonlStore2,
        queue: new BoundedQueue(),
        sender: makeFakeSender({failedIds: [ids[2], ids[3]], kind: 'mixed', succeededIds: [ids[0], ids[1]]}),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // Re-seed with the SAME ids by appending records directly into jsonlStore2.records.
      for (const r of jsonlStore.records) jsonlStore2.records.push(r)

      await client2.flush()

      // First two sent, last two flipped to failed (per fake-store simplified policy).
      expect(jsonlStore2.records.find((r) => r.id === ids[0])?.status).to.equal('sent')
      expect(jsonlStore2.records.find((r) => r.id === ids[1])?.status).to.equal('sent')
      expect(jsonlStore2.records.find((r) => r.id === ids[2])?.status).to.equal('failed')
      expect(jsonlStore2.records.find((r) => r.id === ids[3])?.status).to.equal('failed')
    })

    it('should treat a sender that throws as all-failed (no daemon crash)', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender: makeFakeSender({error: new Error('network boom'), kind: 'throw'}),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 3)

      // The flush itself must not throw — daemon survives.
      let threw = false
      try {
        await client.flush()
      } catch {
        threw = true
      }

      expect(threw, 'flush MUST NOT throw when sender throws').to.equal(false)
      expect(jsonlStore.records.map((r) => r.status)).to.deep.equal(['failed', 'failed', 'failed'])
    })

    it('should leave JSONL untouched when the no-op sender is wired (regression for review issue #4)', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender: new NoOpAnalyticsSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 5)
      const beforeStatuses = jsonlStore.records.map((r) => r.status)
      const beforeAttempts = jsonlStore.records.map((r) => r.attempts)

      await client.flush()

      expect(jsonlStore.records.map((r) => r.status)).to.deep.equal(beforeStatuses)
      expect(jsonlStore.records.map((r) => r.attempts)).to.deep.equal(beforeAttempts)
      // Both updateStatus calls received empty arrays (no-op sender returns {[],[]}).
      expect(jsonlStore.updateStatusCalls).to.deep.equal([
        {ids: [], status: 'sent'},
        {ids: [], status: 'failed'},
      ])
    })

    it('should return a wire-shape AnalyticsBatch (id/attempts/status stripped via toWireEvent)', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 1)
      const batch = await client.flush()

      expect(batch.events).to.have.lengthOf(1)
      const [event] = batch.events
      expect(event).to.have.property('name', AnalyticsEventNames.DAEMON_START)
      expect(event).to.have.property('created_at')
      expect(event).to.have.property('properties')
      expect(event).to.have.property('identity')
      // Local-only fields stripped on the wire.
      expect(event).to.not.have.property('id')
      expect(event).to.not.have.property('attempts')
      expect(event).to.not.have.property('status')
      expect(event).to.not.have.property('timestamp')
    })
  })

  describe('M4.1 onAuthTransition: clear pending events on login/logout', () => {
    it('should empty the JSONL store and the in-memory queue on transition', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 5)
      expect(jsonlStore.records).to.have.lengthOf(5)
      expect(queue.size()).to.equal(5)

      await client.onAuthTransition()

      expect(jsonlStore.records).to.have.lengthOf(0)
      expect(queue.size()).to.equal(0)
    })

    it('should be a no-op when there is nothing to drop', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // No throw, even when JSONL/queue are already empty.
      await client.onAuthTransition()

      expect(jsonlStore.records).to.have.lengthOf(0)
      expect(queue.size()).to.equal(0)
    })

    it('should NOT crash the consumer when clear() throws on disk error', async () => {
      const queue = new BoundedQueue()
      const baseStore = makeFakeJsonlStore()
      const erroringStore = {
        ...baseStore,
        async clear(): Promise<void> {
          throw new Error('disk full')
        },
      }
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: erroringStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // The await must resolve, not reject.
      let threw = false
      try {
        await client.onAuthTransition()
      } catch {
        threw = true
      }

      expect(threw, 'onAuthTransition must swallow disk errors').to.equal(false)
      // In-memory queue cleared regardless of JSONL error.
      expect(queue.size()).to.equal(0)
    })

    it('should leave subsequently tracked events visible to flush (post-transition events ship under the new session)', async () => {
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      let currentIdentity: Identity = makeAnonIdentity()
      const identityResolver: IIdentityResolver = {
        resolve: async () => currentIdentity,
      }
      const client = new AnalyticsClient({
        identityResolver,
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // Pre-transition tracks
      client.track(AnalyticsEventNames.DAEMON_START)
      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      // Simulate a login transition: identity flips, queue is cleared.
      currentIdentity = makeRegisteredIdentity()
      await client.onAuthTransition()

      // Post-transition tracks
      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      const batch = await client.flush()
      // Only the post-transition event is visible to flush.
      expect(batch.events).to.have.lengthOf(1)
      expect(batch.events[0].identity).to.deep.equal(makeRegisteredIdentity())
    })

    it('should await in-flight tracks before clearing so no append lands after clear', async () => {
      // Regression for the race window: a `track()` call that resolved
      // identity before the transition but had not yet appended would,
      // without the barrier, enqueue its append AFTER onAuthTransition's
      // clear and persist a stale-identity record. The barrier awaits
      // every in-flight track promise before issuing clear().
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      let releaseIdentity!: (id: Identity) => void
      const slowIdentityResolver: IIdentityResolver = {
        resolve: () =>
          new Promise<Identity>((resolve) => {
            releaseIdentity = resolve
          }),
      }
      const client = new AnalyticsClient({
        identityResolver: slowIdentityResolver,
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // Fire a track; identityResolver is pending so trackAsync is
      // stuck pre-append.
      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()
      // Nothing on disk yet.
      expect(jsonlStore.records).to.have.lengthOf(0)

      // Kick off transition; clear MUST wait for the in-flight track.
      const transitionPromise = client.onAuthTransition()
      // Yield once so onAuthTransition reaches its `await
      // Promise.allSettled([...pendingTracks])` before we release the
      // identity. Without this yield, releaseIdentity runs before
      // transitionPromise's body executes its first await, and the
      // barrier snapshot may miss the race we are trying to cover.
      await Promise.resolve()
      // Resolve the identity AFTER the barrier is in place. Append will
      // race with clear. The barrier guarantees clear runs LAST.
      releaseIdentity(makeAnonIdentity())
      await transitionPromise

      // Final state: clear nuked the stale-identity append.
      expect(jsonlStore.records, 'no record may survive a transition that ran after a track started').to.have.lengthOf(0)
      expect(queue.size()).to.equal(0)
    })

    it('should NOT block new tracks that start AFTER onAuthTransition began', async () => {
      // The barrier only awaits tracks already in-flight at the moment
      // onAuthTransition starts. Tracks that arrive after the snapshot
      // get the new identity and must persist normally.
      const queue = new BoundedQueue()
      const jsonlStore = makeFakeJsonlStore()
      let currentIdentity: Identity = makeAnonIdentity()
      const identityResolver: IIdentityResolver = {
        resolve: async () => currentIdentity,
      }
      const client = new AnalyticsClient({
        identityResolver,
        isEnabled: () => true,
        jsonlStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      currentIdentity = makeRegisteredIdentity()
      await client.onAuthTransition()

      // New track after transition completed; uses new identity.
      client.track(AnalyticsEventNames.DAEMON_START)
      await flushMicrotasks()

      expect(jsonlStore.records).to.have.lengthOf(1)
      expect(jsonlStore.records[0].identity).to.deep.equal(makeRegisteredIdentity())
    })

    it('should surface clear() failures through the optional log sink (M4.1 visibility)', async () => {
      const queue = new BoundedQueue()
      const baseStore = makeFakeJsonlStore()
      const erroringStore = {
        ...baseStore,
        async clear(): Promise<void> {
          throw new Error('disk full')
        },
      }
      const logged: string[] = []
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: erroringStore,
        log: (msg) => logged.push(msg),
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await client.onAuthTransition()

      expect(logged).to.have.lengthOf(1)
      expect(logged[0]).to.include('clear failed')
      expect(logged[0]).to.include('disk full')
    })

    it('should remain crash-free when no log sink is wired and clear() throws', async () => {
      // Regression: log sink is optional; absent log must not turn a
      // disk error into an uncaught rejection.
      const queue = new BoundedQueue()
      const baseStore = makeFakeJsonlStore()
      const erroringStore = {
        ...baseStore,
        async clear(): Promise<void> {
          throw new Error('disk full')
        },
      }
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: erroringStore,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      let threw = false
      try {
        await client.onAuthTransition()
      } catch {
        threw = true
      }

      expect(threw).to.equal(false)
    })
  })

  describe('M10.2 single-flight: concurrent flush() invocations collapse to one underlying run', () => {
    it('should call sender.send only once when two flush() calls are awaited in parallel', async () => {
      // Without single-flight, both flushes load the same pending set, both call sender, and
      // both mirror updateStatus(failed, ids) into the writeChain — the writes serialize but
      // attempts get double-incremented (cycle counter advances 2x). The single-flight guard
      // makes a concurrent call join the in-flight promise instead.
      const jsonlStore = makeFakeJsonlStore()
      const sender = makeFakeSender({kind: 'all-failed'})
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 3)

      const [batchA, batchB] = await Promise.all([client.flush(), client.flush()])

      // Single-flight collapsed both calls into one sender invocation with the same record set.
      expect(sender.calls, 'two concurrent flushes must share one sender.send invocation').to.have.lengthOf(1)
      // Concurrent callers receive the same batch object (joined in-flight promise).
      expect(batchA).to.equal(batchB)
      // updateStatus(failed, ids) called exactly once for the failed branch (succeeded branch
      // is also called once with []).
      const failedCalls = jsonlStore.updateStatusCalls.filter((c) => c.status === 'failed' && c.ids.length > 0)
      expect(failedCalls, 'failed-updateStatus must run exactly once across the two concurrent flushes').to.have.lengthOf(1)
    })

    it('should release the in-flight slot after the flush settles so the next call runs fresh', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const sender = makeFakeSender({kind: 'all-succeeded'})
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 1)
      await client.flush() // first flush: sender called, record marked sent
      // After settle, loadPending now returns [] because record is 'sent'.
      // The next flush should run fresh (NOT return the previous batch).
      const second = await client.flush()

      expect(sender.calls, 'sequential flushes must each invoke sender').to.have.lengthOf(2)
      expect(second.events, 'second flush sees no pending rows after first settled').to.deep.equal([])
    })
  })

  describe('M4.4 flush gate: disabled state skips remote send, leaves JSONL intact', () => {
    it('flush() returns empty batch and does NOT call sender when isEnabled returns false', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const sender = makeFakeSender()
      // Pre-seed JSONL with a pending record (simulating an event tracked
      // BEFORE the user disabled analytics — backlog scenario).
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 3)
      expect(jsonlStore.records, 'precondition: 3 pending').to.have.lengthOf(3)

      // Now disable and flush. Records MUST stay `pending` in JSONL;
      // re-enable later ships them on the next scheduler tick.
      const disabledClient = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => false,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      const batch = await disabledClient.flush()

      expect(batch.events, 'disabled flush returns empty batch').to.deep.equal([])
      expect(sender.calls, 'disabled flush must NOT call sender').to.have.lengthOf(0)
      expect(
        jsonlStore.records.every((r) => r.status === 'pending'),
        'disabled flush must leave JSONL records as pending (backlog preserved)',
      ).to.be.true
    })

    it('flush() ships the backlog after re-enable (disabled → enabled transition resumes shipping)', async () => {
      const jsonlStore = makeFakeJsonlStore()
      const sender = makeFakeSender()
      let enabled = false
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => enabled,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // Track 5 events while disabled — JSONL still grows.
      await seedPending(client, 5)
      expect(jsonlStore.records).to.have.lengthOf(5)

      // Flush while disabled — no-op on sender, backlog stays pending.
      await client.flush()
      expect(sender.calls).to.have.lengthOf(0)

      // Re-enable + flush — backlog ships.
      enabled = true
      await client.flush()
      expect(sender.calls, 'enabled flush ships the backlog').to.have.lengthOf(1)
      expect(sender.calls[0]).to.have.lengthOf(5)
    })
  })

  describe('M4.4 abort(): cancels in-flight flush via signal piped to sender', () => {
    it('abort() during in-flight flush causes sender to receive an aborted signal', async () => {
      let observedSignal: AbortSignal | undefined
      let releaseSend!: () => void
      const sender: IAnalyticsSender = {
        async send(records, options) {
          observedSignal = options?.signal
          await new Promise<void>((resolve) => {
            releaseSend = resolve
          })
          // Mimic HttpAnalyticsSender on abort: all-failed.
          return {failed: records.map((r) => r.id), succeeded: []}
        },
      }
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 2)
      const flushPromise = client.flush()
      await flushMicrotasks()
      // Sender is now in-flight; abort the client.
      client.abort()
      expect(observedSignal?.aborted, 'sender must observe signal.aborted=true after abort()').to.equal(true)

      // Release the sender to let flush settle. JSONL records get marked
      // failed (not stuck pending) per the existing failure-classification
      // path; that's M9.2's retry-cap concern, not M4.4's.
      releaseSend()
      await flushPromise
    })

    it('abort() is a no-op when no flush is in flight', () => {
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // Must not throw.
      client.abort()
    })

    it('does NOT bump M9.2 attempts on aborted flush (records stay pending for next enabled flush)', async () => {
      // Regression for N3 review finding: without this skip, every
      // disable-during-flush would call updateStatus(failed, 'failed')
      // which bumps `attempts` via the M9.2 retry-cap. A few
      // disable/enable toggles during shipping could drive records to
      // attempts >= MAX_ATTEMPTS and terminate them — silent data loss.
      let releaseSend!: () => void
      const sender: IAnalyticsSender = {
        async send(records, _options) {
          await new Promise<void>((resolve) => {
            releaseSend = resolve
          })
          // Mimic the abort-classification path: all-failed.
          return {failed: records.map((r) => r.id), succeeded: []}
        },
      }
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 3)
      expect(jsonlStore.records.every((r) => r.status === 'pending')).to.be.true

      const flushPromise = client.flush()
      await flushMicrotasks()
      client.abort()
      releaseSend()
      await flushPromise

      const failedUpdates = jsonlStore.updateStatusCalls.filter((c) => c.status === 'failed' && c.ids.length > 0)
      expect(
        failedUpdates,
        'aborted flush must NOT call updateStatus(_, failed) with any ids — preserves M9.2 attempts',
      ).to.have.lengthOf(0)
      expect(
        jsonlStore.records.every((r) => r.status === 'pending'),
        'records remain pending so the next enabled flush ships them cleanly',
      ).to.be.true
    })
  })

  describe('M4.5 backoff policy feedback', () => {
    type StubPolicy = {
      applyServerHint: ReturnType<typeof stub>
      consecutiveFailures: () => number
      isRateLimited: () => boolean
      nextDelayMs: () => number
      onFailure: ReturnType<typeof stub>
      onSuccess: ReturnType<typeof stub>
    }

    function makePolicyStub(): StubPolicy {
      return {
        applyServerHint: stub(),
        consecutiveFailures: () => 0,
        isRateLimited: () => false,
        nextDelayMs: () => 30_000,
        onFailure: stub(),
        onSuccess: stub(),
      }
    }

    it('calls policy.onSuccess() when the batch fully succeeds', async () => {
      const policy = makePolicyStub()
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 2)
      await client.flush()

      expect(policy.onSuccess.calledOnce, 'success advances onSuccess once').to.be.true
      expect(policy.onFailure.called).to.be.false
    })

    it('calls policy.onFailure() on http_5xx (transient → back off)', async () => {
      const policy = makePolicyStub()
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('http_5xx'),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()

      expect(policy.onFailure.calledOnce).to.be.true
      expect(policy.onSuccess.called).to.be.false
    })

    it('calls policy.onFailure() on timeout', async () => {
      const policy = makePolicyStub()
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('timeout'),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()

      expect(policy.onFailure.calledOnce).to.be.true
    })

    it('calls policy.onFailure() on network failure', async () => {
      const policy = makePolicyStub()
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('network'),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()

      expect(policy.onFailure.calledOnce).to.be.true
    })

    it('does NOT advance the policy on http_4xx (payload shape is wrong, not a backend health signal)', async () => {
      const policy = makePolicyStub()
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('http_4xx'),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()

      expect(policy.onFailure.called, '4xx must NOT advance backoff').to.be.false
      expect(policy.onSuccess.called, '4xx is not a success either').to.be.false
    })

    it('honors a rate_limited result via applyServerHint and does NOT advance the failure counter (M5.4 — ENG-2658)', async () => {
      const policy = makePolicyStub()
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('rate_limited', 120_000),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()

      expect(policy.applyServerHint.calledOnceWithExactly(120_000), 'server hint is forwarded to the policy').to.be
        .true
      expect(policy.onFailure.called, 'a 429/503 is reachable, not a failure').to.be.false
      expect(policy.onSuccess.called, 'a rate-limit is not a success either').to.be.false
    })

    it('on a rate_limited result without retryAfterMs: logs AND still marks the policy rate-limited so the burst gate engages (M5.4 — ENG-2658)', async () => {
      const policy = makePolicyStub()
      const logs: string[] = []
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        log: (m) => logs.push(m),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('rate_limited'), // no retryAfterMs — malformed per the contract
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()

      // Still flip the rate-limited bit (with an invalid sentinel so no delay
      // floor is set) so the scheduler's burst gate stays closed — otherwise the
      // next 20-event burst would hammer a server we were just told to back off from.
      expect(policy.applyServerHint.calledOnce, 'the rate-limited bit must still be flipped').to.be.true
      expect(
        Number.isFinite(policy.applyServerHint.firstCall.args[0]),
        'called with a non-finite sentinel so no delay floor is applied',
      ).to.equal(false)
      expect(policy.onFailure.called, 'still not a reachability failure').to.be.false
      expect(
        logs.some((m) => m.includes('rate_limited') && /retryAfterMs|hint|burst|suppress/i.test(m)),
        'the dropped hint must be surfaced in the daemon log, not silently swallowed',
      ).to.equal(true)
    })

    it('does NOT touch the policy when abort() fired during the flush (user-driven cancel, not a backend signal)', async () => {
      const policy = makePolicyStub()
      let releaseSend!: () => void
      const sender: IAnalyticsSender = {
        async send(records, _options) {
          await new Promise<void>((resolve) => {
            releaseSend = resolve
          })
          // Mimic the abort-classification path: all-failed with network.
          return {failed: records.map((r) => r.id), reason: 'network', succeeded: []}
        },
      }
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      const flushPromise = client.flush()
      await flushMicrotasks()
      client.abort()
      releaseSend()
      await flushPromise

      expect(policy.onFailure.called, 'abort-driven failure must NOT poison the M4.6 reachability counter').to.be.false
      expect(policy.onSuccess.called).to.be.false
    })

    it('works without a backoff policy wired (back-compat: dep is optional)', async () => {
      // No backoffPolicy in deps — sender returns http_5xx — must not crash.
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('http_5xx'),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()
      // No assertion needed beyond "did not throw".
    })

    it('does NOT call onSuccess() on an uncategorized failed-without-reason result', async () => {
      // Regression for review finding I1: prior code treated `reason === undefined`
      // as success and called `onSuccess()`. A `{failed: ids, succeeded: [],
      // reason: undefined}` result is a "we never shipped" outcome, NOT a clean
      // ship — resetting backoff here would wrongly clear the unreachable
      // counter. (The missing-deviceId path now classifies as `http_4xx` and is
      // guarded separately above; this case covers any other uncategorized
      // failure.) Should skip entirely.
      const policy = makePolicyStub()
      const sender: IAnalyticsSender = {
        async send(records) {
          // Mimic an uncategorized failure: failed-with-no-reason.
          return {failed: records.map((r) => r.id), succeeded: []}
        },
      }
      const client = new AnalyticsClient({
        backoffPolicy: policy,
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        queue: new BoundedQueue(),
        sender,
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })
      await seedPending(client, 1)
      await client.flush()

      expect(policy.onSuccess.called, 'failed-without-reason must NOT call onSuccess').to.be.false
      expect(policy.onFailure.called, 'failed-without-reason must NOT call onFailure either').to.be.false
    })
  })

  describe('M4.6 runtime state tracking', () => {
    /**
     * `lastSuccessfulFlushAt` is the timestamp shown by `brv settings get analytics.status`
     * as "Last successful flush". Updated ONLY on a real clean ship —
     * same gate as M4.5's backoff `onSuccess()`. Aborted, 4xx, failed,
     * and empty-batch outcomes leave it untouched. The `now: () => number`
     * dep is injected for deterministic assertions.
     */
    it('lastSuccessfulFlushAt is undefined on a fresh client', async () => {
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        now: () => 1_700_000_000_000,
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      const state = await client.getRuntimeState()
      expect(state.lastSuccessfulFlushAt, 'no flush has run yet').to.equal(undefined)
    })

    it('lastSuccessfulFlushAt is set to now() after a clean successful flush', async () => {
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        now: () => 1_700_000_000_000,
        queue: new BoundedQueue(),
        sender: makeFakeSender({kind: 'all-succeeded'}),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 2)
      await client.flush()

      const state = await client.getRuntimeState()
      expect(state.lastSuccessfulFlushAt).to.equal(1_700_000_000_000)
    })

    it('lastSuccessfulFlushAt is NOT updated when the flush fails (sender returns reason)', async () => {
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        now: () => 1_700_000_000_000,
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('http_5xx'),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 1)
      await client.flush()

      const state = await client.getRuntimeState()
      expect(state.lastSuccessfulFlushAt, 'failed flush must not advance the timestamp').to.equal(undefined)
    })

    it('lastSuccessfulFlushAt is NOT updated on http_4xx (payload-shape error)', async () => {
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        now: () => 1_700_000_000_000,
        queue: new BoundedQueue(),
        sender: makeSenderWithReason('http_4xx'),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 1)
      await client.flush()

      const state = await client.getRuntimeState()
      expect(state.lastSuccessfulFlushAt).to.equal(undefined)
    })

    it('lastSuccessfulFlushAt is NOT updated on an empty-batch no-op flush', async () => {
      // No records seeded; flush still resolves but ships nothing.
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        now: () => 1_700_000_000_000,
        queue: new BoundedQueue(),
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await client.flush()

      const state = await client.getRuntimeState()
      expect(state.lastSuccessfulFlushAt, 'empty-batch flush is not a real ship').to.equal(undefined)
    })

    it('getRuntimeState surfaces JSONL pending count (NOT in-memory mirror) and droppedCount', async () => {
      // Two pending records, one already-sent record. queueDepth should
      // see only the pending row; dropped count surfaces from the queue.
      const queue = new BoundedQueue(5)
      const jsonlStore = makeFakeJsonlStore()
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore,
        now: () => 1_700_000_000_000,
        queue,
        sender: makeFakeSender({kind: 'all-succeeded'}),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      // Seed 3 events, flush 1 batch (all-succeeded), then add 2 more.
      await seedPending(client, 3)
      await client.flush() // 3 records → 'sent'
      await seedPending(client, 2) // 2 new 'pending' records

      const state = await client.getRuntimeState()
      expect(state.queueDepth, 'JSONL pending count, NOT queue.size()').to.equal(2)
      // No drops in this scenario.
      expect(state.droppedCount).to.equal(0)
    })

    it('getRuntimeState reflects droppedCount when the bounded queue evicts oldest', async () => {
      // Cap of 2; pushing 4 records evicts the first 2.
      const queue = new BoundedQueue(2)
      const client = new AnalyticsClient({
        identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
        isEnabled: () => true,
        jsonlStore: makeFakeJsonlStore(),
        now: () => 1_700_000_000_000,
        queue,
        sender: makeFakeSender(),
        superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
      })

      await seedPending(client, 4)
      const state = await client.getRuntimeState()
      expect(state.droppedCount, 'queue dropped 2 of 4 oldest events').to.equal(2)
    })
  })
})
