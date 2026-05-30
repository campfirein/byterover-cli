import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {MigrateEvents, type MigrateRunReport} from '../../../../../../src/shared/transport/events/migrate-events.js'
import {checkMigrationNeeded} from '../../../../../../src/webui/features/migrate/api/check-migration-needed.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

function buildReport(overrides: Partial<MigrateRunReport['summary']> = {}): MigrateRunReport {
  return {
    archiveRoot: undefined,
    completedAt: '2026-05-29T00:00:00Z',
    dryRun: true,
    files: [],
    projectRoot: '/tmp/proj',
    startedAt: '2026-05-29T00:00:00Z',
    summary: {archived: 0, failed: 0, migrated: 0, skipped: 0, ...overrides},
  }
}

describe('checkMigrationNeeded', () => {
  let sandbox: SinonSandbox
  let request: SinonStub

  beforeEach(() => {
    sandbox = createSandbox()
    request = sandbox.stub()
    useTransportStore.setState({
      apiClient: {on: sandbox.stub(), request} as unknown as BrvApiClient,
    })
  })

  afterEach(() => {
    sandbox.restore()
    useTransportStore.setState({apiClient: null})
  })

  it('emits migrate:run with dryRun:true', async () => {
    request.resolves({report: buildReport()})
    await checkMigrationNeeded()
    expect(request.firstCall.args[0]).to.equal(MigrateEvents.RUN)
    expect(request.firstCall.args[1]).to.deep.equal({dryRun: true})
  })

  it('returns needed=true when migrated > 0', async () => {
    request.resolves({report: buildReport({migrated: 42})})
    const result = await checkMigrationNeeded()
    expect(result.needed).to.equal(true)
    expect(result.migratedCount).to.equal(42)
  })

  it('returns needed=false when migrated === 0', async () => {
    request.resolves({report: buildReport({migrated: 0, skipped: 99})})
    const result = await checkMigrationNeeded()
    expect(result.needed).to.equal(false)
    expect(result.migratedCount).to.equal(0)
  })

  it('rejects when not connected', async () => {
    useTransportStore.setState({apiClient: null})
    try {
      await checkMigrationNeeded()
      expect.fail('expected to reject')
    } catch (error) {
      expect((error as Error).message).to.equal('Not connected')
    }
  })
})
