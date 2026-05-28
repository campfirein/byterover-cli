import {expect} from 'chai'
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import type {IAnalyticsClient} from '../../../../../src/server/core/interfaces/analytics/i-analytics-client.js'
import type {AnalyticsEventName} from '../../../../../src/shared/analytics/event-names.js'
import type {PropsArg} from '../../../../../src/shared/analytics/events/index.js'
import type {MigrateRunProps} from '../../../../../src/shared/analytics/events/migrate-run.js'
import type {MigrateRollbackResponse, MigrateRunResponse} from '../../../../../src/shared/transport/events/migrate-events.js'

import {AnalyticsBatch} from '../../../../../src/server/core/domain/analytics/batch.js'
import {
  ARCHIVE_FOLDER_PREFIX,
  BRV_DIR,
  CONTEXT_TREE_DIR,
  MIGRATIONS_DIR,
} from '../../../../../src/server/infra/migrate/constants.js'
import {MigrateHandler} from '../../../../../src/server/infra/transport/handlers/migrate-handler.js'
import {AnalyticsEventNames} from '../../../../../src/shared/analytics/event-names.js'
import {MigrateEvents} from '../../../../../src/shared/transport/events/migrate-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

type TrackCall = {event: AnalyticsEventName; properties: unknown}

type MockAnalyticsClient = IAnalyticsClient & {
  readonly trackCalls: readonly TrackCall[]
  trackThrows?: Error
}

/**
 * Hand-rolled mock preserving `track<E>(event, ...rest: PropsArg<E>)` generics.
 * Mirrors the pattern from `analytics-handler.test.ts` so sinon's collapsed
 * SinonStub overload doesn't fight the IAnalyticsClient contract.
 */
function makeMockAnalyticsClient(): MockAnalyticsClient {
  const trackCalls: TrackCall[] = []
  const mock: MockAnalyticsClient = {
    abort(): void {
      /* not exercised */
    },
    flush: () => Promise.resolve(AnalyticsBatch.create([])),
    getRuntimeState: () => Promise.resolve({droppedCount: 0, lastSuccessfulFlushAt: undefined, queueDepth: 0}),
    onAuthTransition: () => Promise.resolve(),
    track<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
      if (mock.trackThrows) throw mock.trackThrows
      const [properties] = rest
      trackCalls.push({event, properties})
    },
    trackCalls,
  }
  return mock
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

function isMigrateRunProps(value: unknown): value is MigrateRunProps {
  return typeof value === 'object' && value !== null && 'mode' in value && 'outcome' in value
}

function findMigrateRunEmits(client: MockAnalyticsClient): MigrateRunProps[] {
  const out: MigrateRunProps[] = []
  for (const call of client.trackCalls) {
    if (call.event !== AnalyticsEventNames.MIGRATE_RUN) continue
    if (!isMigrateRunProps(call.properties)) continue
    out.push(call.properties)
  }

  return out
}

