/**
 * TaskRouter — extended handlers (M2.09).
 *
 * Integration test: real `FileTaskHistoryStore` (per-test tempDir) + stub
 * transport/agentPool/projectRouter/projectRegistry. Drives the full
 * lifecycle through the TaskRouter handlers and verifies on-disk + broadcast
 * effects.
 *
 * No production-code escape hatches — custom store factories are injected
 * via `TaskRouterOptions.getTaskHistoryStore` directly.
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {mkdir, readFile, rm, unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {TaskHistoryEntry} from '../../../../src/server/core/domain/entities/task-history-entry.js'
import type {IAgentPool, SubmitTaskResult} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IProjectRegistry} from '../../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../../src/server/core/interfaces/routing/i-project-router.js'
import type {ITaskHistoryStore} from '../../../../src/server/core/interfaces/storage/i-task-history-store.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {TransportTaskEventNames} from '../../../../src/server/core/domain/transport/schemas.js'
import {TaskRouter} from '../../../../src/server/infra/process/task-router.js'
import {FileTaskHistoryStore} from '../../../../src/server/infra/storage/file-task-history-store.js'

// ============================================================================
// Helpers
// ============================================================================

function makeProjectInfo(projectPath: string) {
  return {
    projectPath,
    registeredAt: Date.now(),
    sanitizedPath: projectPath.replaceAll('/', '_'),
    storagePath: `/data${projectPath}`,
  }
}

function makeStubTransportServer(sandbox: SinonSandbox) {
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

function makeTaskCreateRequest(overrides: Record<string, unknown> = {}) {
  return {
    content: 'test content',
    projectPath: '/app',
    taskId: randomUUID(),
    type: 'curate' as const,
    ...overrides,
  }
}

function makeStoredEntry(overrides: Partial<TaskHistoryEntry> & {taskId: string}): TaskHistoryEntry {
  const base = {
    completedAt: 1_745_432_001_000,
    content: `prompt for ${overrides.taskId}`,
    createdAt: 1_745_432_000_000,
    id: `tsk-${overrides.taskId}`,
    projectPath: '/app',
    result: 'done',
    schemaVersion: 1 as const,
    status: 'completed' as const,
    taskId: overrides.taskId,
    type: 'curate',
  }
  return {...base, ...overrides} as TaskHistoryEntry
}

// ============================================================================
// Tests
// ============================================================================

describe('TaskRouter — extended handlers', () => {
  let sandbox: SinonSandbox
  let transportHelper: ReturnType<typeof makeStubTransportServer>
  let agentPool: ReturnType<typeof makeStubAgentPool>
  let projectRegistry: ReturnType<typeof makeStubProjectRegistry>
  let projectRouter: ReturnType<typeof makeStubProjectRouter>
  let getAgentForProject: SinonStub
  let tempDir: string
  let store: FileTaskHistoryStore
  let router: TaskRouter

  beforeEach(async () => {
    sandbox = createSandbox()
    transportHelper = makeStubTransportServer(sandbox)
    agentPool = makeStubAgentPool(sandbox)
    projectRegistry = makeStubProjectRegistry(sandbox)
    projectRouter = makeStubProjectRouter(sandbox)
    getAgentForProject = sandbox.stub().returns('agent-1')

    tempDir = join(tmpdir(), `brv-task-router-ext-${Date.now()}-${randomUUID()}`)
    await mkdir(tempDir, {recursive: true})

    // Disable stale recovery + prune + compaction in default fixture so legacy
    // createdAt timestamps don't mutate test data unexpectedly. The dedicated
    // stale-recovery test (and any prune-specific tests) override per-test.
    store = new FileTaskHistoryStore({
      baseDir: tempDir,
      maxAgeDays: 0,
      maxEntries: Number.POSITIVE_INFINITY,
      maxIndexBloatRatio: Number.POSITIVE_INFINITY,
      staleThresholdMs: Number.POSITIVE_INFINITY,
    })

    router = new TaskRouter({
      agentPool,
      getAgentForProject,
      getTaskHistoryStore: () => store,
      projectRegistry,
      projectRouter,
      resolveClientProjectPath: () => '/app',
      transport: transportHelper.transport,
    })
    router.setup()
  })

  afterEach(async () => {
    sandbox.restore()
    await rm(tempDir, {force: true, recursive: true})
  })

  function getDeletedBroadcastTaskIds(): string[] {
    return projectRouter.broadcastToProject
      .getCalls()
      .filter((c) => c.args[1] === TransportTaskEventNames.DELETED)
      .map((c) => (c.args[2] as {taskId: string}).taskId)
  }

  // ==========================================================================
  // handleTaskList
  // ==========================================================================

  describe('handleTaskList', () => {
    it('honors page + pageSize (M2.16 numbered pagination)', async () => {
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await store.save(makeStoredEntry({createdAt: 100 * (i + 1), taskId: `t${i}`}))
      }

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({page: 2, pageSize: 2, projectPath: '/app'}, 'client-1')) as {
        page: number
        pageCount: number
        pageSize: number
        tasks: Array<{taskId: string}>
        total: number
      }

      // 5 entries (createdAt 100..500). Sorted DESC: t4,t3,t2,t1,t0. page=2,size=2 → t2,t1.
      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['t2', 't1'])
      expect(result.total).to.equal(5)
      expect(result.page).to.equal(2)
      expect(result.pageSize).to.equal(2)
      expect(result.pageCount).to.equal(3) // ceil(5/2)
    })

    it('returns shape with total + pageCount + counts + available* sets', async () => {
      for (let i = 0; i < 4; i++) {
        // eslint-disable-next-line no-await-in-loop
        await store.save(makeStoredEntry({createdAt: 100 * (i + 1), taskId: `n${i}`}))
      }

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({page: 1, pageSize: 2, projectPath: '/app'}, 'client-1')) as {
        availableModels: Array<{modelId: string; providerId: string}>
        availableProviders: string[]
        counts: {all: number}
        pageCount: number
        tasks: unknown[]
        total: number
      }

      expect(result.tasks).to.have.lengthOf(2)
      expect(result.total).to.equal(4)
      expect(result.pageCount).to.equal(2)
      expect(result.counts.all).to.equal(4)
      expect(result.availableProviders).to.be.an('array')
      expect(result.availableModels).to.be.an('array')
    })

    it('page > pageCount returns empty tasks but correct total/pageCount', async () => {
      for (let i = 0; i < 3; i++) {
        // eslint-disable-next-line no-await-in-loop
        await store.save(makeStoredEntry({createdAt: 100 * (i + 1), taskId: `t${i}`}))
      }

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({page: 9999, pageSize: 50, projectPath: '/app'}, 'client-1')) as {
        page: number
        pageCount: number
        tasks: unknown[]
        total: number
      }

      expect(result.tasks).to.deep.equal([])
      expect(result.total).to.equal(3)
      expect(result.pageCount).to.equal(1)
      expect(result.page).to.equal(9999) // server echoes back; caller must correct
    })

    it('same-millisecond cluster — sort stable by (createdAt DESC, taskId DESC)', async () => {
      const sharedCreatedAt = 100
      for (const id of ['a', 'b', 'c', 'd']) {
        // eslint-disable-next-line no-await-in-loop
        await store.save(makeStoredEntry({createdAt: sharedCreatedAt, taskId: id}))
      }

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({page: 1, pageSize: 4, projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      // taskId DESC tiebreaker on equal createdAt: d,c,b,a
      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['d', 'c', 'b', 'a'])
    })

    it('merges in-memory + persisted, in-memory wins by taskId', async () => {
      // Save older 'completed' state to disk
      await store.save(
        makeStoredEntry({createdAt: 100, status: 'completed', taskId: 'shared'}),
      )

      // Drive create through TaskRouter so in-memory has fresher state with status 'created'
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      await createHandler!(makeTaskCreateRequest({content: 'fresh', taskId: 'shared'}), 'client-1')

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{content: string; status: string; taskId: string}>
      }

      const shared = result.tasks.find((t) => t.taskId === 'shared')
      expect(shared).to.exist
      expect(shared!.status).to.equal('created') // in-memory wins
      expect(shared!.content).to.equal('fresh')
    })

    it('project filter isolates results', async () => {
      await store.save(makeStoredEntry({projectPath: '/app', taskId: 'in'}))
      await store.save(makeStoredEntry({projectPath: '/other', taskId: 'out'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['in'])
    })

    it('status filter applied at index read', async () => {
      await store.save(makeStoredEntry({status: 'completed', taskId: 'c'}))
      await store.save(
        makeStoredEntry({
          completedAt: 1,
          error: {code: 'X', message: 'x', name: 'X'},
          status: 'error',
          taskId: 'e',
        }),
      )

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app', status: ['error']}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['e'])
    })

    // B1 — `task:list` schema declares `type?: string[]`, the store applies it,
    // but `handleTaskList` historically dropped the field on the floor. WebUI
    // calling `task:list({type: ['curate']})` would receive every task type.
    describe('type filter (B1)', () => {
      it('single type — only matching persisted tasks returned', async () => {
        await store.save(makeStoredEntry({taskId: 'c1', type: 'curate'}))
        await store.save(makeStoredEntry({taskId: 'q1', type: 'query'}))
        await store.save(makeStoredEntry({taskId: 's1', type: 'search'}))

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
        const result = (await handler!({projectPath: '/app', type: ['curate']}, 'client-1')) as {
          tasks: Array<{taskId: string; type: string}>
        }

        expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['c1'])
        expect(result.tasks[0].type).to.equal('curate')
      })

      it('multiple types — union of matching persisted tasks returned', async () => {
        await store.save(makeStoredEntry({taskId: 'c1', type: 'curate'}))
        await store.save(makeStoredEntry({taskId: 'q1', type: 'query'}))
        await store.save(makeStoredEntry({taskId: 's1', type: 'search'}))

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
        const result = (await handler!(
          {projectPath: '/app', type: ['curate', 'query']},
          'client-1',
        )) as {
          tasks: Array<{taskId: string; type: string}>
        }

        // Same createdAt for all three → secondary sort by taskId DESC: q1 then c1.
        expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['q1', 'c1'])
      })

      it('in-memory tasks honor type filter (not just persisted)', async () => {
        // Persisted curate.
        await store.save(makeStoredEntry({taskId: 'persisted-c', type: 'curate'}))

        // In-memory query via createHandler — must be excluded when filter is ['curate'].
        const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
        await createHandler!(
          makeTaskCreateRequest({taskId: 'live-q', type: 'query'}),
          'client-1',
        )

        const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
        const result = (await listHandler!({projectPath: '/app', type: ['curate']}, 'client-1')) as {
          tasks: Array<{taskId: string}>
        }

        expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['persisted-c'])
      })

      it('omitted type filter returns all types (back-compat)', async () => {
        await store.save(makeStoredEntry({taskId: 'c1', type: 'curate'}))
        await store.save(makeStoredEntry({taskId: 'q1', type: 'query'}))

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
        const result = (await handler!({projectPath: '/app'}, 'client-1')) as {
          tasks: Array<{taskId: string}>
        }

        expect(result.tasks).to.have.lengthOf(2)
      })

      it('empty type[] returns all types (matches store ?.length semantics)', async () => {
        await store.save(makeStoredEntry({taskId: 'c1', type: 'curate'}))
        await store.save(makeStoredEntry({taskId: 'q1', type: 'query'}))

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
        const result = (await handler!({projectPath: '/app', type: []}, 'client-1')) as {
          tasks: Array<{taskId: string}>
        }

        expect(result.tasks).to.have.lengthOf(2)
      })
    })

    it('sorted createdAt desc', async () => {
      await store.save(makeStoredEntry({createdAt: 100, taskId: 'old'}))
      await store.save(makeStoredEntry({createdAt: 500, taskId: 'new'}))
      await store.save(makeStoredEntry({createdAt: 300, taskId: 'mid'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['new', 'mid', 'old'])
    })

    it('stale-recovery surfaces in response', async () => {
      // Recreate the router with a stale-friendly store (small threshold).
      sandbox.restore()
      sandbox = createSandbox()
      transportHelper = makeStubTransportServer(sandbox)
      agentPool = makeStubAgentPool(sandbox)
      projectRegistry = makeStubProjectRegistry(sandbox)
      projectRouter = makeStubProjectRouter(sandbox)
      getAgentForProject = sandbox.stub().returns('agent-1')

      const staleStore = new FileTaskHistoryStore({
        baseDir: tempDir,
        // Far-future daemonStartedAt so this test's saves register as pre-boot
        // (eligible for stale-recovery via the C0 daemon-startup gate). Without
        // this override the entry would be treated as a live in-flight task.
        daemonStartedAt: Date.now() + 60_000_000_000,
        maxAgeDays: 0,
        maxEntries: Number.POSITIVE_INFINITY,
        maxIndexBloatRatio: Number.POSITIVE_INFINITY,
        staleThresholdMs: 100,
      })
      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        getTaskHistoryStore: () => staleStore,
        projectRegistry,
        projectRouter,
        resolveClientProjectPath: () => '/app',
        transport: transportHelper.transport,
      })
      router.setup()

      const oldCreatedAt = Date.now() - 200
      await staleStore.save(
        makeStoredEntry({
          createdAt: oldCreatedAt,
          startedAt: oldCreatedAt + 10,
          status: 'started',
          taskId: 'ghost',
        }),
      )

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{status: string; taskId: string}>
      }

      const ghost = result.tasks.find((t) => t.taskId === 'ghost')
      expect(ghost).to.exist
      expect(ghost!.status).to.equal('error')
    })

    // ----------------------------------------------------------------------
    // M2.16 — filter dimensions + derivative sets
    // ----------------------------------------------------------------------

    it('searchText matches content (case-insensitive)', async () => {
      await store.save(makeStoredEntry({content: 'Inspect AUTH flow', taskId: 'a1'}))
      await store.save(makeStoredEntry({content: 'index hub', taskId: 'a2'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app', searchText: 'auth'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['a1'])
    })

    it('searchText matches error.message on error tasks', async () => {
      await store.save(
        makeStoredEntry({
          completedAt: 1,
          error: {code: 'X', message: 'Timeout: connection refused', name: 'TaskError'},
          status: 'error',
          taskId: 'e1',
        }),
      )
      await store.save(makeStoredEntry({content: 'unrelated', taskId: 'c1'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app', searchText: 'timeout'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['e1'])
    })

    it('provider[] filter — exact match', async () => {
      await store.save(makeStoredEntry({provider: 'openai', taskId: 'o1'}))
      await store.save(makeStoredEntry({provider: 'anthropic', taskId: 'a1'}))
      await store.save(makeStoredEntry({taskId: 'np1'})) // no provider

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app', provider: ['openai']}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['o1'])
    })

    it('model[] filter — exact match', async () => {
      await store.save(makeStoredEntry({model: 'gpt-5-pro', provider: 'openai', taskId: 'g1'}))
      await store.save(makeStoredEntry({model: 'claude-3-5-sonnet', provider: 'anthropic', taskId: 'c1'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({model: ['gpt-5-pro'], projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['g1'])
    })

    it('createdAfter / createdBefore — timestamp range', async () => {
      await store.save(makeStoredEntry({createdAt: 100, taskId: 'old'}))
      await store.save(makeStoredEntry({createdAt: 200, taskId: 'mid'}))
      await store.save(makeStoredEntry({createdAt: 300, taskId: 'new'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!(
        {createdAfter: 150, createdBefore: 250, projectPath: '/app'},
        'client-1',
      )) as {tasks: Array<{taskId: string}>}

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['mid'])
    })

    it('minDurationMs / maxDurationMs — terminal-only', async () => {
      await store.save(
        makeStoredEntry({
          completedAt: 1100, // dur = 1100 - 1000 = 100ms
          startedAt: 1000,
          status: 'completed',
          taskId: 'fast',
        }),
      )
      await store.save(
        makeStoredEntry({
          completedAt: 6000, // dur = 5000ms
          startedAt: 1000,
          status: 'completed',
          taskId: 'slow',
        }),
      )
      await store.save(
        makeStoredEntry({
          // No startedAt or completedAt → 'created' status — must be excluded by duration filter
          status: 'created',
          taskId: 'active',
        }),
      )

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({minDurationMs: 1000, projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['slow'])
    })

    it('maxDurationMs — upper bound rejects long-running terminal tasks', async () => {
      await store.save(
        makeStoredEntry({
          completedAt: 1100, // dur = 100ms (under cap)
          startedAt: 1000,
          status: 'completed',
          taskId: 'fast',
        }),
      )
      await store.save(
        makeStoredEntry({
          completedAt: 6000, // dur = 5000ms (exceeds 1000ms cap)
          startedAt: 1000,
          status: 'completed',
          taskId: 'too-long',
        }),
      )

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({maxDurationMs: 1000, projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['fast'])
    })

    it('AND combination — searchText + status + provider', async () => {
      await store.save(
        makeStoredEntry({
          completedAt: 100,
          content: 'auth flow',
          error: {code: 'X', message: 'auth failure', name: 'TaskError'},
          provider: 'openai',
          status: 'error',
          taskId: 'match',
        }),
      )
      await store.save(makeStoredEntry({content: 'auth flow', provider: 'openai', status: 'completed', taskId: 'wrong-status'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!(
        {projectPath: '/app', provider: ['openai'], searchText: 'auth', status: ['error']},
        'client-1',
      )) as {tasks: Array<{taskId: string}>}

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['match'])
    })

    it('counts derive from allFiltered (matches current filter scope — Model A)', async () => {
      await store.save(makeStoredEntry({status: 'completed', taskId: 'c1'}))
      await store.save(makeStoredEntry({status: 'completed', taskId: 'c2'}))
      await store.save(
        makeStoredEntry({
          completedAt: 1,
          error: {code: 'X', message: 'x', name: 'X'},
          status: 'error',
          taskId: 'e1',
        }),
      )

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      // Pick status=['error'] — counts reflects post-status-filter (Model A).
      const result = (await handler!({projectPath: '/app', status: ['error']}, 'client-1')) as {
        counts: {all: number; cancelled: number; completed: number; failed: number; running: number}
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['e1'])
      expect(result.counts).to.deep.equal({all: 1, cancelled: 0, completed: 0, failed: 1, running: 0})
    })

    it('availableProviders + availableModels — history-derived, exclude pivots', async () => {
      await store.save(makeStoredEntry({model: 'gpt-5-pro', provider: 'openai', taskId: 'a'}))
      await store.save(makeStoredEntry({model: 'claude-3-5-sonnet', provider: 'anthropic', taskId: 'b'}))
      await store.save(makeStoredEntry({model: 'claude-3-5-sonnet', provider: 'bedrock', taskId: 'c'}))
      await store.save(makeStoredEntry({taskId: 'd'})) // no provider/model — must NOT add phantom

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      // Pick provider=['openai'] — availableProviders/availableModels MUST still include all (exclude pivot).
      const result = (await handler!({projectPath: '/app', provider: ['openai']}, 'client-1')) as {
        availableModels: Array<{modelId: string; providerId: string}>
        availableProviders: string[]
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['a'])
      expect(result.availableProviders).to.have.members(['openai', 'anthropic', 'bedrock'])
      // pair preservation: claude-3-5-sonnet from 2 providers = 2 entries
      const claude35 = result.availableModels.filter((m) => m.modelId === 'claude-3-5-sonnet')
      expect(claude35).to.have.lengthOf(2)
      expect(claude35.map((m) => m.providerId).sort()).to.deep.equal(['anthropic', 'bedrock'])
    })

    it('pass-2 lazy crack — searchText matches full result text via getById (happy path)', async () => {
      // Persist a completed task whose `result` contains the needle but content/error.message do NOT.
      // Pass-1 must miss; pass-2 must getById and match against entry.result.
      await store.save(
        makeStoredEntry({
          completedAt: 100,
          content: 'unrelated prompt',
          // result is NOT on the index summary, so pass-1 cannot see it.
          // The save persists the full TaskHistoryEntry to data/tsk-deep.json including result.
          startedAt: 50,
          status: 'completed',
          taskId: 'deep',
        }),
      )
      // Save also writes the data file with the full entry — verify by direct save() with result.
      await store.save({
        completedAt: 100,
        content: 'unrelated prompt',
        createdAt: 0,
        id: 'deep',
        projectPath: '/app',
        result: 'x'.repeat(2000) + 'unique-deep-result-token' + 'y'.repeat(2000),
        schemaVersion: 1,
        startedAt: 50,
        status: 'completed',
        taskId: 'deep',
        type: 'curate',
      })

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!(
        {projectPath: '/app', searchText: 'unique-deep-result-token'},
        'client-1',
      )) as {tasks: Array<{taskId: string}>}

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['deep'])
    })

    it('pass-2 lazy crack — in-memory completed task matches via task.result (no I/O)', async () => {
      // Drive a task through completion via TaskRouter so it lives in this.completedTasks.
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      await createHandler!(makeTaskCreateRequest({content: 'plain prompt', taskId: 'live'}), 'client-1')

      const completedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
      await completedHandler!(
        {result: 'response with needle-in-mem in middle', taskId: 'live'},
        'client-1',
      )

      // Stub getById to throw — proves pass-2 in-memory path didn't go through I/O.
      const getByIdStub = sandbox.stub(store, 'getById').rejects(new Error('should not be called'))

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!(
        {projectPath: '/app', searchText: 'needle-in-mem'},
        'client-1',
      )) as {tasks: Array<{taskId: string}>}

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['live'])
      expect(getByIdStub.called, 'in-memory pass-2 must NOT call store.getById').to.equal(false)
    })

    it('searchText empty string is treated as "no filter"', async () => {
      await store.save(makeStoredEntry({taskId: 't1'}))
      await store.save(makeStoredEntry({taskId: 't2'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app', searchText: ''}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks).to.have.lengthOf(2)
    })

    it('availableProviders + availableModels exclude empty-string entries (regression: asymmetric guard)', async () => {
      // Schema accepts '' for provider/model; derivative sets MUST guard length > 0
      // so we don't emit phantom {providerId: 'openai', modelId: ''} pairs.
      await store.save(makeStoredEntry({model: '', provider: 'openai', taskId: 'empty-model'}))
      await store.save(makeStoredEntry({model: 'gpt-5-pro', provider: '', taskId: 'empty-provider'}))
      await store.save(makeStoredEntry({model: 'gpt-5-pro', provider: 'openai', taskId: 'good'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app'}, 'client-1')) as {
        availableModels: Array<{modelId: string; providerId: string}>
        availableProviders: string[]
      }

      expect(result.availableProviders).to.deep.equal(['openai'])
      expect(result.availableProviders).to.not.include('')
      expect(result.availableModels).to.deep.equal([{modelId: 'gpt-5-pro', providerId: 'openai'}])
      expect(result.availableModels.some((m) => m.modelId === '' || m.providerId === '')).to.equal(false)
    })

    it('availableProviders excludes phantom undefined when tasks have no provider', async () => {
      await store.save(makeStoredEntry({provider: 'openai', taskId: 'a'}))
      await store.save(makeStoredEntry({taskId: 'b'})) // no provider

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app'}, 'client-1')) as {
        availableProviders: string[]
      }

      expect(result.availableProviders).to.not.include(undefined)
      expect(result.availableProviders).to.not.include('')
      expect(result.availableProviders).to.deep.equal(['openai'])
    })

    it('counts.all === total invariant under status filter (Model A)', async () => {
      await store.save(makeStoredEntry({status: 'completed', taskId: 'c1'}))
      await store.save(makeStoredEntry({status: 'completed', taskId: 'c2'}))
      await store.save(
        makeStoredEntry({
          completedAt: 1,
          error: {code: 'X', message: 'x', name: 'X'},
          status: 'error',
          taskId: 'e1',
        }),
      )

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await handler!({projectPath: '/app', status: ['error']}, 'client-1')) as {
        counts: {all: number}
        total: number
      }

      // counts.all matches current filter scope → equal to total under any filter.
      expect(result.counts.all).to.equal(result.total)
      expect(result.counts.all).to.equal(1)
      expect(result.total).to.equal(1)
    })

    it('pass-2 swallows getById file-race errors', async () => {
      await store.save(
        makeStoredEntry({
          completedAt: 100,
          content: 'no-keyword-here',
          // result is NOT on the index — search past pass-1 will trigger pass-2 → getById.
          startedAt: 50,
          status: 'completed',
          taskId: 'race',
        }),
      )
      // Stub getById to throw (simulating concurrent delete)
      sandbox.stub(store, 'getById').rejects(new Error('ENOENT'))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      // Search must complete without crash; race task is not matched (no result-text match).
      const result = (await handler!({projectPath: '/app', searchText: 'something'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks).to.be.an('array')
      expect(result.tasks).to.deep.equal([])
    })

    it('pageSize clamps to [1, 1000]', async () => {
      await store.save(makeStoredEntry({taskId: 't1'}))
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)

      // pageSize=0 should be clamped to 1 by handler (schema rejects 0, but handler also clamps for back-compat)
      const r1 = (await handler!({pageSize: 0, projectPath: '/app'}, 'client-1')) as {pageSize: number}
      expect(r1.pageSize).to.equal(1)

      // pageSize=1001 — schema enforces max 1000 at parse time. Test handler clamp safety.
      const r2 = (await handler!({pageSize: 9999, projectPath: '/app'}, 'client-1')) as {pageSize: number}
      expect(r2.pageSize).to.equal(1000)
    })

    it('store error falls back to in-memory only', async () => {
      const erroringStore: ITaskHistoryStore = {
        clear: sandbox.stub().resolves({deletedCount: 0, taskIds: []}),
        delete: sandbox.stub().resolves(false),
        deleteMany: sandbox.stub().resolves([]),
        getById: sandbox.stub().resolves(),
        list: sandbox.stub().rejects(new Error('disk down')),
        save: sandbox.stub().resolves(),
      }

      // Rebuild router with the failing store
      sandbox.restore()
      sandbox = createSandbox()
      transportHelper = makeStubTransportServer(sandbox)
      agentPool = makeStubAgentPool(sandbox)
      projectRegistry = makeStubProjectRegistry(sandbox)
      projectRouter = makeStubProjectRouter(sandbox)
      getAgentForProject = sandbox.stub().returns('agent-1')

      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        getTaskHistoryStore: () => erroringStore,
        projectRegistry,
        projectRouter,
        resolveClientProjectPath: () => '/app',
        transport: transportHelper.transport,
      })
      router.setup()

      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      await createHandler!(makeTaskCreateRequest({taskId: 'in-mem'}), 'client-1')

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({projectPath: '/app'}, 'client-1')) as {
        tasks: Array<{taskId: string}>
      }

      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['in-mem'])
    })

    it('handler returns valid empty response when getTaskHistoryStore is undefined', async () => {
      // Build a router WITHOUT a store factory — handler must fall back to
      // in-memory only and still return the full response shape.
      sandbox.restore()
      sandbox = createSandbox()
      transportHelper = makeStubTransportServer(sandbox)
      agentPool = makeStubAgentPool(sandbox)
      projectRegistry = makeStubProjectRegistry(sandbox)
      projectRouter = makeStubProjectRouter(sandbox)
      getAgentForProject = sandbox.stub().returns('agent-1')

      router = new TaskRouter({
        agentPool,
        getAgentForProject,
        // getTaskHistoryStore: undefined — no persistent store wired
        projectRegistry,
        projectRouter,
        resolveClientProjectPath: () => '/app',
        transport: transportHelper.transport,
      })
      router.setup()

      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      await createHandler!(makeTaskCreateRequest({taskId: 'live-only'}), 'client-1')

      const listHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.LIST)
      const result = (await listHandler!({projectPath: '/app'}, 'client-1')) as {
        availableModels: unknown[]
        availableProviders: unknown[]
        counts: {all: number}
        page: number
        pageCount: number
        pageSize: number
        tasks: Array<{taskId: string}>
        total: number
      }

      // In-memory live task surfaces; full response shape valid.
      expect(result.tasks.map((t) => t.taskId)).to.deep.equal(['live-only'])
      expect(result.total).to.equal(1)
      expect(result.counts.all).to.equal(1)
      expect(result.availableProviders).to.be.an('array')
      expect(result.availableModels).to.be.an('array')

      // Pass-2 search must not throw when store is undefined.
      const searchResult = (await listHandler!(
        {projectPath: '/app', searchText: 'anything'},
        'client-1',
      )) as {tasks: Array<{taskId: string}>}
      expect(searchResult.tasks).to.be.an('array')
    })
  })

  // ==========================================================================
  // handleTaskGet
  // ==========================================================================

  describe('handleTaskGet', () => {
    it('returns synthesized entry from in-memory TaskInfo when present', async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()
      await createHandler!(makeTaskCreateRequest({taskId}), 'client-1')

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.GET)
      const result = (await handler!({taskId}, 'client-1')) as {task: null | TaskHistoryEntry}

      expect(result.task).to.exist
      expect(result.task!.taskId).to.equal(taskId)
      expect(result.task!.status).to.equal('created')
    })

    it('falls back to store.getById when not in-memory', async () => {
      await store.save(makeStoredEntry({taskId: 'on-disk'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.GET)
      const result = (await handler!({taskId: 'on-disk'}, 'client-1')) as {task: null | TaskHistoryEntry}

      expect(result.task).to.exist
      expect(result.task!.taskId).to.equal('on-disk')
    })

    it('returns {task: null} when neither has it', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.GET)
      const result = (await handler!({taskId: 'never'}, 'client-1')) as {task: null | TaskHistoryEntry}

      expect(result.task).to.equal(null)
    })

    it('returns {task: null} for orphan-index entry', async () => {
      await store.save(makeStoredEntry({taskId: 'orphan'}))
      // Manually unlink the data file — index says alive but data is gone.
      await unlink(join(tempDir, 'task-history', 'data', 'tsk-orphan.json'))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.GET)
      const result = (await handler!({taskId: 'orphan'}, 'client-1')) as {task: null | TaskHistoryEntry}

      expect(result.task).to.equal(null)
    })
  })

  // ==========================================================================
  // handleTaskDelete
  // ==========================================================================

  describe('handleTaskDelete', () => {
    it('refuses non-terminal status', async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const taskId = randomUUID()
      await createHandler!(makeTaskCreateRequest({taskId}), 'client-1')

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE)
      const result = (await handler!({taskId}, 'client-1')) as {error?: string; success: boolean}

      expect(result.success).to.equal(false)
      expect(result.error).to.exist
    })

    it('removes from in-memory + writes tombstone + unlinks', async () => {
      await store.save(makeStoredEntry({taskId: 'die'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE)
      const result = (await handler!({taskId: 'die'}, 'client-1')) as {success: boolean}

      expect(result.success).to.equal(true)

      // Tombstone present in index
      const indexRaw = await readFile(join(tempDir, 'task-history', '_index.jsonl'), 'utf8')
      const lines = indexRaw.split('\n').filter(Boolean)
      const lastLine = JSON.parse(lines.at(-1) ?? '') as Record<string, unknown>
      expect(lastLine).to.include({_deleted: true, taskId: 'die'})

      // Data file gone
      const dataPath = join(tempDir, 'task-history', 'data', 'tsk-die.json')
      let dataExists = true
      try {
        await readFile(dataPath, 'utf8')
      } catch {
        dataExists = false
      }

      expect(dataExists).to.equal(false)
    })

    it('broadcasts task:deleted', async () => {
      await store.save(makeStoredEntry({taskId: 'broadcast-me'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE)
      await handler!({taskId: 'broadcast-me'}, 'client-1')

      expect(getDeletedBroadcastTaskIds()).to.include('broadcast-me')
    })

    it('idempotent — second call returns success, no second broadcast', async () => {
      await store.save(makeStoredEntry({taskId: 'twice'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE)
      const r1 = (await handler!({taskId: 'twice'}, 'client-1')) as {success: boolean}
      const r2 = (await handler!({taskId: 'twice'}, 'client-1')) as {success: boolean}

      expect(r1.success).to.equal(true)
      expect(r2.success).to.equal(true)

      const broadcasts = getDeletedBroadcastTaskIds().filter((id) => id === 'twice')
      expect(broadcasts).to.have.lengthOf(1)
    })
  })

  // ==========================================================================
  // handleTaskDeleteBulk
  // ==========================================================================

  describe('handleTaskDeleteBulk', () => {
    it('skips non-terminal, reports correct deletedCount', async () => {
      // Two completed entries on disk
      await store.save(makeStoredEntry({taskId: 'b1'}))
      await store.save(makeStoredEntry({taskId: 'b2'}))

      // One non-terminal in-memory
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const liveId = randomUUID()
      await createHandler!(makeTaskCreateRequest({taskId: liveId}), 'client-1')

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
      const result = (await handler!({taskIds: ['b1', 'b2', liveId]}, 'client-1')) as {
        deletedCount: number
      }

      expect(result.deletedCount).to.equal(2)
    })

    it('broadcasts task:deleted per successful removal', async () => {
      await store.save(makeStoredEntry({taskId: 'k1'}))
      await store.save(makeStoredEntry({taskId: 'k2'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
      await handler!({taskIds: ['k1', 'k2']}, 'client-1')

      const broadcasts = getDeletedBroadcastTaskIds()
      expect(broadcasts).to.include('k1')
      expect(broadcasts).to.include('k2')
    })

    it('C4 — does NOT inflate deletedCount for unknown taskIds', async () => {
      // Bug: `handleTaskDelete` returned {success: true} unconditionally even
      // for taskIds the daemon had never heard of. The bulk handler counted on
      // `success`, so 50 unknown ids reported `deletedCount: 50`. The fix uses
      // the new `removed` flag.
      await store.save(makeStoredEntry({taskId: 'known-1'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
      const result = (await handler!(
        {taskIds: ['known-1', 'ghost-1', 'ghost-2', 'ghost-3', 'ghost-4', 'ghost-5']},
        'client-1',
      )) as {deletedCount: number}

      expect(result.deletedCount).to.equal(1) // only known-1; ghosts must not inflate
    })

    it('C4 — bulk delete of all-unknown ids returns deletedCount: 0', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
      const result = (await handler!(
        {taskIds: ['nope-1', 'nope-2', 'nope-3']},
        'client-1',
      )) as {deletedCount: number}

      expect(result.deletedCount).to.equal(0)
    })

    it('C4 — does NOT broadcast task:deleted for unknown taskIds', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
      await handler!({taskIds: ['unseen-1', 'unseen-2']}, 'client-1')

      const broadcasts = getDeletedBroadcastTaskIds()
      // Pre-fix: unknown ids still triggered the wasInMemory||wasLive check
      // which was `false` so no broadcast. So this test asserts the existing
      // correct behaviour stays correct under the new `removed` semantics.
      expect(broadcasts).to.not.include('unseen-1')
      expect(broadcasts).to.not.include('unseen-2')
    })

    // N3 — `handleTaskDeleteBulk` previously called `handleTaskDelete`
    // sequentially per id, each invoking `store.delete` which re-reads the
    // entire `_index.jsonl` (cache invalidated by tombstone append). 200 ids
    // = 200 full index reads. The store interface already exposes
    // `deleteMany` for batched removal — the router should use it.
    describe('N3 — batches store.deleteMany per project', () => {
      it('issues one store.deleteMany call (not N store.delete calls) for ids in a single project', async () => {
        for (let i = 0; i < 5; i++) {
          // eslint-disable-next-line no-await-in-loop
          await store.save(makeStoredEntry({taskId: `bulk-${i}`}))
        }

        const deleteSpy = sandbox.spy(store, 'delete')
        const deleteManySpy = sandbox.spy(store, 'deleteMany')

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
        const result = (await handler!(
          {taskIds: ['bulk-0', 'bulk-1', 'bulk-2', 'bulk-3', 'bulk-4']},
          'client-1',
        )) as {deletedCount: number}

        expect(result.deletedCount).to.equal(5)

        // Per-id store.delete must NOT be called for bulk operations.
        expect(deleteSpy.callCount, 'store.delete should not be called by bulk handler').to.equal(0)

        // store.deleteMany called once with all 5 ids.
        expect(deleteManySpy.callCount).to.equal(1)
        const argIds = deleteManySpy.firstCall.args[0]
        expect(argIds).to.have.members(['bulk-0', 'bulk-1', 'bulk-2', 'bulk-3', 'bulk-4'])
      })

      it('continues to broadcast task:deleted per id (one event per removal)', async () => {
        for (let i = 0; i < 3; i++) {
          // eslint-disable-next-line no-await-in-loop
          await store.save(makeStoredEntry({taskId: `bcast-${i}`}))
        }

        const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE_BULK)
        await handler!({taskIds: ['bcast-0', 'bcast-1', 'bcast-2']}, 'client-1')

        const broadcasts = getDeletedBroadcastTaskIds()
        expect(broadcasts).to.include.members(['bcast-0', 'bcast-1', 'bcast-2'])
      })
    })
  })

  // ==========================================================================
  // handleTaskDelete (single) — C4 contract for `removed` flag
  // ==========================================================================

  describe('handleTaskDelete contract (C4)', () => {
    it('returns {success: true, removed: true} for a real removal', async () => {
      await store.save(makeStoredEntry({taskId: 'real-1'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE)
      const result = (await handler!({taskId: 'real-1'}, 'client-1')) as {
        removed?: boolean
        success: boolean
      }

      expect(result.success).to.equal(true)
      expect(result.removed).to.equal(true)
    })

    it('returns {success: true, removed: false} for an unknown taskId', async () => {
      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE)
      const result = (await handler!({taskId: 'never-existed'}, 'client-1')) as {
        removed?: boolean
        success: boolean
      }

      expect(result.success).to.equal(true)
      expect(result.removed).to.equal(false)
    })

    it('returns {success: false, removed: false} for non-terminal in-memory task', async () => {
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const liveId = randomUUID()
      await createHandler!(makeTaskCreateRequest({taskId: liveId}), 'client-1')

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.DELETE)
      const result = (await handler!({taskId: liveId}, 'client-1')) as {
        removed?: boolean
        success: boolean
      }

      expect(result.success).to.equal(false)
      expect(result.removed).to.equal(false)
    })
  })

  // ==========================================================================
  // handleTaskClearCompleted
  // ==========================================================================

  describe('handleTaskClearCompleted', () => {
    it('unions in-memory completedTasks + store.clear results', async () => {
      // Persistent terminal entries
      await store.save(makeStoredEntry({taskId: 'p1'}))
      await store.save(makeStoredEntry({taskId: 'p2'}))

      // Drive a task through to completed (in-memory grace period)
      const createHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
      const completedHandler = transportHelper.requestHandlers.get(TransportTaskEventNames.COMPLETED)
      const inMemId = randomUUID()
      await createHandler!(makeTaskCreateRequest({taskId: inMemId}), 'client-1')
      completedHandler!({result: 'done', taskId: inMemId}, 'agent-1')

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CLEAR_COMPLETED)
      const result = (await handler!({projectPath: '/app'}, 'client-1')) as {deletedCount: number}

      // 2 from disk + 1 from in-memory completedTasks = 3
      expect(result.deletedCount).to.equal(3)
    })

    it('broadcasts task:deleted per removed entry', async () => {
      await store.save(makeStoredEntry({taskId: 'cb1'}))
      await store.save(makeStoredEntry({taskId: 'cb2'}))

      const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CLEAR_COMPLETED)
      await handler!({projectPath: '/app'}, 'client-1')

      const broadcasts = getDeletedBroadcastTaskIds()
      expect(broadcasts).to.include('cb1')
      expect(broadcasts).to.include('cb2')
    })
  })
})
