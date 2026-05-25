/**
 * Integration tests for resolver → task-router boundary.
 *
 * Verifies that `resolveProject()` results are correctly threaded through
 * `TaskRouter.handleTaskCreate()` across workspace link state changes.
 *
 * Uses real filesystem (tmpdir) + real resolver + TaskRouter with stubbed
 * transport/pool (no daemon, no network).
 */

import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAgentPool, SubmitTaskResult} from '../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IProjectRegistry} from '../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../src/server/core/interfaces/transport/i-transport-server.js'

import {TransportTaskEventNames} from '../../../src/server/core/domain/transport/schemas.js'
import {TaskRouter} from '../../../src/server/infra/process/task-router.js'

// ============================================================================
// Helpers (same pattern as task-router.test.ts)
// ============================================================================

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

function makeStubAgentPool(sandbox: SinonSandbox): IAgentPool & {submitTask: SinonStub} {
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

function makeProjectInfo(projectPath: string) {
  return {
    projectPath,
    registeredAt: Date.now(),
    sanitizedPath: projectPath.replaceAll('/', '_'),
    storagePath: `/data${projectPath}`,
  }
}

function createBrvConfig(dir: string): void {
  mkdirSync(join(dir, '.brv'), {recursive: true})
  writeFileSync(join(dir, '.brv', 'config.json'), JSON.stringify({version: '0.0.1'}))
}

function createWorkspaceLink(dir: string, projectRoot: string): void {
  writeFileSync(join(dir, '.brv'), JSON.stringify({projectRoot}, null, 2) + '\n')
}

// ============================================================================
// Tests
// ============================================================================

describe('resolver → task-router integration', () => {
  let sandbox: SinonSandbox
  let testDir: string
  let transportHelper: ReturnType<typeof makeStubTransportServer>
  let agentPool: ReturnType<typeof makeStubAgentPool>
  let router: TaskRouter

  beforeEach(() => {
    sandbox = createSandbox()
    testDir = realpathSync(mkdtempSync(join(tmpdir(), 'brv-rt-integ-')))

    transportHelper = makeStubTransportServer(sandbox)
    agentPool = makeStubAgentPool(sandbox)

    const projectRegistry: IProjectRegistry = {
      get: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
      getAll: sandbox.stub().returns(new Map()),
      register: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
      unregister: sandbox.stub().returns(true),
    }

    const projectRouter: IProjectRouter = {
      addToProjectRoom: sandbox.stub(),
      broadcastToProject: sandbox.stub(),
      getProjectMembers: sandbox.stub().returns([]),
      removeFromProjectRoom: sandbox.stub(),
    }

    router = new TaskRouter({
      agentPool,
      getAgentForProject: sandbox.stub().returns('agent-1'),
      projectRegistry,
      projectRouter,
      transport: transportHelper.transport,
    })

    router.setup()
  })

  afterEach(() => {
    sandbox.restore()
    rmSync(testDir, {force: true, recursive: true})
  })

  async function createTask(overrides: Record<string, unknown> = {}) {
    const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)!
    const request = {
      content: 'test',
      taskId: randomUUID(),
      type: 'curate' as const,
      ...overrides,
    }
    await handler(request, 'client-1')
    // Let fire-and-forget pool submission settle
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })

    return request
  }

  function getSubmittedTask(callIndex = 0) {
    return agentPool.submitTask.getCall(callIndex)?.args[0]
  }

  it('should thread linked worktreeRoot into submitted task', async () => {
    const projectRoot = join(testDir, 'project')
    const workspace = join(projectRoot, 'packages', 'api')
    mkdirSync(workspace, {recursive: true})
    createBrvConfig(projectRoot)
    createWorkspaceLink(workspace, projectRoot)

    await createTask({clientCwd: workspace})

    const submitted = getSubmittedTask()
    expect(submitted.projectPath).to.equal(projectRoot)
    expect(submitted.worktreeRoot).to.equal(workspace)
  })

  it('should revert to walked-up resolution after unlink', async () => {
    const projectRoot = join(testDir, 'project')
    const workspace = join(projectRoot, 'packages', 'api')
    mkdirSync(workspace, {recursive: true})
    createBrvConfig(projectRoot)
    createWorkspaceLink(workspace, projectRoot)

    // First task: linked
    await createTask({clientCwd: workspace})
    const first = getSubmittedTask(0)
    expect(first.worktreeRoot).to.equal(workspace)

    // Unlink
    unlinkSync(join(workspace, '.brv'))

    // Second task: walked-up (worktreeRoot falls back to projectRoot)
    await createTask({clientCwd: workspace})
    const second = getSubmittedTask(1)
    expect(second.projectPath).to.equal(projectRoot)
    expect(second.worktreeRoot).to.equal(projectRoot)
  })

  it('should pick up new link target after overwrite', async () => {
    const projectA = join(testDir, 'project-a')
    const projectB = join(testDir, 'project-b')
    // Workspace must be descendant of both projects — use shared parent structure
    const workspaceA = join(projectA, 'sub')
    const workspaceB = join(projectB, 'sub')
    mkdirSync(workspaceA, {recursive: true})
    mkdirSync(workspaceB, {recursive: true})
    createBrvConfig(projectA)
    createBrvConfig(projectB)

    // Link workspace-a to project-a
    createWorkspaceLink(workspaceA, projectA)
    await createTask({clientCwd: workspaceA})
    expect(getSubmittedTask(0).projectPath).to.equal(projectA)

    // Link workspace-b to project-b
    createWorkspaceLink(workspaceB, projectB)
    await createTask({clientCwd: workspaceB})
    expect(getSubmittedTask(1).projectPath).to.equal(projectB)
  })

  it('should surface broken link as task:error', async () => {
    const projectRoot = join(testDir, 'project')
    const workspace = join(projectRoot, 'packages', 'api')
    mkdirSync(workspace, {recursive: true})
    // Link exists but target has no .brv/config.json
    createWorkspaceLink(workspace, '/nonexistent/project')

    await createTask({clientCwd: workspace})

    // Should NOT have been submitted to pool
    expect(agentPool.submitTask.called).to.be.false

    // Should have sent task:error
    const errorCall = (transportHelper.transport.sendTo as SinonStub)
      .getCalls()
      .find((c) => c.args[1] === TransportTaskEventNames.ERROR)
    expect(errorCall).to.exist
  })

  it('should bypass resolver when both projectPath and worktreeRoot are explicit', async () => {
    // Even with a broken link on disk, explicit paths should work
    const workspace = join(testDir, 'workspace')
    mkdirSync(workspace, {recursive: true})
    writeFileSync(join(workspace, '.brv'), 'invalid json')

    await createTask({
      clientCwd: workspace,
      projectPath: '/explicit/project',
      worktreeRoot: '/explicit/project/sub',
    })

    const submitted = getSubmittedTask()
    expect(submitted.projectPath).to.equal('/explicit/project')
    expect(submitted.worktreeRoot).to.equal('/explicit/project/sub')
  })

  it('should reject explicit worktreeRoot outside explicit projectPath', async () => {
    const taskId = randomUUID()
    await createTask({
      clientCwd: '/some/dir',
      projectPath: '/app',
      taskId,
      worktreeRoot: '/other-app/sub',
    })

    expect(agentPool.submitTask.called).to.be.false

    const errorCall = (transportHelper.transport.sendTo as SinonStub)
      .getCalls()
      .find((c) => c.args[1] === TransportTaskEventNames.ERROR)
    expect(errorCall).to.exist
    expect(errorCall!.args[2].error.message).to.include('worktreeRoot')
  })

  it('should use registered project path as fallback when resolver returns null', async () => {
    // No .brv/ anywhere, no link, no explicit paths
    const emptyDir = join(testDir, 'empty')
    mkdirSync(emptyDir, {recursive: true})

    const registeredPath = '/registered/project'
    const routerWithRegistration = new TaskRouter({
      agentPool,
      getAgentForProject: sandbox.stub().returns('agent-1'),
      projectRegistry: {
        get: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
        getAll: sandbox.stub().returns(new Map()),
        register: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
        unregister: sandbox.stub().returns(true),
      },
      projectRouter: {
        addToProjectRoom: sandbox.stub(),
        broadcastToProject: sandbox.stub(),
        getProjectMembers: sandbox.stub().returns([]),
        removeFromProjectRoom: sandbox.stub(),
      },
      resolveClientProjectPath: () => registeredPath,
      transport: transportHelper.transport,
    })
    routerWithRegistration.setup()

    // Need to use the new router's handlers
    const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)!
    const request = {
      clientCwd: emptyDir,
      content: 'test',
      taskId: randomUUID(),
      type: 'curate' as const,
    }
    await handler(request, 'client-1')
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })

    const submitted = agentPool.submitTask.lastCall?.args[0]
    expect(submitted.projectPath).to.equal(registeredPath)
  })

  it('should resolve fresh per task creation (no stale cache)', async () => {
    const projectRoot = join(testDir, 'project')
    const workspace = join(projectRoot, 'packages', 'api')
    mkdirSync(workspace, {recursive: true})
    createBrvConfig(projectRoot)

    // Task 1: no link — walked-up
    await createTask({clientCwd: workspace})
    expect(getSubmittedTask(0).worktreeRoot).to.equal(projectRoot)

    // Create link between tasks
    createWorkspaceLink(workspace, projectRoot)

    // Task 2: linked — resolver must pick up the new state
    await createTask({clientCwd: workspace})
    expect(getSubmittedTask(1).worktreeRoot).to.equal(workspace)
  })
})