describe('MigrateHandler analytics emits', () => {
  let transport: MockTransportServer
  let analyticsClient: MockAnalyticsClient
  let projectRoot: string

  beforeEach(() => {
    transport = createMockTransportServer()
    analyticsClient = makeMockAnalyticsClient()
    projectRoot = mkdtempSync(join(tmpdir(), 'brv-migrate-handler-analytics-'))
    new MigrateHandler({
      analyticsClient,
      resolveProjectPath: () => projectRoot,
      transport,
    }).setup()
  })

  afterEach(() => {
    rmSync(projectRoot, {force: true, recursive: true})
  })

  describe('forward path (migrate:run)', () => {
    it('emits migrate_run outcome=success with forward counters on a clean project', async () => {
      const handler = transport._handlers.get(MigrateEvents.RUN)
      if (handler === undefined) throw new Error('migrate:run handler not registered')

      await handler({dryRun: true}, 'client-1')

      const emits = findMigrateRunEmits(analyticsClient)
      expect(emits.length).to.equal(1)
      const [props] = emits
      if (props.mode !== 'forward') throw new Error(`expected forward, got ${props.mode}`)
      expect(props.outcome).to.equal('success')
      expect(props.dry_run).to.equal(true)
      expect(props.migrated).to.equal(0)
      expect(props.archived).to.equal(0)
      expect(props.skipped).to.equal(0)
      expect(props.failed).to.equal(0)
    })

    it('emits migrate_run outcome=failure with failure_kind when orchestrator throws (archive already exists)', async () => {
      mkdirSync(join(projectRoot, BRV_DIR, CONTEXT_TREE_DIR), {recursive: true})
      mkdirSync(
        join(projectRoot, BRV_DIR, MIGRATIONS_DIR, `${ARCHIVE_FOLDER_PREFIX}${todayUtc()}`),
        {recursive: true},
      )

      const handler = transport._handlers.get(MigrateEvents.RUN)
      if (handler === undefined) throw new Error('migrate:run handler not registered')

      let caught: unknown
      try {
        await handler({dryRun: false}, 'client-1')
      } catch (error) {
        caught = error
      }

      expect(caught, 'orchestrator throw must propagate').to.be.instanceOf(Error)

      const emits = findMigrateRunEmits(analyticsClient)
      expect(emits.length).to.equal(1)
      const [props] = emits
      if (props.mode !== 'forward') throw new Error(`expected forward, got ${props.mode}`)
      expect(props.outcome).to.equal('failure')
      expect(props.dry_run).to.equal(false)
      expect(props.failure_kind).to.be.a('string').and.not.empty
    })
  })

  describe('rollback path (migrate:rollback)', () => {
    it('emits migrate_run outcome=success with rollback counters when an archive exists', async () => {
      mkdirSync(
        join(projectRoot, BRV_DIR, MIGRATIONS_DIR, `${ARCHIVE_FOLDER_PREFIX}${todayUtc()}`),
        {recursive: true},
      )

      const handler = transport._handlers.get(MigrateEvents.ROLLBACK)
      if (handler === undefined) throw new Error('migrate:rollback handler not registered')

      await handler({dryRun: true}, 'client-1')

      const emits = findMigrateRunEmits(analyticsClient)
      expect(emits.length).to.equal(1)
      const [props] = emits
      if (props.mode !== 'rollback') throw new Error(`expected rollback, got ${props.mode}`)
      expect(props.outcome).to.equal('success')
      expect(props.dry_run).to.equal(true)
      expect(props.restored).to.equal(0)
      expect(props.deleted_html).to.equal(0)
      expect(props.preserved_html).to.equal(0)
    })

    it('emits migrate_run outcome=failure with failure_kind when no archive exists', async () => {
      const handler = transport._handlers.get(MigrateEvents.ROLLBACK)
      if (handler === undefined) throw new Error('migrate:rollback handler not registered')

      let caught: unknown
      try {
        await handler({dryRun: true}, 'client-1')
      } catch (error) {
        caught = error
      }

      expect(caught, 'orchestrator throw must propagate').to.be.instanceOf(Error)

      const emits = findMigrateRunEmits(analyticsClient)
      expect(emits.length).to.equal(1)
      const [props] = emits
      if (props.mode !== 'rollback') throw new Error(`expected rollback, got ${props.mode}`)
      expect(props.outcome).to.equal('failure')
      expect(props.dry_run).to.equal(true)
      expect(props.failure_kind).to.be.a('string').and.not.empty
    })
  })

  describe('no-op when analyticsClient is not injected', () => {
    it('does not throw and does not call track on either path', async () => {
      const localTransport = createMockTransportServer()
      const localAnalyticsClient = makeMockAnalyticsClient()
      new MigrateHandler({
        resolveProjectPath: () => projectRoot,
        transport: localTransport,
      }).setup()

      const handler = localTransport._handlers.get(MigrateEvents.RUN)
      if (handler === undefined) throw new Error('migrate:run handler not registered')

      await handler({dryRun: true}, 'client-1')
      expect(localAnalyticsClient.trackCalls).to.have.lengthOf(0)
    })
  })

  describe('analytics throw never propagates to caller', () => {
    it('forward path returns a normal report even if track() throws', async () => {
      analyticsClient.trackThrows = new Error('analytics down')

      const handler = transport._handlers.get(MigrateEvents.RUN)
      if (handler === undefined) throw new Error('migrate:run handler not registered')

      const response: MigrateRollbackResponse | MigrateRunResponse = await handler(
        {dryRun: true},
        'client-1',
      )

      if (!('report' in response)) throw new Error('expected a forward report on success')
      expect(response.report.summary).to.exist
    })
  })
})
