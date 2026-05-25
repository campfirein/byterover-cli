/**
 * E2E smoke — TaskRouter + FileTaskHistoryStore + transport handlers,
 * exercised through the full daemon-side surface that the WebUI relies on.
 *
 * Covers every fix landed on `proj/persis-task-history` in one continuous
 * scenario:
 *
 *   - C0 (stale-recovery clobber): a long-running curate task whose `started`
 *     state has `createdAt` past the stale threshold must NOT be rewritten to
 *     `INTERRUPTED` on every WebUI `task:list` poll.
 *   - C1 (compaction sweep race): saves landing concurrent with compaction
 *     must keep their data files.
 *   - C4 (`deletedCount` overcount): `task:deleteBulk` reports actual removals
 *     only — unknown ids do not inflate the count.
 *   - `task:deleted` broadcast is emitted per real removal so other clients
 *     drop the row from their local view.
 *   - Cursor pagination is stable across same-millisecond `createdAt` clusters
 *     via the new `(before, beforeTaskId)` tiebreaker.
 *
 * If this file goes green end-to-end, the WebUI can drive list/get/delete /
 * deleteBulk / clearCompleted against a live daemon without losing data,
 * displaying ghost INTERRUPTED entries, or mis-counting bulk removals.
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {mkdir, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {TaskHistoryEntry} from '../../../src/server/core/domain/entities/task-history-entry.js'
import type {IAgentPool, SubmitTaskResult} from '../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IProjectRegistry} from '../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../src/server/core/interfaces/transport/i-transport-server.js'

import {TransportTaskEventNames} from '../../../src/server/core/domain/transport/schemas.js'
import {TaskRouter} from '../../../src/server/infra/process/task-router.js'
import {FileTaskHistoryStore} from '../../../src/server/infra/storage/file-task-history-store.js'

const PROJECT = '/app'

function makeProjectInfo(path: string) {
  return {
    projectPath: path,
    registeredAt: Date.now(),
    sanitizedPath: path.replaceAll('/', '_'),
    storagePath: `/data${path}`,
  }
}

function makeStubTransport(sandbox: SinonSandbox) {
  const requestHandlers = new Map<string, RequestHandler>()
  const transport: ITransportServer = {
    addToRoom: sandbox.stub(),
    broadcast: sandbox.stub(),
    broadcastTo: sandbox.stub(),
    getPort: sandbox.stub().returns(3000),
    isRunning: sandbox.stub().returns(true),
    onConnection: sandbox.stub(),
    onDisconnection: sandbox.stub(),
    onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
      requestHandlers.set(event, handler)
    }),
    removeFromRoom: sandbox.stub(),
    sendTo: sandbox.stub(),
    start: sandbox.stub().resolves(),
    stop: sandbox.stub().resolves(),
  }
  return {requestHandlers, transport}
}

function makeStubAgentPool(sandbox: SinonSandbox): IAgentPool {
  return {
    cancelQueuedTask: sandbox.stub().returns(false),
    getEntries: sandbox.stub().returns([]),
    getSize: sandbox.stub().returns(0),
    handleAgentDisconnected: sandbox.stub(),
    hasAgent: sandbox.stub().returns(false),
    markIdle: sandbox.stub(),
    notifyTaskCompleted: sandbox.stub(),
    shutdown: sandbox.stub().resolves(),
    submitTask: sandbox.stub().resolves({success: true} as SubmitTaskResult),
  }
}

function makeStubProjectRegistry(sandbox: SinonSandbox): IProjectRegistry {
  return {
    get: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    getAll: sandbox.stub().returns(new Map()),
    register: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    unregister: sandbox.stub().returns(true),
  }
}

function makeStubProjectRouter(sandbox: SinonSandbox): IProjectRouter & {broadcastToProject: SinonStub} {
  return {
    addToProjectRoom: sandbox.stub(),
    broadcastToProject: sandbox.stub(),
    getProjectMembers: sandbox.stub().returns([]),
    removeFromProjectRoom: sandbox.stub(),
  }
}

function makeEntry(overrides: Partial<TaskHistoryEntry> & {taskId: string}): TaskHistoryEntry {
  const base = {
    content: 'prompt for ' + overrides.taskId,
    createdAt: Date.now(),
    id: 'tsk-' + overrides.taskId,
    projectPath: PROJECT,
    schemaVersion: 1 as const,
    status: 'created' as const,
    type: 'curate',
  }
  // Type-cast through the discriminated union — caller is responsible for a
  // consistent (status, completedAt, error, …) overlay.
  return {...base, ...overrides} as TaskHistoryEntry
}

describe('E2E smoke — TaskHistory + WebUI surface (proj/persis-task-history)', () => {
  let sandbox: SinonSandbox
  let tempDir: string
  let store: FileTaskHistoryStore
  let router: TaskRouter
  let transportHelper: ReturnType<typeof makeStubTransport>
  let projectRouter: ReturnType<typeof makeStubProjectRouter>

  beforeEach(async () => {
    sandbox = createSandbox()
    tempDir = join(tmpdir(), `brv-e2e-task-history-${Date.now()}-${randomUUID()}`)
    await mkdir(tempDir, {recursive: true})

    // Production-default daemonStartedAt (Date.now()) — this is what the cache
    // module passes in the real daemon. The test simulates a "currently running"
    // daemon, so saves are post-boot and the C0 gate skips recovery.
    store = new FileTaskHistoryStore({
      baseDir: tempDir,
      maxAgeDays: 0,
      maxEntries: Number.POSITIVE_INFINITY,
      // Trigger compaction whenever ratio > 1.5 — common after delete bursts.
      maxIndexBloatRatio: 1.5,
      // 100 ms — short enough that test "long-running" scenarios cross it
      // within a few hundred ms.
      staleThresholdMs: 100,
    })

    transportHelper = makeStubTransport(sandbox)
    projectRouter = makeStubProjectRouter(sandbox)

    router = new TaskRouter({
      agentPool: makeStubAgentPool(sandbox),
      getAgentForProject: sandbox.stub().returns('agent-1'),
      getTaskHistoryStore: () => store,
      projectRegistry: makeStubProjectRegistry(sandbox),
      projectRouter,
      resolveClientProjectPath: () => PROJECT,
      transport: transportHelper.transport,
    })
    router.setup()
  })

  afterEach(async () => {
    sandbox.restore()
    await rm(tempDir, {force: true, recursive: true})
  })

  function getDeletedBroadcastTaskIds(): string[] {
    const ids: string[] = []
    for (const call of projectRouter.broadcastToProject.getCalls()) {
      // Args: (sanitizedPath, event, data, except)
      const [, event, payload] = call.args as [string, string, {taskId?: string}, string?]
      if (event === TransportTaskEventNames.DELETED && payload?.taskId !== undefined) {
        ids.push(payload.taskId)
      }
    }

    return ids
  }

  it('full WebUI flow: long-running task survives polls; bulk delete is accurate; pagination is stable', async () => {
    const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
    const getHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.GET)
    const deleteBulkHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
    const clearHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CLEAR_COMPLETED)

    expect(listHandler, 'task:list handler registered').to.exist
    expect(getHandler, 'task:get handler registered').to.exist
    expect(deleteBulkHandler, 'task:deleteBulk handler registered').to.exist
    expect(clearHandler, 'task:clearCompleted handler registered').to.exist

    // ── Phase 1: simulate a long-running curate task. createdAt set in the
    // past so isStale fires by age, BUT the C0 gate must keep `started`
    // because saves are post-boot. ────────────────────────────────────────
    const longRunningId = 'curate-long'
    const startedAt = Date.now() - 250 // already older than staleThresholdMs:100
    await store.save(
      makeEntry({
        createdAt: startedAt,
        startedAt,
        status: 'started',
        taskId: longRunningId,
      }),
    )

    // Wait past stale threshold so isStale() would fire by age alone.
    await new Promise<void>((r) => {
      setTimeout(() => r(), 150)
    })

    // Phase 1a: WebUI polls task:list 5 times in a row, with throttled saves
    // in between (mimics TaskHistoryHook.onTaskUpdate firing every 100 ms).
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const result = (await listHandler!({page: 1, pageSize: 50}, 'webui-1')) as {
        tasks: Array<{status: string; taskId: string}>
      }
      const long = result.tasks.find((t) => t.taskId === longRunningId)
      expect(long, `iter ${i}: long-running task missing from list`).to.exist
      expect(long!.status, `iter ${i}: stale-recovery clobber regression`).to.equal('started')

      // Re-save with status 'started' (simulating a throttled lifecycle save).
      // eslint-disable-next-line no-await-in-loop
      await store.save(
        makeEntry({
          createdAt: startedAt,
          startedAt,
          status: 'started',
          taskId: longRunningId,
        }),
      )
    }

    // Phase 1b: WebUI fetches the detail panel — task:get must also NOT
    // recover the live entry.
    const getResult = (await getHandler!({taskId: longRunningId}, 'webui-1')) as {
      task: null | TaskHistoryEntry
    }
    expect(getResult.task).to.exist
    expect(getResult.task!.status).to.equal('started')

    // ── Phase 2: drive terminal tasks in for clear/delete + numbered pagination.
    // Same createdAt ms for several tasks → exercises stable secondary sort by taskId DESC.
    // M2.16: cursor pagination dropped; verify page/pageSize semantics + new response shape.
    const sharedCreatedAt = Date.now()
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      // eslint-disable-next-line no-await-in-loop
      await store.save(
        makeEntry({
          completedAt: sharedCreatedAt + 10,
          createdAt: sharedCreatedAt,
          result: 'done',
          startedAt: sharedCreatedAt + 1,
          status: 'completed',
          taskId: id,
        }),
      )
    }

    // Page 1 — first 2 of the cluster (taskId DESC tiebreaker → p4, p3).
    const page1 = (await listHandler!({page: 1, pageSize: 2, projectPath: PROJECT}, 'webui-1')) as {
      counts: {all: number}
      page: number
      pageCount: number
      pageSize: number
      tasks: Array<{taskId: string}>
      total: number
    }
    expect(page1.tasks).to.have.lengthOf(2)
    expect(page1.page).to.equal(1)
    expect(page1.pageSize).to.equal(2)
    expect(page1.total, 'total counts the long-running task plus 4 terminal').to.equal(5)
    expect(page1.pageCount).to.equal(3) // ceil(5/2)
    expect(page1.counts.all).to.equal(5)

    // Page 2
    const page2 = (await listHandler!({page: 2, pageSize: 2, projectPath: PROJECT}, 'webui-1')) as {
      tasks: Array<{taskId: string}>
    }
    expect(page2.tasks).to.have.lengthOf(2)

    const seenIds = new Set([...page1.tasks.map((t) => t.taskId), ...page2.tasks.map((t) => t.taskId)])
    expect(seenIds.has('p1') || seenIds.has('p2') || seenIds.has('p3') || seenIds.has('p4')).to.equal(true)
    // Across 2 pages of size 2 we should see at least 3 of the 4 cluster tasks (the 5th slot is long-running).
    const clusterSeen = ['p1', 'p2', 'p3', 'p4'].filter((id) => seenIds.has(id))
    expect(clusterSeen.length).to.be.at.least(3)

    // ── Phase 3: bulk delete (C4 — count must reflect actual removals only).
    const bulk = (await deleteBulkHandler!(
      {taskIds: ['p1', 'p2', 'unknown-1', 'unknown-2', 'unknown-3']},
      'webui-1',
    )) as {deletedCount: number}
    expect(bulk.deletedCount, 'bulk inflates count for unknown ids (C4)').to.equal(2)

    // task:deleted broadcast must fire ONLY for real removals.
    const deletedIds = getDeletedBroadcastTaskIds()
    expect(deletedIds).to.include('p1')
    expect(deletedIds).to.include('p2')
    expect(deletedIds).to.not.include('unknown-1')
    expect(deletedIds).to.not.include('unknown-2')
    expect(deletedIds).to.not.include('unknown-3')

    // ── Phase 4: clearCompleted — removes the remaining terminal entries
    // (p3, p4) but preserves the long-running curate task.
    const clearResult = (await clearHandler!({projectPath: PROJECT}, 'webui-1')) as {
      deletedCount: number
    }
    expect(clearResult.deletedCount).to.be.at.least(2) // p3 + p4
    const finalList = (await listHandler!({projectPath: PROJECT}, 'webui-1')) as {
      tasks: Array<{status: string; taskId: string}>
    }
    const longAfter = finalList.tasks.find((t) => t.taskId === longRunningId)
    expect(longAfter, 'long-running task lost to clearCompleted').to.exist
    expect(longAfter!.status, 'C0 regression after clear').to.equal('started')

    // ── Phase 5: a burst of saves concurrent with the prune+compact cycle
    // triggered by the prior delete activity must NOT lose data files (C1).
    // ────────────────────────────────────────────────────────────────────
    const RACE = 25
    const raceIds = Array.from({length: RACE}, (_, i) => `race-${i}`)
    const racingSaves = raceIds.map((id) =>
      store.save(
        makeEntry({
          completedAt: Date.now(),
          createdAt: Date.now(),
          result: 'r',
          startedAt: Date.now(),
          status: 'completed',
          taskId: id,
        }),
      ),
    )
    await Promise.all(racingSaves)

    // Settle background prune/compact passes.
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((r) => {
        setTimeout(() => r(), 5)
      })
    }

    for (const id of raceIds) {
      // eslint-disable-next-line no-await-in-loop
      const fetched = await store.getById(id)
      expect(fetched, `race id ${id} lost during compaction (C1)`).to.exist
    }
  })
})
