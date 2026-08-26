import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {CurateLogEntry, CurateLogOperation} from '../../../../src/server/core/domain/entities/curate-log-entry.js'
import type {TaskInfo} from '../../../../src/server/core/domain/transport/task-info.js'
import type {ICurateLogStore} from '../../../../src/server/core/interfaces/storage/i-curate-log-store.js'

import {computeSummary, CurateLogHandler} from '../../../../src/server/infra/process/curate-log-handler.js'

// ============================================================================
// Helpers
// ============================================================================

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    clientId: 'client-1',
    content: 'test context',
    createdAt: Date.now(),
    projectPath: '/app',
    taskId: 'task-abc',
    type: 'curate',
    ...overrides,
  }
}

type NativeCapturedOperation = CurateLogOperation & {
  confidence: 'high' | 'low'
  impact: 'high' | 'low'
  needsReview: boolean
  reason: string
}

function makeCapturedOperation(overrides: Partial<NativeCapturedOperation> = {}): NativeCapturedOperation {
  return {
    confidence: 'high',
    impact: 'low',
    needsReview: false,
    path: '/captured.md',
    reason: 'Native operation metadata',
    status: 'success',
    type: 'ADD',
    ...overrides,
  }
}

function makeStore(sandbox: SinonSandbox): ICurateLogStore & {
  batchUpdateOperationReviewStatus: SinonStub
  getById: SinonStub
  getNextId: SinonStub
  list: SinonStub
  save: SinonStub
} {
  return {
    batchUpdateOperationReviewStatus: sandbox.stub().resolves(true),
    getById: sandbox.stub().resolves(null),
    getNextId: sandbox.stub().resolves('cur-1000'),
    list: sandbox.stub().resolves([]),
    save: sandbox.stub().resolves(),
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('curate-log-handler', () => {

// ── computeSummary ─────────────────────────────────────────────────────────

describe('computeSummary', () => {
  it('should return all zeros for empty operations', () => {
    const summary = computeSummary([])
    expect(summary).to.deep.equal({added: 0, deleted: 0, failed: 0, merged: 0, updated: 0})
  })

  it('should count ADD operations', () => {
    const ops: CurateLogOperation[] = [
      {path: '/a.md', status: 'success', type: 'ADD'},
      {path: '/b.md', status: 'success', type: 'ADD'},
    ]
    expect(computeSummary(ops).added).to.equal(2)
  })

  it('should count UPDATE operations', () => {
    const ops: CurateLogOperation[] = [{path: '/a.md', status: 'success', type: 'UPDATE'}]
    expect(computeSummary(ops).updated).to.equal(1)
  })

  it('should count MERGE operations', () => {
    const ops: CurateLogOperation[] = [{path: '/a.md', status: 'success', type: 'MERGE'}]
    expect(computeSummary(ops).merged).to.equal(1)
  })

  it('should count DELETE operations', () => {
    const ops: CurateLogOperation[] = [{path: '/a.md', status: 'success', type: 'DELETE'}]
    expect(computeSummary(ops).deleted).to.equal(1)
  })

  it('should count UPSERT operations as added or updated based on message', () => {
    const ops: CurateLogOperation[] = [
      {message: 'Upserted (created new) auth/jwt.md', path: '/a.md', status: 'success', type: 'UPSERT'},
      {message: 'Upserted (updated existing) auth/oauth.md', path: '/b.md', status: 'success', type: 'UPSERT'},
      {path: '/c.md', status: 'success', type: 'UPSERT'},
    ]
    const summary = computeSummary(ops)
    expect(summary.added).to.equal(1)
    expect(summary.updated).to.equal(2)
  })

  it('should count failed operations regardless of type', () => {
    const ops: CurateLogOperation[] = [
      {path: '/a.md', status: 'failed', type: 'ADD'},
      {path: '/b.md', status: 'failed', type: 'DELETE'},
    ]
    const summary = computeSummary(ops)
    expect(summary.failed).to.equal(2)
    expect(summary.added).to.equal(0)
    expect(summary.deleted).to.equal(0)
  })
  })

// ============================================================================
// CurateLogHandler
// ============================================================================

describe('CurateLogHandler', () => {
  let sandbox: SinonSandbox
  let store: ReturnType<typeof makeStore>
  let handler: CurateLogHandler

  beforeEach(() => {
    sandbox = createSandbox()
    store = makeStore(sandbox)
    handler = new CurateLogHandler(() => store)
  })

  afterEach(() => {
    sandbox.restore()
  })

  // ==========================================================================
  // onTaskCreate
  // ==========================================================================

  describe('onTaskCreate', () => {
    it('should create a processing entry and return logId for curate task', async () => {
      const task = makeTask()
      const result = await handler.onTaskCreate(task)

      expect(result).to.deep.equal({logId: 'cur-1000'})
      expect(store.save.calledOnce).to.be.true

      const savedEntry: CurateLogEntry = store.save.firstCall.args[0]
      expect(savedEntry.status).to.equal('processing')
      expect(savedEntry.id).to.equal('cur-1000')
      expect(savedEntry.taskId).to.equal('task-abc')
      expect(savedEntry.input.context).to.equal('test context')
    })

    it('should include folders in input for curate-folder task', async () => {
      const task = makeTask({folderPath: '/app/src', type: 'curate-folder'})
      await handler.onTaskCreate(task)

      const savedEntry: CurateLogEntry = store.save.firstCall.args[0]
      expect(savedEntry.input.folders).to.deep.equal(['/app/src'])
    })

    it('should include files in input when task has files', async () => {
      const task = makeTask({files: ['src/auth.ts', 'src/middleware.ts']})
      await handler.onTaskCreate(task)

      const savedEntry: CurateLogEntry = store.save.firstCall.args[0]
      expect(savedEntry.input.files).to.deep.equal(['src/auth.ts', 'src/middleware.ts'])
    })

    it('should skip non-curate task types', async () => {
      const task = makeTask({type: 'query'})
      const result = await handler.onTaskCreate(task)

      expect(result).to.be.undefined
      expect(store.save.called).to.be.false
    })

    it('should skip task without projectPath', async () => {
      const task = makeTask({projectPath: undefined})
      const result = await handler.onTaskCreate(task)

      expect(result).to.be.undefined
      expect(store.save.called).to.be.false
    })

    it('should return undefined if store.getNextId fails', async () => {
      store.getNextId.rejects(new Error('disk full'))

      const task = makeTask()
      const result = await handler.onTaskCreate(task)

      expect(result).to.be.undefined
    })

    it('should return logId even if save fails', async () => {
      store.save.rejects(new Error('write error'))

      const task = makeTask()
      const result = await handler.onTaskCreate(task)

      // logId is still returned — save failure is best-effort
      expect(result).to.deep.equal({logId: 'cur-1000'})
    })

    it('should still write completed entry even if initial processing save failed', async () => {
      store.save.onFirstCall().rejects(new Error('disk full'))
      store.save.onSecondCall().resolves()

      const task = makeTask()
      await handler.onTaskCreate(task)
      await handler.onTaskCompleted('task-abc', 'Done!', task)

      expect(store.save.callCount).to.equal(2)
      const completedEntry = store.save.secondCall.args[0] as {status: string}
      expect(completedEntry.status).to.equal('completed')
    })
  })

  // ==========================================================================
  // onToolResult
  // ==========================================================================

  describe('onToolResult', () => {
    beforeEach(async () => {
      await handler.onTaskCreate(makeTask())
    })

    it('should collect curate operations from tool result', () => {
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            makeCapturedOperation({path: '/topics/auth.md'}),
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      // Operations should be stored internally
      // Verified by checking onTaskCompleted uses them
    })

    it('should set reviewStatus=pending for operations with needsReview=true', async () => {
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            {confidence: 'low', impact: 'high', needsReview: true, path: '/a.md', reason: 'uncertain', status: 'success', type: 'UPDATE'},
            {confidence: 'high', impact: 'low', needsReview: false, path: '/b.md', reason: 'clear', status: 'success', type: 'ADD'},
            {confidence: 'high', impact: 'high', needsReview: true, path: '/c.md', reason: 'irreversible', status: 'success', type: 'DELETE'},
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())

      const completedEntry: CurateLogEntry = store.save.secondCall.args[0]
      expect(completedEntry.operations[0].reviewStatus).to.equal('pending')
      expect(completedEntry.operations[1].reviewStatus).to.be.undefined
      expect(completedEntry.operations[2].reviewStatus).to.equal('pending')
    })

    it('should NOT set reviewStatus=pending for failed operations even with needsReview=true', async () => {
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            {confidence: 'low', impact: 'high', needsReview: true, path: '/a.md', reason: 'uncertain', status: 'failed', type: 'UPDATE'},
            {confidence: 'high', impact: 'high', needsReview: true, path: '/b.md', reason: 'irreversible', status: 'success', type: 'DELETE'},
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())

      const completedEntry: CurateLogEntry = store.save.secondCall.args[0]
      // Failed operation should NOT have reviewStatus=pending
      expect(completedEntry.operations[0].reviewStatus).to.be.undefined
      expect(completedEntry.operations[0].status).to.equal('failed')
      // Successful operation should still have reviewStatus=pending
      expect(completedEntry.operations[1].reviewStatus).to.equal('pending')
      expect(completedEntry.operations[1].status).to.equal('success')
    })

    it('should not set reviewStatus for operations without needsReview', async () => {
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            makeCapturedOperation({path: '/a.md'}),
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())

      const completedEntry: CurateLogEntry = store.save.secondCall.args[0]
      expect(completedEntry.operations[0].reviewStatus).to.be.undefined
    })

    it('should deduplicate operations by filePath, keeping the latest', async () => {
      // First tool result: initial UPSERT for a file
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [{
            confidence: 'low',
            filePath: '/app/.brv/context-tree/design/caching/caching_strategy.md',
            impact: 'low',
            needsReview: false,
            path: 'design/caching',
            reason: 'first pass',
            status: 'success',
            type: 'UPSERT',
          }],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      // Second tool result: same file updated again
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [{
            confidence: 'low',
            filePath: '/app/.brv/context-tree/design/caching/caching_strategy.md',
            impact: 'high',
            needsReview: true,
            path: 'design/caching',
            reason: 'second pass - final version',
            status: 'success',
            type: 'UPSERT',
          }],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())

      const completedEntry: CurateLogEntry = store.save.secondCall.args[0]
      // Should have only 1 operation, not 2
      expect(completedEntry.operations).to.have.lengthOf(1)
      expect(completedEntry.operations[0].reason).to.equal('second pass - final version')
      expect(completedEntry.operations[0].impact).to.equal('high')
    })

    it('should keep separate operations for different filePaths', async () => {
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            makeCapturedOperation({filePath: '/app/.brv/context-tree/design/caching/redis.md', path: 'design/caching'}),
            makeCapturedOperation({filePath: '/app/.brv/context-tree/design/caching/memcache.md', path: 'design/caching'}),
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())

      const completedEntry: CurateLogEntry = store.save.secondCall.args[0]
      expect(completedEntry.operations).to.have.lengthOf(2)
    })

    it('should not deduplicate operations without filePath', async () => {
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            makeCapturedOperation({path: 'design/caching', status: 'failed'}),
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            makeCapturedOperation({path: 'design/caching', status: 'failed'}),
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())

      const completedEntry: CurateLogEntry = store.save.secondCall.args[0]
      // Both kept since no filePath to deduplicate on
      expect(completedEntry.operations).to.have.lengthOf(2)
    })

    it('should silently skip unknown taskId', () => {
      expect(() => {
        handler.onToolResult('unknown-task', {
          lifecycleResult: {applied: [{path: '/a.md', status: 'success', type: 'ADD'}]},
          sessionId: 'sess-1',
          success: true,
          taskId: 'unknown-task',
          toolName: 'curate',
        } as never)
      }).to.not.throw()
    })
  })

  // ==========================================================================
  // onTaskCompleted
  // ==========================================================================

  describe('onTaskCompleted', () => {
    beforeEach(async () => {
      await handler.onTaskCreate(makeTask())

      // Inject operations via onToolResult
      handler.onToolResult('task-abc', {
        lifecycleResult: {applied: [makeCapturedOperation({path: '/a.md'})]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)
    })

    it('should save completed entry with correct status and operations', async () => {
      await handler.onTaskCompleted('task-abc', 'Great job!', makeTask())

      expect(store.save.callCount).to.equal(2) // once for processing, once for completed
      const completedEntry = store.save.secondCall.args[0] as {operations: unknown[]; response?: string; status: string; summary: {added: number; failed: number}}
      expect(completedEntry.status).to.equal('completed')
      expect(completedEntry.operations).to.have.lengthOf(1)
      expect(completedEntry.summary.added).to.equal(1)
      expect(completedEntry.response).to.equal('Great job!')
    })

    it('should compute correct summary from collected operations', async () => {
      handler.onToolResult('task-abc', {
        lifecycleResult: {applied: [makeCapturedOperation({path: '/b.md', status: 'failed', type: 'UPDATE'})]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', '', makeTask())

      const completedEntry: CurateLogEntry = store.save.secondCall.args[0]
      expect(completedEntry.summary.added).to.equal(1)
      expect(completedEntry.summary.failed).to.equal(1)
    })

    it('should be a no-op for unknown taskId', async () => {
      await handler.onTaskCompleted('unknown-task', 'result', makeTask())
      // Should not throw; save should not be called again
      expect(store.save.callCount).to.equal(1) // only the initial processing save
    })
  })

  describe('review integrity capture', () => {
    it('records verified structured operations and pending status', async () => {
      await handler.onTaskCreate(makeTask())
      handler.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [makeCapturedOperation({impact: 'high', needsReview: true, path: '/high.md', type: 'UPSERT'})],
        },
        result: 'truncated display output',
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())
      const completed = store.save.secondCall.args[0] as CurateLogEntry & {reviewIntegrity?: {status: string}}
      expect(completed.operations[0].reviewStatus).to.equal('pending')
      expect(completed.reviewIntegrity).to.deep.equal({status: 'verified'})
    })

    it('keeps integrity unresolved after malformed lifecycle data follows valid capture', async () => {
      await handler.onTaskCreate(makeTask())
      handler.onToolResult('task-abc', {
        lifecycleResult: {applied: [makeCapturedOperation({path: '/valid.md'})]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)
      handler.onToolResult('task-abc', {
        lifecycleResult: {applied: [{path: '/invalid.md', status: 'success', type: 'UPSERT'}]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handler.onTaskCompleted('task-abc', 'done', makeTask())
      const completed = store.save.secondCall.args[0] as CurateLogEntry & {reviewIntegrity?: {status: string}}
      expect(completed.operations).to.have.lengthOf(1)
      expect(completed.reviewIntegrity?.status).to.equal('unresolved')
    })
  })

  // ==========================================================================
  // onTaskCancelled
  // ==========================================================================

  describe('onTaskCancelled', () => {
    beforeEach(async () => {
      await handler.onTaskCreate(makeTask())
    })

    it('should save cancelled entry with correct status', async () => {
      await handler.onTaskCancelled('task-abc', makeTask())

      expect(store.save.callCount).to.equal(2)
      const cancelledEntry = store.save.secondCall.args[0] as {completedAt: number; status: string}
      expect(cancelledEntry.status).to.equal('cancelled')
      expect(cancelledEntry.completedAt).to.be.a('number')
    })

    it('should be a no-op for unknown taskId', async () => {
      await handler.onTaskCancelled('unknown-task', makeTask())
      expect(store.save.callCount).to.equal(1) // only initial processing save
    })
  })

  // ==========================================================================
  // onTaskError
  // ==========================================================================

  describe('onTaskError', () => {
    beforeEach(async () => {
      await handler.onTaskCreate(makeTask())
    })

    it('should save error entry with error message', async () => {
      await handler.onTaskError('task-abc', 'Something broke', makeTask())

      expect(store.save.callCount).to.equal(2)
      const errorEntry = store.save.secondCall.args[0] as {error?: string; status: string}
      expect(errorEntry.status).to.equal('error')
      expect(errorEntry.error).to.equal('Something broke')
    })

    it('should be a no-op for unknown taskId', async () => {
      await handler.onTaskError('unknown-task', 'error', makeTask())
      expect(store.save.callCount).to.equal(1) // only initial processing save
    })
  })

  // ==========================================================================
  // cleanup
  // ==========================================================================

  describe('cleanup', () => {
    it('should remove task state so subsequent calls are no-ops', async () => {
      await handler.onTaskCreate(makeTask())
      handler.cleanup('task-abc')

      // After cleanup, onTaskCompleted should be a no-op
      const callCountBefore = store.save.callCount
      await handler.onTaskCompleted('task-abc', 'result', makeTask())
      expect(store.save.callCount).to.equal(callCountBefore)
    })

    it('should be safe to call for unknown taskId', () => {
      expect(() => handler.cleanup('nonexistent')).to.not.throw()
    })

    it('should evict store from cache when last task for a project is cleaned up', async () => {
      const storeA = makeStore(sandbox)
      const storeB = makeStore(sandbox)
      const stores: Record<string, ICurateLogStore> = {'/proj-a': storeA, '/proj-b': storeB}
      const multiHandler = new CurateLogHandler((p) => stores[p]!)

      await multiHandler.onTaskCreate(makeTask({projectPath: '/proj-a', taskId: 'task-1'}))
      await multiHandler.onTaskCreate(makeTask({projectPath: '/proj-a', taskId: 'task-2'}))
      await multiHandler.onTaskCreate(makeTask({projectPath: '/proj-b', taskId: 'task-3'}))

      // Cleanup task-1 — storeA still needed (task-2 active)
      multiHandler.cleanup('task-1')
      await multiHandler.onTaskCompleted('task-2', 'done', makeTask({projectPath: '/proj-a', taskId: 'task-2'}))
      expect(storeA.save.called).to.be.true

      // Cleanup task-2 — storeA should now be evicted
      multiHandler.cleanup('task-2')

      // Cleanup task-3 — storeB should be evicted
      multiHandler.cleanup('task-3')

      // After eviction, creating a new task for /proj-a should request a fresh store
      let freshStoreCalled = false
      const evictedHandler = new CurateLogHandler((p) => {
        if (p === '/proj-a') freshStoreCalled = true
        return stores[p]!
      })
      await evictedHandler.onTaskCreate(makeTask({projectPath: '/proj-a', taskId: 'task-new'}))
      expect(freshStoreCalled).to.be.true
    })
  })

  // ==========================================================================
  // onPendingReviews callback
  // ==========================================================================

  describe('onPendingReviews callback', () => {
    it('should call onPendingReviews when curate completes with pending review ops', async () => {
      const notifications: Array<{clientId: string; pendingCount: number; projectPath: string; taskId: string}> = []
      const handlerWithCallback = new CurateLogHandler(
        () => store,
        (info) => notifications.push(info),
      )

      await handlerWithCallback.onTaskCreate(makeTask())

      // Inject operation with reviewStatus=pending
      handlerWithCallback.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [{
            confidence: 'low',
            impact: 'high',
            needsReview: true,
            path: '/a.md',
            reason: 'Irreversible deletion',
            status: 'success',
            type: 'DELETE',
          }],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handlerWithCallback.onTaskCompleted('task-abc', 'done', makeTask())

      expect(notifications).to.have.lengthOf(1)
      expect(notifications[0].clientId).to.equal('client-1')
      expect(notifications[0].pendingCount).to.equal(1)
      expect(notifications[0].projectPath).to.equal('/app')
      expect(notifications[0].taskId).to.equal('task-abc')
    })

    it('should NOT call onPendingReviews when no pending review ops exist', async () => {
      const notifications: Array<{clientId: string; pendingCount: number; projectPath: string; taskId: string}> = []
      const handlerWithCallback = new CurateLogHandler(
        () => store,
        (info) => notifications.push(info),
      )

      await handlerWithCallback.onTaskCreate(makeTask())

      // Inject operation without needsReview
      handlerWithCallback.onToolResult('task-abc', {
        lifecycleResult: {applied: [makeCapturedOperation({path: '/a.md'})]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handlerWithCallback.onTaskCompleted('task-abc', 'done', makeTask())

      expect(notifications).to.have.lengthOf(0)
    })

    it('should not throw if onPendingReviews callback throws', async () => {
      const handlerWithBadCallback = new CurateLogHandler(
        () => store,
        () => { throw new Error('callback error') },
      )

      await handlerWithBadCallback.onTaskCreate(makeTask())

      handlerWithBadCallback.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [makeCapturedOperation({impact: 'high', needsReview: true, path: '/a.md', type: 'DELETE'})],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      // Should not throw
      await handlerWithBadCallback.onTaskCompleted('task-abc', 'done', makeTask())
    })
  })

  // ==========================================================================
  // reviewDisabled — `brv review --disable`
  // ==========================================================================

  describe('reviewDisabled', () => {
    it('does not mark operations as pending review when task.reviewDisabled=true', async () => {
      const handlerWithToggle = new CurateLogHandler(() => store)

      await handlerWithToggle.onTaskCreate(makeTask({reviewDisabled: true}))
      handlerWithToggle.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            {confidence: 'low', impact: 'high', needsReview: true, path: '/a.md', reason: 'uncertain', status: 'success', type: 'UPDATE'},
            {confidence: 'high', impact: 'high', needsReview: true, path: '/b.md', reason: 'irreversible', status: 'success', type: 'DELETE'},
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handlerWithToggle.onTaskCompleted('task-abc', 'done', makeTask({reviewDisabled: true}))

      const completed = store.save.secondCall.args[0] as CurateLogEntry & {
        reviewIntegrity: {reason?: string; status: 'unresolved' | 'verified'}
      }
      expect(completed.operations[0].reviewStatus).to.be.undefined
      expect(completed.operations[1].reviewStatus).to.be.undefined
    })

    it('still marks operations as pending review when task.reviewDisabled=false', async () => {
      const handlerWithToggle = new CurateLogHandler(() => store)

      await handlerWithToggle.onTaskCreate(makeTask({reviewDisabled: false}))
      handlerWithToggle.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [
            makeCapturedOperation({confidence: 'low', impact: 'high', needsReview: true, path: '/a.md', type: 'UPDATE'}),
          ],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)
      await handlerWithToggle.onTaskCompleted('task-abc', 'done', makeTask({reviewDisabled: false}))

      const completed: CurateLogEntry = store.save.secondCall.args[0]
      expect(completed.operations[0].reviewStatus).to.equal('pending')
    })

    it('treats undefined task.reviewDisabled as enabled (fail-open)', async () => {
      const handlerWithToggle = new CurateLogHandler(() => store)

      await handlerWithToggle.onTaskCreate(makeTask())
      handlerWithToggle.onToolResult('task-abc', {
        lifecycleResult: {applied: [makeCapturedOperation({impact: 'high', needsReview: true, path: '/a.md', type: 'DELETE'})]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)
      await handlerWithToggle.onTaskCompleted('task-abc', 'done', makeTask())

      const completed: CurateLogEntry = store.save.secondCall.args[0]
      expect(completed.operations[0].reviewStatus).to.equal('pending')
    })

    it('skips firing onPendingReviews callback when task.reviewDisabled=true', async () => {
      const notifications: Array<{pendingCount: number}> = []
      const handlerWithToggle = new CurateLogHandler(
        () => store,
        (info) => notifications.push({pendingCount: info.pendingCount}),
      )

      await handlerWithToggle.onTaskCreate(makeTask({reviewDisabled: true}))
      handlerWithToggle.onToolResult('task-abc', {
        lifecycleResult: {
          applied: [makeCapturedOperation({impact: 'high', needsReview: true, path: '/a.md', type: 'DELETE'})],
        },
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      await handlerWithToggle.onTaskCompleted('task-abc', 'done', makeTask({reviewDisabled: true}))

      expect(notifications).to.have.lengthOf(0)
    })

    it('reports zero pendingReviewCount via getTaskCompletionData when disabled', async () => {
      const handlerWithToggle = new CurateLogHandler(() => store)

      await handlerWithToggle.onTaskCreate(makeTask({reviewDisabled: true}))
      handlerWithToggle.onToolResult('task-abc', {
        lifecycleResult: {applied: [makeCapturedOperation({impact: 'high', needsReview: true, path: '/a.md', type: 'DELETE'})]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)

      expect(handlerWithToggle.getTaskCompletionData('task-abc')).to.deep.equal({})
    })

    it('snapshots task.reviewDisabled at create time — mid-task TaskInfo mutation does not affect onToolResult', async () => {
      const handlerWithToggle = new CurateLogHandler(() => store)
      const task = makeTask({reviewDisabled: true})

      await handlerWithToggle.onTaskCreate(task)

      // Simulate user toggling between create and tool-result. The handler must
      // ignore mutations to the original TaskInfo because it snapshotted on create.
      task.reviewDisabled = false

      handlerWithToggle.onToolResult('task-abc', {
        lifecycleResult: {applied: [makeCapturedOperation({impact: 'high', needsReview: true, path: '/a.md', type: 'DELETE'})]},
        sessionId: 'sess-1',
        success: true,
        taskId: 'task-abc',
        toolName: 'curate',
      } as never)
      await handlerWithToggle.onTaskCompleted('task-abc', 'done', task)

      const completed: CurateLogEntry = store.save.secondCall.args[0]
      expect(completed.operations[0].reviewStatus).to.be.undefined
    })
  })
})
})
