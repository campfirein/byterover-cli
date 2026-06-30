/* eslint-disable camelcase */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {Identity} from '../../../src/server/core/domain/analytics/identity.js'
import type {IAnalyticsSender, SendResult} from '../../../src/server/core/interfaces/analytics/i-analytics-sender.js'
import type {IIdentityResolver} from '../../../src/server/core/interfaces/analytics/i-identity-resolver.js'
import type {ISuperPropertiesResolver, SuperProperties} from '../../../src/server/core/interfaces/analytics/i-super-properties-resolver.js'
import type {StoredAnalyticsRecord} from '../../../src/shared/analytics/stored-record.js'

import {AnalyticsClient} from '../../../src/server/infra/analytics/analytics-client.js'
import {BoundedQueue} from '../../../src/server/infra/analytics/bounded-queue.js'
import {JsonlAnalyticsStore} from '../../../src/server/infra/analytics/jsonl-analytics-store.js'
import {AnalyticsEventNames} from '../../../src/shared/analytics/event-names.js'
import {MAX_ATTEMPTS} from '../../../src/shared/analytics/stored-record.js'

const validDeviceId = '550e8400-e29b-41d4-a716-446655440000'

function makeAnonIdentity(): Identity {
  return {device_id: validDeviceId}
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
  return {resolve: async () => identity}
}

function makeStubSuperPropsResolver(props: SuperProperties): ISuperPropertiesResolver {
  return {resolve: async () => props}
}

type AllFailingSender = IAnalyticsSender & {
  readonly nonEmptyCallCount: number
  readonly perCallInputs: ReadonlyArray<ReadonlyArray<StoredAnalyticsRecord>>
}

function makeAllFailingSender(): AllFailingSender {
  const perCallInputs: Array<ReadonlyArray<StoredAnalyticsRecord>> = []
  return {
    get nonEmptyCallCount() {
      return perCallInputs.filter((records) => records.length > 0).length
    },
    perCallInputs,
    async send(records: readonly StoredAnalyticsRecord[]): Promise<SendResult> {
      perCallInputs.push([...records])
      return {failed: records.map((r) => r.id), succeeded: []}
    },
  }
}

