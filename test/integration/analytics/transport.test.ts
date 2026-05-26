/* eslint-disable camelcase */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {AuthToken} from '../../../src/server/core/domain/entities/auth-token.js'
import type {IAuthStateReader} from '../../../src/server/core/interfaces/analytics/i-identity-resolver.js'

import {GlobalConfig} from '../../../src/server/core/domain/entities/global-config.js'
import {AnalyticsClient} from '../../../src/server/infra/analytics/analytics-client.js'
import {BoundedQueue} from '../../../src/server/infra/analytics/bounded-queue.js'
import {IdentityResolver} from '../../../src/server/infra/analytics/identity-resolver.js'
import {JsonlAnalyticsStore} from '../../../src/server/infra/analytics/jsonl-analytics-store.js'
import {NoOpAnalyticsSender} from '../../../src/server/infra/analytics/no-op-analytics-sender.js'
import {SuperPropertiesResolver} from '../../../src/server/infra/analytics/super-properties-resolver.js'
import {FileGlobalConfigStore} from '../../../src/server/infra/storage/file-global-config-store.js'
import {AnalyticsHandler} from '../../../src/server/infra/transport/handlers/analytics-handler.js'
import {GlobalConfigHandler} from '../../../src/server/infra/transport/handlers/global-config-handler.js'
import {AnalyticsEventNames} from '../../../src/shared/analytics/event-names.js'
import {AnalyticsEvents} from '../../../src/shared/transport/events/analytics-events.js'
import {createMockTransportServer} from '../../helpers/mock-factories.js'

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

type AnalyticsTrackHandler = (data: unknown, clientId: string) => Promise<void>

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

describe('analytics:track transport round-trip integration (M2.6)', () => {
  let testDir: string
  let testConfigPath: string
  let store: FileGlobalConfigStore

  beforeEach(() => {
    testDir = join(tmpdir(), `test-analytics-transport-${Date.now()}-${randomUUID().slice(0, 8)}`)
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

  it('should land a client-emitted event in the daemon queue with full identity + super-properties', async () => {
    // Pre-seed config so analytics is enabled and deviceId is stable.
    const seeded = GlobalConfig.fromJson({analytics: true, deviceId: validDeviceId, version: '0.0.1'})
    if (!seeded) throw new Error('test fixture: seeded GlobalConfig must be valid')
    await store.write(seeded)

    // Compose daemon dependencies the same way feature-handlers.ts does.
    const transport = createMockTransportServer()
    const globalConfigHandler = new GlobalConfigHandler({globalConfigStore: store, transport})
    globalConfigHandler.setup()
    await globalConfigHandler.refreshCache()

    const queue = new BoundedQueue()
    const analyticsClient = new AnalyticsClient({
      identityResolver: new IdentityResolver(makeAnonAuthReader(), store),
      isEnabled: () => globalConfigHandler.getCachedAnalytics(),
      jsonlStore: new JsonlAnalyticsStore({baseDir: testDir}),
      queue,
      sender: new NoOpAnalyticsSender(),
      superPropsResolver: new SuperPropertiesResolver(store, () => '3.10.3'),
    })

    new AnalyticsHandler({analyticsClient, transport}).setup()

    // Simulate a daemon-internal emit going through the wire `analytics:track`
    // path (validated against the per-event Zod schema before dispatch).
    const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
    expect(handler, 'analytics:track handler must be registered').to.exist

    await handler(
      {
        event: AnalyticsEventNames.CURATE_OPERATION_APPLIED,
        properties: {
          absolute_path: '/tmp/x.md',
          knowledge_path: 'kg/x.md',
          needs_review: false,
          operation_type: 'ADD',
          task_id: 't-1',
        },
      },
      'client-1',
    )
    await waitForQueueSize(queue, 1)

    const batch = await analyticsClient.flush()
    expect(batch.events).to.have.lengthOf(1)
    const [event] = batch.events

    expect(event.name).to.equal(AnalyticsEventNames.CURATE_OPERATION_APPLIED)
    expect(event.identity).to.deep.equal({device_id: validDeviceId})

    // User-supplied properties preserved end-to-end
    expect(event.properties.absolute_path).to.equal('/tmp/x.md')
    expect(event.properties.operation_type).to.equal('ADD')

    // All five super-properties stamped on receipt
    expect(event.properties.cli_version).to.equal('3.10.3')
    expect(event.properties.device_id).to.equal(validDeviceId)
    expect(event.properties.environment).to.be.oneOf(['development', 'production'])
    expect(event.properties.node_version).to.equal(process.version)
    expect(event.properties.os).to.equal(process.platform)
  })

  it('should drop the event silently when analytics is disabled (default opt-in)', async () => {
    const transport = createMockTransportServer()
    const globalConfigHandler = new GlobalConfigHandler({globalConfigStore: store, transport})
    globalConfigHandler.setup()
    await globalConfigHandler.refreshCache()

    const queue = new BoundedQueue()
    const analyticsClient = new AnalyticsClient({
      identityResolver: new IdentityResolver(makeAnonAuthReader(), store),
      isEnabled: () => globalConfigHandler.getCachedAnalytics(),
      jsonlStore: new JsonlAnalyticsStore({baseDir: testDir}),
      queue,
      sender: new NoOpAnalyticsSender(),
      superPropsResolver: new SuperPropertiesResolver(store, () => '3.10.3'),
    })

    new AnalyticsHandler({analyticsClient, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler
    await handler({event: AnalyticsEventNames.DAEMON_START}, 'client-1')
    // Two ticks suffice — the disabled path is sync inside track() and never schedules async work.
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    expect(queue.size()).to.equal(0)
  })

  it('should drop a malformed payload (empty event) without enqueueing', async () => {
    const seeded = GlobalConfig.fromJson({analytics: true, deviceId: validDeviceId, version: '0.0.1'})
    if (!seeded) throw new Error('test fixture: seeded GlobalConfig must be valid')
    await store.write(seeded)

    const transport = createMockTransportServer()
    const globalConfigHandler = new GlobalConfigHandler({globalConfigStore: store, transport})
    globalConfigHandler.setup()
    await globalConfigHandler.refreshCache()

    const queue = new BoundedQueue()
    const analyticsClient = new AnalyticsClient({
      identityResolver: new IdentityResolver(makeAnonAuthReader(), store),
      isEnabled: () => globalConfigHandler.getCachedAnalytics(),
      jsonlStore: new JsonlAnalyticsStore({baseDir: testDir}),
      queue,
      sender: new NoOpAnalyticsSender(),
      superPropsResolver: new SuperPropertiesResolver(store, () => '3.10.3'),
    })

    new AnalyticsHandler({analyticsClient, transport}).setup()

    const handler = transport._handlers.get(AnalyticsEvents.TRACK) as AnalyticsTrackHandler

    // Various malformed payloads
    await handler({event: ''}, 'client-1')
    await handler({properties: {x: 1}}, 'client-1')
    await handler(null, 'client-1')

    // Drain — none should land
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })

    expect(queue.size()).to.equal(0)
  })
})
