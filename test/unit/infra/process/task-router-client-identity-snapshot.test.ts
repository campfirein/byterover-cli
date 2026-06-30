/**
 * M15.8 — TaskRouter snapshots the submitting client's identity
 * (clientType + clientName) onto TaskInfo at task-create time so
 * AnalyticsHook can emit mcp_tool_called even if the MCP client
 * disconnects mid-task.
 */
import {expect} from 'chai'
import {randomUUID} from 'node:crypto'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAgentPool, SubmitTaskResult} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IProjectRegistry} from '../../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ITransportServer,
  RequestHandler,
} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'

import {TransportTaskEventNames} from '../../../../src/server/core/domain/transport/schemas.js'
import {TaskRouter} from '../../../../src/server/infra/process/task-router.js'

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

function makeStubProjectRegistry(sandbox: SinonSandbox): IProjectRegistry {
  return {
    get: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    getAll: sandbox.stub().returns(new Map()),
    register: sandbox.stub().callsFake((path: string) => makeProjectInfo(path)),
    unregister: sandbox.stub().returns(true),
  }
}

function makeStubProjectRouter(sandbox: SinonSandbox): IProjectRouter {
  return {
    addToProjectRoom: sandbox.stub(),
    broadcastToProject: sandbox.stub(),
    getProjectMembers: sandbox.stub().returns([]),
    removeFromProjectRoom: sandbox.stub(),
  }
}

const makeRequest = (overrides: Record<string, unknown> = {}) => ({
  content: 'do thing',
  projectPath: '/proj',
  taskId: randomUUID(),
  type: 'query-tool-mode' as const,
  ...overrides,
})

describe('TaskRouter handleTaskCreate client-identity snapshot (M15.8)', () => {
  let sandbox: SinonSandbox
  let transportHelper: ReturnType<typeof makeStubTransportServer>
  let agentPool: ReturnType<typeof makeStubAgentPool>
  let projectRegistry: ReturnType<typeof makeStubProjectRegistry>
  let projectRouter: ReturnType<typeof makeStubProjectRouter>
  let getAgentForProject: SinonStub

  beforeEach(() => {
    sandbox = createSandbox()
    transportHelper = makeStubTransportServer(sandbox)
    agentPool = makeStubAgentPool(sandbox)
    projectRegistry = makeStubProjectRegistry(sandbox)
    projectRouter = makeStubProjectRouter(sandbox)
    getAgentForProject = sandbox.stub().returns('agent-1')
  })

  afterEach(() => sandbox.restore())

  it('stamps clientType + clientName from resolveClientIdentity onto the stored TaskInfo', async () => {
    const resolveClientIdentity = sandbox.stub().returns({clientName: 'Cursor', clientType: 'mcp'})
    const router = new TaskRouter({
      agentPool,
      getAgentForProject,
      projectRegistry,
      projectRouter,
      resolveClientIdentity,
      transport: transportHelper.transport,
    })
    router.setup()

    const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
    expect(handler).to.exist
    const request = makeRequest()
    await handler!(request, 'sock-1')

    expect(resolveClientIdentity.calledWith('sock-1')).to.equal(true)
    const stored = router.getTasksForProject('/proj').find((t) => t.taskId === request.taskId)
    expect(stored, 'task should be stored after handleTaskCreate').to.exist
    expect(stored!.clientType).to.equal('mcp')
    expect(stored!.clientName).to.equal('Cursor')
  })

  it('omits clientName when the resolver returns only clientType', async () => {
    const resolveClientIdentity = sandbox.stub().returns({clientType: 'cli'})
    const router = new TaskRouter({
      agentPool,
      getAgentForProject,
      projectRegistry,
      projectRouter,
      resolveClientIdentity,
      transport: transportHelper.transport,
    })
    router.setup()

    const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
    const request = makeRequest()
    await handler!(request, 'sock-cli')

    const stored = router.getTasksForProject('/proj').find((t) => t.taskId === request.taskId)
    expect(stored).to.exist
    expect(stored!.clientType).to.equal('cli')
    expect(stored!.clientName).to.equal(undefined)
  })

  it('leaves both fields undefined when no resolver is configured', async () => {
    const router = new TaskRouter({
      agentPool,
      getAgentForProject,
      projectRegistry,
      projectRouter,
      transport: transportHelper.transport,
    })
    router.setup()

    const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
    const request = makeRequest()
    await handler!(request, 'sock-x')

    const stored = router.getTasksForProject('/proj').find((t) => t.taskId === request.taskId)
    expect(stored).to.exist
    expect(stored!.clientType).to.equal(undefined)
    expect(stored!.clientName).to.equal(undefined)
  })

  it('leaves both fields undefined when resolver returns undefined (unknown client)', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined
    const resolveClientIdentity = sandbox.stub().returns(undefined)
    const router = new TaskRouter({
      agentPool,
      getAgentForProject,
      projectRegistry,
      projectRouter,
      resolveClientIdentity,
      transport: transportHelper.transport,
    })
    router.setup()

    const handler = transportHelper.requestHandlers.get(TransportTaskEventNames.CREATE)
    const request = makeRequest()
    await handler!(request, 'sock-y')

    const stored = router.getTasksForProject('/proj').find((t) => t.taskId === request.taskId)
    expect(stored).to.exist
    expect(stored!.clientType).to.equal(undefined)
    expect(stored!.clientName).to.equal(undefined)
  })
})