async function waitForRows(jsonlStore: JsonlAnalyticsStore, count: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const result = await jsonlStore.list({limit: 1000, offset: 0})
    if (result.rows.length >= count) return
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForRows: expected ${count}, got ${result.rows.length} after ${timeoutMs}ms`)
    }

    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
}

describe('M10.3 retry-cap end-to-end composition (M9.1 constant + M9.2 store + M10.2 flush)', () => {
  let baseDir: string

  beforeEach(() => {
    baseDir = join(tmpdir(), `analytics-retry-cap-${Date.now()}-${randomUUID().slice(0, 8)}`)
  })

  afterEach(async () => {
    if (existsSync(baseDir)) {
      await rm(baseDir, {force: true, recursive: true})
    }
  })

  it('should walk a row pending(0) → pending(1) → pending(2) → failed(3) over MAX_ATTEMPTS flush cycles', async () => {
    expect(MAX_ATTEMPTS, 'this test is keyed off MAX_ATTEMPTS=3 from M9.1').to.equal(3)

    const jsonlStore = new JsonlAnalyticsStore({baseDir})
    const sender = makeAllFailingSender()
    const client = new AnalyticsClient({
      identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
      isEnabled: () => true,
      jsonlStore,
      queue: new BoundedQueue(),
      sender,
      superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
    })

    // Track exactly one event so the cap walk is unambiguous.
    client.track(AnalyticsEventNames.DAEMON_START)
    await waitForRows(jsonlStore, 1)

    const initialRows = await jsonlStore.list({limit: 100, offset: 0})
    expect(initialRows.rows).to.have.lengthOf(1)
    const targetId = initialRows.rows[0].id
    expect(initialRows.rows[0].status).to.equal('pending')
    expect(initialRows.rows[0].attempts).to.equal(0)

    // Flush #1: sender fails → updateStatus(failed) increments attempts to 1 but keeps status='pending'.
    await client.flush()
    let snap = await jsonlStore.list({limit: 100, offset: 0})
    expect(snap.rows[0].status, 'after flush #1: status stays pending').to.equal('pending')
    expect(snap.rows[0].attempts, 'after flush #1: attempts=1').to.equal(1)

    // loadPending must STILL surface this row so flush #2 retries it.
    let pending = await jsonlStore.loadPending()
    expect(pending.map((r) => r.id), 'pending after flush #1 must include the row').to.include(targetId)

    // Flush #2: attempts=2, still pending.
    await client.flush()
    snap = await jsonlStore.list({limit: 100, offset: 0})
    expect(snap.rows[0].status, 'after flush #2: status stays pending').to.equal('pending')
    expect(snap.rows[0].attempts, 'after flush #2: attempts=2').to.equal(2)

    pending = await jsonlStore.loadPending()
    expect(pending.map((r) => r.id), 'pending after flush #2 must include the row').to.include(targetId)

    // Flush #3: attempts hits MAX_ATTEMPTS=3 → row transitions to terminal 'failed'.
    await client.flush()
    snap = await jsonlStore.list({limit: 100, offset: 0})
    expect(snap.rows[0].status, 'after flush #3: row transitions to terminal failed').to.equal('failed')
    expect(snap.rows[0].attempts, 'after flush #3: attempts=MAX_ATTEMPTS').to.equal(MAX_ATTEMPTS)

    // loadPending now EXCLUDES the row — terminal-failed rows are not retried.
    pending = await jsonlStore.loadPending()
    expect(pending.map((r) => r.id), 'pending after terminal failed must NOT include the row').to.not.include(targetId)

    // The sender saw exactly MAX_ATTEMPTS non-empty inputs (once per flush cycle while pending).
    expect(sender.nonEmptyCallCount, 'sender saw the row exactly MAX_ATTEMPTS times').to.equal(MAX_ATTEMPTS)
  })

  it('should leave terminal failed rows untouched on a 4th updateStatus(failed) — no overshoot', async () => {
    const jsonlStore = new JsonlAnalyticsStore({baseDir})
    const sender = makeAllFailingSender()
    const client = new AnalyticsClient({
      identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
      isEnabled: () => true,
      jsonlStore,
      queue: new BoundedQueue(),
      sender,
      superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
    })

    client.track(AnalyticsEventNames.DAEMON_START)
    await waitForRows(jsonlStore, 1)
    const initial = await jsonlStore.list({limit: 100, offset: 0})
    const {id} = initial.rows[0]

    // Drive the row to terminal 'failed' (3 cycles).
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // eslint-disable-next-line no-await-in-loop
      await client.flush()
    }

    const beforeOvershoot = await jsonlStore.list({limit: 100, offset: 0})
    expect(beforeOvershoot.rows[0].status).to.equal('failed')
    expect(beforeOvershoot.rows[0].attempts).to.equal(MAX_ATTEMPTS)

    // Direct call to updateStatus — what would happen if a stale flush retried.
    await jsonlStore.updateStatus([id], 'failed')
    const afterOvershoot = await jsonlStore.list({limit: 100, offset: 0})
    expect(afterOvershoot.rows[0].status, 'terminal failed stays failed').to.equal('failed')
    expect(afterOvershoot.rows[0].attempts, 'attempts MUST NOT overshoot the cap').to.equal(MAX_ATTEMPTS)
  })

  it('should NOT pull a terminal-failed row back into a subsequent flush', async () => {
    const jsonlStore = new JsonlAnalyticsStore({baseDir})
    const sender = makeAllFailingSender()
    const client = new AnalyticsClient({
      identityResolver: makeStubIdentityResolver(makeAnonIdentity()),
      isEnabled: () => true,
      jsonlStore,
      queue: new BoundedQueue(),
      sender,
      superPropsResolver: makeStubSuperPropsResolver(makeSuperProps()),
    })

    client.track(AnalyticsEventNames.DAEMON_START)
    await waitForRows(jsonlStore, 1)

    // Drive to terminal failed.
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // eslint-disable-next-line no-await-in-loop
      await client.flush()
    }

    expect(sender.nonEmptyCallCount).to.equal(MAX_ATTEMPTS)

    // A 4th flush passes an EMPTY pending set to the sender — the row is not re-shipped.
    await client.flush()
    expect(sender.nonEmptyCallCount, 'flush after terminal must not re-ship the row').to.equal(MAX_ATTEMPTS)
    expect(sender.perCallInputs.at(-1), '4th flush passes [] to sender').to.deep.equal([])

    // Returned batch must be empty.
    const batch = await client.flush()
    expect(batch.events, 'flush over no pending rows yields empty batch').to.deep.equal([])
  })
})
