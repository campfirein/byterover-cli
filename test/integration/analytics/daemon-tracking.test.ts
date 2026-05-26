/* eslint-disable camelcase */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {AuthToken} from '../../../src/server/core/domain/entities/auth-token.js'
import type {IAuthStateReader} from '../../../src/server/core/interfaces/analytics/i-identity-resolver.js'
import type {IGlobalConfigStore} from '../../../src/server/core/interfaces/storage/i-global-config-store.js'

import {AnalyticsBatch} from '../../../src/server/core/domain/analytics/batch.js'
import {GlobalConfig} from '../../../src/server/core/domain/entities/global-config.js'
import {AnalyticsClient} from '../../../src/server/infra/analytics/analytics-client.js'
import {BoundedQueue} from '../../../src/server/infra/analytics/bounded-queue.js'
import {IdentityResolver} from '../../../src/server/infra/analytics/identity-resolver.js'
import {JsonlAnalyticsStore} from '../../../src/server/infra/analytics/jsonl-analytics-store.js'
import {NoOpAnalyticsSender} from '../../../src/server/infra/analytics/no-op-analytics-sender.js'
import {SuperPropertiesResolver} from '../../../src/server/infra/analytics/super-properties-resolver.js'
import {FileGlobalConfigStore} from '../../../src/server/infra/storage/file-global-config-store.js'
import {GlobalConfigHandler} from '../../../src/server/infra/transport/handlers/global-config-handler.js'
import {createMockTransportServer} from '../../helpers/mock-factories.js'

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

