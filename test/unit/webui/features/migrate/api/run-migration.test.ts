import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {BrvApiClient} from '../../../../../../src/webui/lib/api-client.js'

import {MigrateEvents} from '../../../../../../src/shared/transport/events/migrate-events.js'
import {runMigration} from '../../../../../../src/webui/features/migrate/api/run-migration.js'
import {useTransportStore} from '../../../../../../src/webui/stores/transport-store.js'

describe('runMigration', () => {
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

  it('emits migrate:run with dryRun:false', async () => {
    request.resolves({
      report: {
        archiveRoot: '/tmp/proj/.brv/_migrations/x',
        completedAt: '2026-05-29T00:00:00Z',
        dryRun: false,
        files: [],
        projectRoot: '/tmp/proj',
        startedAt: '2026-05-29T00:00:00Z',
        summary: {archived: 1, failed: 0, migrated: 1, skipped: 0},
      },
    })
    await runMigration()
    expect(request.firstCall.args[0]).to.equal(MigrateEvents.RUN)
    expect(request.firstCall.args[1]).to.deep.equal({dryRun: false})
  })

  it('rejects when not connected', async () => {
    useTransportStore.setState({apiClient: null})
    try {
      await runMigration()
      expect.fail('expected to reject')
    } catch (error) {
      expect((error as Error).message).to.equal('Not connected')
    }
  })
})
