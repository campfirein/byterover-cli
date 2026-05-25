import type {SinonStub} from 'sinon'

import {expect} from 'chai'
import {join} from 'node:path'
import {restore, stub} from 'sinon'

import type {CurateLogEntry} from '../../../../../src/server/core/domain/entities/curate-log-entry.js'
import type {ICurateLogStore} from '../../../../../src/server/core/interfaces/storage/i-curate-log-store.js'
import type {IProjectConfigStore} from '../../../../../src/server/core/interfaces/storage/i-project-config-store.js'
import type {IReviewBackupStore} from '../../../../../src/server/core/interfaces/storage/i-review-backup-store.js'

import {BRV_CONFIG_VERSION, BRV_DIR, CONTEXT_TREE_DIR} from '../../../../../src/server/constants.js'
import {BrvConfig} from '../../../../../src/server/core/domain/entities/brv-config.js'
import {ReviewHandler} from '../../../../../src/server/infra/transport/handlers/review-handler.js'
import {
  type AgentChangeOperation,
  ReviewEvents,
  type ReviewListOperationsResponse,
} from '../../../../../src/shared/transport/events/review-events.js'
import {createMockTransportServer, type MockTransportServer} from '../../../../helpers/mock-factories.js'

function makeEntry(args: {
  id: string
  operations: CurateLogEntry['operations']
  startedAt: number
  taskId: string
}): CurateLogEntry {
  return {
    completedAt: args.startedAt + 1000,
    id: args.id,
    input: {context: 'test'},
    operations: args.operations,
    startedAt: args.startedAt,
    status: 'completed',
    summary: {added: 0, deleted: 0, failed: 0, merged: 0, updated: 0},
    taskId: args.taskId,
  }
}