async function waitForQueueSize(queue: BoundedQueue, expected: number, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (queue.size() < expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForQueueSize: expected ${expected}, got ${queue.size()} after ${timeoutMs}ms`)
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}

function makeAnonAuthReader(): IAuthStateReader {
  const noToken: AuthToken | undefined = undefined
  return {getToken: () => noToken}
}

describe('daemon analytics tracking integration (ticket scenario 6)', () => {
  let testDir: string
  let testConfigPath: string
  let store: FileGlobalConfigStore

  beforeEach(() => {
    testDir = join(tmpdir(), `test-daemon-tracking-${Date.now()}-${randomUUID().slice(0, 8)}`)
    testConfigPath = join(testDir, 'config.json')
    store = new FileGlobalConfigStore({
      getConfigDir: () => testDir,
      getConfigPath: () => testConfigPath,
    })
  })

  afterEach(async () => {
    if (existsSync(testDir)) {
      await rm(testDir, {force: true, recursive: true})
    }
  })

  it('should land daemon_start in the queue with full identity + super properties when analytics is enabled', async () => {
    // Pre-seed the on-disk config so analytics is enabled and deviceId is stable
    // for assertions. This mirrors what M1.3 `brv analytics enable` writes.
    const seeded = GlobalConfig.fromJson({analytics: true, deviceId: validDeviceId, version: '0.0.1'})
    if (!seeded) throw new Error('test fixture: seeded GlobalConfig must be valid')
    await store.write(seeded)

    // Compose the daemon's analytics dependencies the same way feature-handlers.ts does.
    const transport = createMockTransportServer()
    const handler = new GlobalConfigHandler({globalConfigStore: store, transport})
    handler.setup()
    await handler.refreshCache()

    const queue = new BoundedQueue()
    const client = new AnalyticsClient({
      identityResolver: new IdentityResolver(makeAnonAuthReader(), store),
      isEnabled: () => handler.getCachedAnalytics(),
      jsonlStore: new JsonlAnalyticsStore({baseDir: testDir}),
      queue,
      sender: new NoOpAnalyticsSender(),
      superPropsResolver: new SuperPropertiesResolver(store, () => '3.10.3'),
    })

    // Fire the daemon_start sample event exactly as feature-handlers.ts does.
    const before = Date.now()
    client.track('daemon_start')
    await waitForQueueSize(queue, 1)
    const after = Date.now()

    const batch = await client.flush()
    expect(batch.events).to.have.lengthOf(1)
    const [event] = batch.events

    expect(event.name).to.equal('daemon_start')
    expect(event.timestamp).to.be.at.least(before)
    expect(event.timestamp).to.be.at.most(after)

    // Anonymous identity: device_id only (no token in the stub reader)
    expect(event.identity).to.deep.equal({device_id: validDeviceId})

    // All five super properties stamped onto event.properties
    expect(event.properties.cli_version).to.equal('3.10.3')
    expect(event.properties.device_id).to.equal(validDeviceId)
    expect(event.properties.environment).to.be.oneOf(['development', 'production'])
    expect(event.properties.node_version).to.equal(process.version)
    expect(event.properties.os).to.equal(process.platform)
  })

  it('should produce a batch that round-trips through AnalyticsBatch.fromJson', async () => {
    const seeded = GlobalConfig.fromJson({analytics: true, deviceId: validDeviceId, version: '0.0.1'})
    if (!seeded) throw new Error('test fixture: seeded GlobalConfig must be valid')
    await store.write(seeded)

    const transport = createMockTransportServer()
    const handler = new GlobalConfigHandler({globalConfigStore: store, transport})
    handler.setup()
    await handler.refreshCache()

    const queue = new BoundedQueue()
    const client = new AnalyticsClient({
      identityResolver: new IdentityResolver(makeAnonAuthReader(), store),
      isEnabled: () => handler.getCachedAnalytics(),
      jsonlStore: new JsonlAnalyticsStore({baseDir: testDir}),
      queue,
      sender: new NoOpAnalyticsSender(),
      superPropsResolver: new SuperPropertiesResolver(store, () => '3.10.3'),
    })

    client.track('daemon_start')
    await waitForQueueSize(queue, 1)

    const batch = await client.flush()
    const restored = AnalyticsBatch.fromJson(batch.toJson())

    expect(restored).to.not.be.undefined
    expect(restored?.schema_version).to.equal(1)
    expect(restored?.events).to.have.lengthOf(1)
    expect(restored?.events[0].name).to.equal('daemon_start')
    expect(restored?.events[0].identity.device_id).to.equal(validDeviceId)
  })

  it('should drop daemon_start silently when analytics is disabled (default opt-in)', async () => {
    // No pre-seeded config — handler.refreshCache() leaves cachedAnalytics at default false.
    const transport = createMockTransportServer()
    const handler = new GlobalConfigHandler({globalConfigStore: store, transport})
    handler.setup()
    await handler.refreshCache()

    const queue = new BoundedQueue()
    const client = new AnalyticsClient({
      identityResolver: new IdentityResolver(makeAnonAuthReader(), store),
      isEnabled: () => handler.getCachedAnalytics(),
      jsonlStore: new JsonlAnalyticsStore({baseDir: testDir}),
      queue,
      sender: new NoOpAnalyticsSender(),
      superPropsResolver: new SuperPropertiesResolver(store, () => '3.10.3'),
    })

    client.track('daemon_start')
    // Give the event loop a few ticks; if track() were not a true no-op,
    // any resolver work would land here. Two setImmediates is enough because
    // the disabled path returns synchronously without scheduling anything.
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    expect(queue.size()).to.equal(0)
    const batch = await client.flush()
    expect(batch.events).to.deep.equal([])
  })

  it('should fall back to disabled (not throw) when the config store read rejects during refreshCache', async () => {
    // FileGlobalConfigStore catches its own errors and never throws, but a
    // hypothetical alternative implementation might. Verify refreshCache's
    // catch block leaves the cache in a usable state — getCachedAnalytics
    // must return false rather than throw, otherwise the daemon would crash
    // on bootstrap when track() runs.
    const throwingStore: IGlobalConfigStore = {
      async read() {
        throw new Error('read boom')
      },
      async write() {
        // unused in this test
      },
    }
    const transport = createMockTransportServer()
    const handler = new GlobalConfigHandler({globalConfigStore: throwingStore, transport})
    handler.setup()
    await handler.refreshCache()

    expect(() => handler.getCachedAnalytics()).to.not.throw()
    expect(handler.getCachedAnalytics()).to.equal(false)
  })
})