describe('ReviewHandler — review:listOperations', () => {
  const projectPath = '/test/project'
  const contextTreeDir = join(projectPath, BRV_DIR, CONTEXT_TREE_DIR)

  let resolveProjectPath: SinonStub
  let transport: MockTransportServer
  let projectConfigStore: Partial<IProjectConfigStore> & {read: SinonStub; write: SinonStub}
  let curateLogStoreFactory: SinonStub
  let reviewBackupStoreFactory: SinonStub
  let curateLogStore: {list: SinonStub}

  beforeEach(() => {
    resolveProjectPath = stub().returns(projectPath)
    transport = createMockTransportServer()
    projectConfigStore = {
      read: stub(),
      write: stub().resolves(),
    }
    curateLogStore = {list: stub()}
    curateLogStoreFactory = stub().returns(curateLogStore as unknown as ICurateLogStore)
    reviewBackupStoreFactory = stub().returns({} as IReviewBackupStore)
  })

  afterEach(() => {
    restore()
  })

  function createHandler(): ReviewHandler {
    const handler = new ReviewHandler({
      curateLogStoreFactory,
      projectConfigStore: projectConfigStore as IProjectConfigStore,
      resolveProjectPath,
      reviewBackupStoreFactory,
      transport,
    })
    handler.setup()
    return handler
  }

  async function callListOperations(clientId = 'client-1'): Promise<ReviewListOperationsResponse> {
    const handler = transport._handlers.get(ReviewEvents.LIST_OPERATIONS)
    expect(handler, 'review:listOperations handler should be registered').to.exist
    return handler!({}, clientId) as Promise<ReviewListOperationsResponse>
  }

  describe('setup', () => {
    it('registers the review:listOperations handler', () => {
      createHandler()
      expect(transport._handlers.has(ReviewEvents.LIST_OPERATIONS)).to.be.true
    })
  })

  describe('handleListOperations', () => {
    it('returns empty operations when reviewDisabled is true', async () => {
      projectConfigStore.read.resolves(
        new BrvConfig({createdAt: '2025-01-01T00:00:00.000Z', cwd: projectPath, reviewDisabled: true, version: BRV_CONFIG_VERSION}),
      )
      curateLogStore.list.resolves([])
      createHandler()

      const response = await callListOperations()
      expect(response.operations).to.deep.equal([])
    })

    it('returns empty operations and does not call store when reviewDisabled is true', async () => {
      projectConfigStore.read.resolves(
        new BrvConfig({createdAt: '2025-01-01T00:00:00.000Z', cwd: projectPath, reviewDisabled: true, version: BRV_CONFIG_VERSION}),
      )
      createHandler()

      await callListOperations()
      expect(curateLogStore.list.called, 'store.list should be skipped when review is disabled').to.be.false
    })

    it('returns all completed operations when review is enabled', async () => {
      projectConfigStore.read.resolves(BrvConfig.createLocal({cwd: projectPath}))
      curateLogStore.list.resolves([
        makeEntry({
          id: 'cur-1',
          operations: [
            {
              filePath: join(contextTreeDir, 'architecture/daemon/lifecycle.md'),
              impact: 'high',
              path: 'architecture/daemon/lifecycle',
              reason: 'Consolidates duplicated logic',
              reviewStatus: 'pending',
              status: 'success',
              summary: 'Lifecycle docs updated',
              type: 'MERGE',
            },
            {
              filePath: join(contextTreeDir, 'architecture/daemon/notes.md'),
              impact: 'low',
              path: 'architecture/daemon/notes',
              reason: 'Minor wording fix',
              status: 'success',
              summary: 'Wording fix',
              type: 'UPSERT',
            },
          ],
          startedAt: 100,
          taskId: 'task-abc',
        }),
      ])
      createHandler()

      const response = await callListOperations()
      expect(response.operations).to.have.lengthOf(2)
      expect(response.operations[0]).to.deep.include({
        filePath: 'architecture/daemon/lifecycle.md',
        impact: 'high',
        opCreatedAt: 100,
        reason: 'Consolidates duplicated logic',
        reviewStatus: 'pending',
        summary: 'Lifecycle docs updated',
        taskId: 'task-abc',
        type: 'MERGE',
      } satisfies AgentChangeOperation)
      expect(response.operations[1]).to.deep.include({
        filePath: 'architecture/daemon/notes.md',
        impact: 'low',
        opCreatedAt: 100,
        reason: 'Minor wording fix',
        summary: 'Wording fix',
        taskId: 'task-abc',
        type: 'UPSERT',
      })
    })

    it('skips operations without filePath', async () => {
      projectConfigStore.read.resolves(BrvConfig.createLocal({cwd: projectPath}))
      curateLogStore.list.resolves([
        makeEntry({
          id: 'cur-1',
          operations: [
            {
              path: 'no-file-path',
              status: 'success',
              type: 'ADD',
            },
          ],
          startedAt: 100,
          taskId: 'task-abc',
        }),
      ])
      createHandler()

      const response = await callListOperations()
      expect(response.operations).to.deep.equal([])
    })

    it('skips operations whose filePath is outside the context tree', async () => {
      projectConfigStore.read.resolves(BrvConfig.createLocal({cwd: projectPath}))
      curateLogStore.list.resolves([
        makeEntry({
          id: 'cur-1',
          operations: [
            {
              filePath: '/some/other/place/foo.md',
              path: 'foo',
              status: 'success',
              type: 'UPSERT',
            },
          ],
          startedAt: 100,
          taskId: 'task-abc',
        }),
      ])
      createHandler()

      const response = await callListOperations()
      expect(response.operations).to.deep.equal([])
    })

    it('skips failed operations', async () => {
      projectConfigStore.read.resolves(BrvConfig.createLocal({cwd: projectPath}))
      curateLogStore.list.resolves([
        makeEntry({
          id: 'cur-1',
          operations: [
            {
              filePath: join(contextTreeDir, 'foo.md'),
              path: 'foo',
              status: 'failed',
              type: 'UPSERT',
            },
          ],
          startedAt: 100,
          taskId: 'task-abc',
        }),
      ])
      createHandler()

      const response = await callListOperations()
      expect(response.operations).to.deep.equal([])
    })

    it('flattens operations across multiple entries and preserves opCreatedAt per entry', async () => {
      projectConfigStore.read.resolves(BrvConfig.createLocal({cwd: projectPath}))
      curateLogStore.list.resolves([
        makeEntry({
          id: 'cur-2',
          operations: [
            {
              filePath: join(contextTreeDir, 'b.md'),
              path: 'b',
              status: 'success',
              type: 'UPSERT',
            },
          ],
          startedAt: 200,
          taskId: 'task-2',
        }),
        makeEntry({
          id: 'cur-1',
          operations: [
            {
              filePath: join(contextTreeDir, 'a.md'),
              path: 'a',
              status: 'success',
              type: 'UPSERT',
            },
          ],
          startedAt: 100,
          taskId: 'task-1',
        }),
      ])
      createHandler()

      const response = await callListOperations()
      expect(response.operations).to.have.lengthOf(2)
      const byPath = new Map(response.operations.map((op) => [op.filePath, op]))
      expect(byPath.get('b.md')?.opCreatedAt).to.equal(200)
      expect(byPath.get('a.md')?.opCreatedAt).to.equal(100)
    })

    it('throws when project is not initialized', async () => {
      projectConfigStore.read.resolves()
      createHandler()

      let threw = false
      try {
        await callListOperations()
      } catch (error) {
        threw = true
        expect(String(error)).to.match(/not initialized/i)
      }

      expect(threw, 'should throw when config is missing').to.be.true
    })
  })
})
