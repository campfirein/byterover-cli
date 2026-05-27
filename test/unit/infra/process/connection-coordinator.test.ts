/**
 * ConnectionCoordinator Unit Tests
 *
 * Tests the client/agent connection lifecycle management.
 *
 * Key scenarios:
 * - Agent registration with/without projectPath
 * - Agent disconnect → remove + notify pool + fail tasks
 * - Client registration (valid types, invalid type fallback)
 * - Client project association (global-scope MCP flow)
 * - Client agent name update (MCP handshake)
 * - getAgentForProject lookup order (exact, fallback, first available)
 * - Agent control commands (restart, newSession)
 * - Connection/disconnection lifecycle (agent vs external client)
 */

import {expect} from 'chai'
import {createSandbox, type SinonSandbox, type SinonStub} from 'sinon'

import type {IAgentPool} from '../../../../src/server/core/interfaces/agent/i-agent-pool.js'
import type {IClientManager} from '../../../../src/server/core/interfaces/client/i-client-manager.js'
import type {IProjectRegistry} from '../../../../src/server/core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../../../src/server/core/interfaces/routing/i-project-router.js'
import type {
  ConnectionHandler,
  ITransportServer,
  RequestHandler,
} from '../../../../src/server/core/interfaces/transport/i-transport-server.js'
import type {TaskRouter} from '../../../../src/server/infra/process/task-router.js'

import {ClientInfo} from '../../../../src/server/core/domain/client/client-info.js'
import {
  AgentStatusEventNames,
  TransportAgentEventNames,
  TransportClientEventNames,
} from '../../../../src/server/core/domain/transport/schemas.js'
import {ConnectionCoordinator} from '../../../../src/server/infra/process/connection-coordinator.js'

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
  let connectionHandler: ConnectionHandler | undefined
  let disconnectionHandler: ConnectionHandler | undefined

  const transport: ITransportServer = {
    addToRoom: sandbox.stub(),
    broadcast: sandbox.stub(),
    broadcastTo: sandbox.stub(),
    getPort: sandbox.stub().returns(3000),
    isRunning: sandbox.stub().returns(true),
    onConnection: sandbox.stub().callsFake((handler: ConnectionHandler) => {
      connectionHandler = handler
    }),
    onDisconnection: sandbox.stub().callsFake((handler: ConnectionHandler) => {
      disconnectionHandler = handler
    }),
    onRequest: sandbox.stub().callsFake((event: string, handler: RequestHandler) => {
      requestHandlers.set(event, handler)
    }),
    removeFromRoom: sandbox.stub(),
    sendTo: sandbox.stub(),
    start: sandbox.stub().resolves(),
    stop: sandbox.stub().resolves(),
  }

  return {
    requestHandlers,
    simulateConnect(clientId: string) {
      connectionHandler?.(clientId, {})
    },
    simulateDisconnect(clientId: string) {
      disconnectionHandler?.(clientId, {})
    },
    transport,
  }
}

function makeStubClientManager(sandbox: SinonSandbox): IClientManager & {
  associateProject: SinonStub
  getClient: SinonStub
  register: SinonStub
  setAgentName: SinonStub
  unregister: SinonStub
  updateProjectPath: SinonStub
} {
  return {
    associateProject: sandbox.stub(),
    getActiveProjects: sandbox.stub().returns([]),
    getAllClients: sandbox.stub().returns([]),
    getClient: sandbox.stub(),
    getClientsByProject: sandbox.stub().returns([]),
    onClientConnected: sandbox.stub(),
    onClientDisconnected: sandbox.stub(),
    onProjectEmpty: sandbox.stub(),
    register: sandbox.stub(),
    setAgentName: sandbox.stub(),
    unregister: sandbox.stub(),
    updateProjectPath: sandbox.stub(),
  }
}

function makeStubAgentPool(sandbox: SinonSandbox): IAgentPool & {handleAgentDisconnected: SinonStub} {
  return {
    cancelQueuedTask: sandbox.stub().returns(false),
    getEntries: sandbox.stub().returns([]),
    getSize: sandbox.stub().returns(0),
    handleAgentDisconnected: sandbox.stub(),
    hasAgent: sandbox.stub().returns(false),
    markIdle: sandbox.stub(),
    notifyTaskCompleted: sandbox.stub(),
    shutdown: sandbox.stub().resolves(),
    submitTask: sandbox.stub().resolves({success: true}),
  }
}

function makeStubProjectRegistry(sandbox: SinonSandbox): IProjectRegistry & {
  get: SinonStub
  register: SinonStub
} {
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

function makeStubTaskRouter(sandbox: SinonSandbox): TaskRouter & {
  failTask: SinonStub
  getTasksForProject: SinonStub
} {
  return {
    failTask: sandbox.stub(),
    getTasksForProject: sandbox.stub().returns([]),
  } as unknown as TaskRouter & {failTask: SinonStub; getTasksForProject: SinonStub}
}

// ============================================================================
// Tests
// ============================================================================

describe('ConnectionCoordinator', () => {
  let sandbox: SinonSandbox
  let transportHelper: ReturnType<typeof makeStubTransportServer>
  let clientManager: ReturnType<typeof makeStubClientManager>
  let agentPool: ReturnType<typeof makeStubAgentPool>
  let projectRegistry: ReturnType<typeof makeStubProjectRegistry>
  let projectRouter: ReturnType<typeof makeStubProjectRouter>
  let taskRouter: ReturnType<typeof makeStubTaskRouter>
  let coordinator: ConnectionCoordinator

  beforeEach(() => {
    sandbox = createSandbox()

    transportHelper = makeStubTransportServer(sandbox)
    clientManager = makeStubClientManager(sandbox)
    agentPool = makeStubAgentPool(sandbox)
    projectRegistry = makeStubProjectRegistry(sandbox)
    projectRouter = makeStubProjectRouter(sandbox)
    taskRouter = makeStubTaskRouter(sandbox)

    coordinator = new ConnectionCoordinator({
      agentPool,
      clientManager,
      projectRegistry,
      projectRouter,
      taskRouter,
      transport: transportHelper.transport,
    })

    coordinator.setup()
  })

  afterEach(() => {
    sandbox.restore()
  })

  // ==========================================================================
  // Agent Registration
  // ==========================================================================

  describe('agent registration', () => {
    it('should register agent with projectPath', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      expect(handler).to.exist

      const result = handler!({projectPath: '/app'}, 'agent-1')
      expect(result).to.deep.equal({success: true})

      // Should track agent internally
      expect(coordinator.getAgentForProject('/app')).to.equal('agent-1')

      // Should register with ClientManager as type 'agent'
      expect(clientManager.register.calledWith('agent-1', 'agent', '/app')).to.be.true
    })

    it('should register agent without projectPath (empty-string key)', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      handler!({}, 'agent-1')

      // Should be findable via empty-string fallback
      expect(coordinator.getAgentForProject('/anything')).to.equal('agent-1')

      // Should register with ClientManager without projectPath (3rd arg omitted)
      expect(clientManager.register.lastCall.args).to.deep.equal(['agent-1', 'agent', undefined])
    })

    it('should add agent to project room when projectPath provided', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      handler!({projectPath: '/app'}, 'agent-1')

      expect(projectRegistry.register.calledWith('/app')).to.be.true
      expect((projectRouter.addToProjectRoom as SinonStub).calledOnce).to.be.true
    })

    it('should NOT add agent to project room when no projectPath', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      handler!({}, 'agent-1')

      expect((projectRouter.addToProjectRoom as SinonStub).called).to.be.false
    })

    it('should broadcast agent:connected to project room', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      handler!({projectPath: '/app'}, 'agent-1')

      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          TransportAgentEventNames.CONNECTED,
          {},
        ),
      ).to.be.true
    })
  })

  // ==========================================================================
  // Agent Disconnect
  // ==========================================================================

  describe('agent disconnect', () => {
    beforeEach(() => {
      // Register an agent first
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
      // Reset stubs after registration
      agentPool.handleAgentDisconnected.resetHistory()
      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()
    })

    it('should remove agent from tracking on disconnect', () => {
      transportHelper.simulateDisconnect('agent-1')

      expect(coordinator.getAgentForProject('/app')).to.be.undefined
    })

    it('should notify agent pool of disconnect', () => {
      transportHelper.simulateDisconnect('agent-1')

      expect(agentPool.handleAgentDisconnected.calledWith('/app')).to.be.true
    })

    it('should broadcast agent:disconnected to project room', () => {
      transportHelper.simulateDisconnect('agent-1')

      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          TransportAgentEventNames.DISCONNECTED,
          {},
        ),
      ).to.be.true
    })

    it('should fail active tasks for disconnected agent project', () => {
      const tasks = [
        {
          clientId: 'client-1',
          content: 'test',
          createdAt: Date.now(),
          projectPath: '/app',
          taskId: 'task-1',
          type: 'curate',
        },
        {
          clientId: 'client-2',
          content: 'test2',
          createdAt: Date.now(),
          projectPath: '/app',
          taskId: 'task-2',
          type: 'query',
        },
      ]
      taskRouter.getTasksForProject.withArgs('/app').returns(tasks)

      transportHelper.simulateDisconnect('agent-1')

      expect(taskRouter.failTask.calledTwice).to.be.true
      expect(taskRouter.failTask.firstCall.args[0]).to.equal('task-1')
      expect(taskRouter.failTask.secondCall.args[0]).to.equal('task-2')
      // Error should be AgentDisconnectedError
      expect(taskRouter.failTask.firstCall.args[1]).to.have.property('name', 'AgentDisconnectedError')
    })

    it('should unregister agent from ClientManager', () => {
      // ClientManager.getClient returns a ClientInfo for agent
      clientManager.getClient
        .withArgs('agent-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'agent-1', projectPath: '/app', type: 'agent'}))

      transportHelper.simulateDisconnect('agent-1')

      expect(clientManager.unregister.calledWith('agent-1')).to.be.true
    })

    it('should remove agent from project room on disconnect', () => {
      transportHelper.simulateDisconnect('agent-1')

      expect((projectRouter.removeFromProjectRoom as SinonStub).calledOnce).to.be.true
    })
  })

  // ==========================================================================
  // Client Registration
  // ==========================================================================

  describe('client registration', () => {
    it('should register client with valid type', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)
      expect(handler).to.exist

      const result = handler!({clientType: 'tui', projectPath: '/app'}, 'client-1')
      expect(result).to.deep.equal({success: true})

      expect(clientManager.register.calledWith('client-1', 'tui', '/app')).to.be.true
    })

    it('should fallback to cli for missing clientType', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)

      handler!({clientType: undefined, projectPath: '/app'}, 'client-1')

      expect(clientManager.register.calledWith('client-1', 'cli', '/app')).to.be.true
    })

    it('should fallback to cli for invalid clientType', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)

      handler!({clientType: 'invalid_type', projectPath: '/app'}, 'client-1')

      expect(clientManager.register.calledWith('client-1', 'cli', '/app')).to.be.true
    })

    it('should register extension client type', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)

      handler!({clientType: 'extension', projectPath: '/app'}, 'client-1')

      expect(clientManager.register.calledWith('client-1', 'extension', '/app')).to.be.true
    })

    it('should add client to project room when projectPath provided', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)

      handler!({clientType: 'tui', projectPath: '/app'}, 'client-1')

      expect(projectRegistry.register.calledWith('/app')).to.be.true
      expect((projectRouter.addToProjectRoom as SinonStub).calledOnce).to.be.true
    })

    it('should NOT add client to project room when no projectPath (global MCP)', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)

      handler!({clientType: 'mcp'}, 'client-1')

      expect((projectRouter.addToProjectRoom as SinonStub).called).to.be.false
    })

    it('should return error when clientManager not available', () => {
      // Use a dedicated transport to avoid handler collision
      const helper2 = makeStubTransportServer(sandbox)
      const coord2 = new ConnectionCoordinator({
        taskRouter: makeStubTaskRouter(sandbox),
        transport: helper2.transport,
      })
      coord2.setup()

      const handler = helper2.requestHandlers.get(TransportClientEventNames.REGISTER)
      const result = handler!({clientType: 'tui'}, 'client-1')

      expect(result).to.deep.equal({error: 'ClientManager not available', success: false})
    })

    it('should include daemonVersion in ack when coordinator was constructed with one', () => {
      // The daemon reads its own version from package.json at startup and
      // surfaces it via the register ack. Clients use this to drive version-
      // drift indicators (TUI header, MCP tool footer) without an extra round-trip.
      const helper3 = makeStubTransportServer(sandbox)
      const coord3 = new ConnectionCoordinator({
        clientManager: makeStubClientManager(sandbox),
        daemonVersion: '3.10.0',
        taskRouter: makeStubTaskRouter(sandbox),
        transport: helper3.transport,
      })
      coord3.setup()

      const handler = helper3.requestHandlers.get(TransportClientEventNames.REGISTER)
      const result = handler!({clientType: 'tui', projectPath: '/app'}, 'client-1')

      expect(result).to.deep.equal({daemonVersion: '3.10.0', success: true})
    })

    it('should omit daemonVersion in ack when coordinator was not given one', () => {
      // Backward compat: pre-fix daemons (and tests that don't wire the version)
      // continue to send `{success: true}` only.
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)

      const result = handler!({clientType: 'tui', projectPath: '/app'}, 'client-1')

      expect(result).to.deep.equal({success: true})
    })
  })

  // ==========================================================================
  // Client Associate Project
  // ==========================================================================

  describe('client:associateProject', () => {
    it('should associate client with project', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)
      expect(handler).to.exist

      // Client exists but has no project
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', type: 'mcp'}))

      const result = handler!({projectPath: '/app'}, 'client-1')
      expect(result).to.deep.equal({success: true})

      expect(clientManager.associateProject.calledWith('client-1', '/app')).to.be.true
    })

    it('should add client to project room after association', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)

      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', type: 'mcp'}))

      handler!({projectPath: '/app'}, 'client-1')

      expect(projectRegistry.register.calledWith('/app')).to.be.true
      expect((projectRouter.addToProjectRoom as SinonStub).calledOnce).to.be.true
    })

    it('should return success (no-op) if client already has project', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)

      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/existing', type: 'mcp'}))

      const result = handler!({projectPath: '/app'}, 'client-1')
      expect(result).to.deep.equal({success: true})

      // Should NOT call associateProject since client already has a project
      expect(clientManager.associateProject.called).to.be.false
    })

    it('should return error if client not registered', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)

      // getClient returns undefined by default (from makeStubClientManager)
      const result = handler!({projectPath: '/app'}, 'client-1')
      expect(result).to.deep.equal({error: 'Client not registered', success: false})
    })
  })

  // ==========================================================================
  // Client Update Agent Name
  // ==========================================================================

  describe('client:updateAgentName', () => {
    it('should set agent name on client', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.UPDATE_AGENT_NAME)
      expect(handler).to.exist

      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', type: 'mcp'}))

      const result = handler!({agentName: 'Windsurf'}, 'client-1')
      expect(result).to.deep.equal({success: true})

      expect(clientManager.setAgentName.calledWith('client-1', 'Windsurf')).to.be.true
    })

    it('should return error if client not registered', () => {
      const handler = transportHelper.requestHandlers.get(TransportClientEventNames.UPDATE_AGENT_NAME)

      // getClient returns undefined by default (from makeStubClientManager)
      const result = handler!({agentName: 'Windsurf'}, 'client-1')
      expect(result).to.deep.equal({error: 'Client not registered', success: false})
    })
  })

  // ==========================================================================
  // getAgentForProject
  // ==========================================================================

  describe('getAgentForProject', () => {
    it('should return exact match agent for project', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
      handler!({projectPath: '/other'}, 'agent-2')

      expect(coordinator.getAgentForProject('/app')).to.equal('agent-1')
      expect(coordinator.getAgentForProject('/other')).to.equal('agent-2')
    })

    it('should fallback to empty-string key agent', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({}, 'agent-fallback')

      expect(coordinator.getAgentForProject('/unknown')).to.equal('agent-fallback')
    })

    it('should return first available agent when no projectPath requested', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')

      // No projectPath → should return first available
      expect(coordinator.getAgentForProject()).to.equal('agent-1')
    })

    it('should return undefined when no agents registered', () => {
      expect(coordinator.getAgentForProject('/app')).to.be.undefined
    })

    it('should prefer exact match over empty-string fallback', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({}, 'agent-fallback')
      handler!({projectPath: '/app'}, 'agent-exact')

      expect(coordinator.getAgentForProject('/app')).to.equal('agent-exact')
    })
  })

  // ==========================================================================
  // Connection / Disconnection lifecycle
  // ==========================================================================

  describe('connection lifecycle', () => {
    it('should handle external client disconnect — remove from project room and unregister', () => {
      // Register an external client
      const registerHandler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)
      registerHandler!({clientType: 'tui', projectPath: '/app'}, 'client-1')

      // Set up getClient to return the client info (for disconnect handling)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      transportHelper.simulateDisconnect('client-1')

      // Should remove from project room
      expect((projectRouter.removeFromProjectRoom as SinonStub).called).to.be.true
      // Should unregister from ClientManager
      expect(clientManager.unregister.calledWith('client-1')).to.be.true
    })

    it('should NOT double-remove agent from project room on disconnect', () => {
      // Register an agent
      const agentHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      agentHandler!({projectPath: '/app'}, 'agent-1')
      ;(projectRouter.removeFromProjectRoom as SinonStub).resetHistory()

      // Simulate agent disconnect — agent removal is handled by handleAgentDisconnect
      clientManager.getClient
        .withArgs('agent-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'agent-1', projectPath: '/app', type: 'agent'}))

      transportHelper.simulateDisconnect('agent-1')

      // removeFromProjectRoom should be called exactly once (by handleAgentDisconnect),
      // not twice (not also by the general disconnect handler)
      expect((projectRouter.removeFromProjectRoom as SinonStub).calledOnce).to.be.true
    })
  })

  // ==========================================================================
  // Agent Control: restart
  // ==========================================================================

  describe('agent:restart', () => {
    beforeEach(() => {
      // Register an agent
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
    })

    it('should forward restart to agent', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTART)
      expect(handler).to.exist

      // Client requesting restart is associated with /app
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      const result = handler!({reason: 'config changed'}, 'client-1')
      expect(result).to.deep.equal({success: true})

      // Should sendTo agent
      expect(
        (transportHelper.transport.sendTo as SinonStub).calledWith('agent-1', TransportAgentEventNames.RESTART, {
          reason: 'config changed',
        }),
      ).to.be.true
    })

    it('should return error when no agent connected', () => {
      // Clear agents
      coordinator.clearAgentClients()

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTART)

      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      const result = handler!({reason: 'test'}, 'client-1')
      expect(result).to.deep.equal({error: 'Agent not connected', success: false})
    })

    it('should broadcast agent:restarted on success', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTARTED)

      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      handler!({success: true}, 'agent-1')

      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          TransportAgentEventNames.RESTARTED,
          {success: true},
        ),
      ).to.be.true
    })

    it('should broadcast agent:restarted with error on failure', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTARTED)

      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      handler!({error: 'init failed', success: false}, 'agent-1')

      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          TransportAgentEventNames.RESTARTED,
          {error: 'init failed', success: false},
        ),
      ).to.be.true
    })
  })

  // ==========================================================================
  // Agent Control: newSession
  // ==========================================================================

  describe('agent:newSession', () => {
    beforeEach(() => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
    })

    it('should forward newSession request to agent', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)
      expect(handler).to.exist

      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      const result = handler!({reason: 'user requested'}, 'client-1')
      expect(result).to.deep.equal({success: true})

      expect(
        (transportHelper.transport.sendTo as SinonStub).calledWith('agent-1', TransportAgentEventNames.NEW_SESSION, {
          reason: 'user requested',
        }),
      ).to.be.true
    })

    it('should clear active session and return success when no agent connected', () => {
      coordinator.clearAgentClients()

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)

      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      const result = handler!({reason: 'test'}, 'client-1')
      expect(result).to.deep.equal({success: true})
    })

    it('should broadcast newSessionCreated on success', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION_CREATED)

      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      handler!({sessionId: 'session-123', success: true}, 'agent-1')

      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          TransportAgentEventNames.NEW_SESSION_CREATED,
          {sessionId: 'session-123', success: true},
        ),
      ).to.be.true
    })

    it('should broadcast newSessionCreated with error on failure', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION_CREATED)

      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      handler!({error: 'session creation failed', success: false}, 'agent-1')

      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          TransportAgentEventNames.NEW_SESSION_CREATED,
          {error: 'session creation failed', success: false},
        ),
      ).to.be.true
    })
  })

  // ==========================================================================
  // Agent Status
  // ==========================================================================

  describe('agent status', () => {
    it('should broadcast agent status changes to project room', () => {
      const registerHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-1')
      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      const handler = transportHelper.requestHandlers.get(AgentStatusEventNames.STATUS_CHANGED)
      expect(handler).to.exist

      const statusData = {activeTasks: 0, hasAuth: true, hasConfig: true, isInitialized: true, queuedTasks: 0}
      handler!(statusData, 'agent-1')

      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          AgentStatusEventNames.STATUS_CHANGED,
          statusData,
        ),
      ).to.be.true
    })
  })

  // ==========================================================================
  // clearAgentClients / getDebugAgentClients
  // ==========================================================================

  describe('utility methods', () => {
    it('should clear all agent clients', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
      handler!({projectPath: '/other'}, 'agent-2')

      coordinator.clearAgentClients()

      expect(coordinator.getAgentForProject('/app')).to.be.undefined
      expect(coordinator.getAgentForProject('/other')).to.be.undefined
    })

    it('should return debug agent client entries', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')

      const entries = coordinator.getDebugAgentClients()
      expect(entries).to.deep.equal([{clientId: 'agent-1', projectPath: '/app'}])
    })

    it('should return empty array when no agents registered', () => {
      expect(coordinator.getDebugAgentClients()).to.deep.equal([])
    })
  })

  // ==========================================================================
  // Graceful Degradation — Optional Dependencies Missing
  // ==========================================================================

  describe('graceful degradation (minimal config)', () => {
    let minimalHelper: ReturnType<typeof makeStubTransportServer>
    let minimalTaskRouter: ReturnType<typeof makeStubTaskRouter>
    let minimalCoordinator: ConnectionCoordinator

    beforeEach(() => {
      minimalHelper = makeStubTransportServer(sandbox)
      minimalTaskRouter = makeStubTaskRouter(sandbox)
      minimalCoordinator = new ConnectionCoordinator({
        taskRouter: minimalTaskRouter,
        transport: minimalHelper.transport,
      })
      minimalCoordinator.setup()
    })

    it('should not throw when agentPool is undefined and agent disconnects', () => {
      const handler = minimalHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')

      expect(() => minimalHelper.simulateDisconnect('agent-1')).to.not.throw()
      expect(minimalCoordinator.getAgentForProject('/app')).to.be.undefined
    })

    it('should still track agent when projectRegistry is undefined', () => {
      const handler = minimalHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')

      expect(minimalCoordinator.getAgentForProject('/app')).to.equal('agent-1')
    })

    it('should still track agent when projectRouter is undefined', () => {
      // Coordinator with projectRegistry but no projectRouter
      const helper2 = makeStubTransportServer(sandbox)
      const coord2 = new ConnectionCoordinator({
        projectRegistry: makeStubProjectRegistry(sandbox),
        taskRouter: makeStubTaskRouter(sandbox),
        transport: helper2.transport,
      })
      coord2.setup()

      const handler = helper2.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')

      expect(coord2.getAgentForProject('/app')).to.equal('agent-1')
    })

    it('should still clean up internal state on disconnect when projectRegistry is undefined', () => {
      const handler = minimalHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')

      minimalHelper.simulateDisconnect('agent-1')

      // Agent removed from tracking despite no projectRegistry/projectRouter
      expect(minimalCoordinator.getAgentForProject('/app')).to.be.undefined
      // Tasks still failed
      expect(minimalTaskRouter.getTasksForProject.called).to.be.true
    })

    it('should not throw broadcast when projectRouter is undefined', () => {
      const handler = minimalHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      // Registration triggers broadcastToProjectRoom — should not throw
      expect(() => handler!({projectPath: '/app'}, 'agent-1')).to.not.throw()

      // Disconnect also triggers broadcast — should not throw
      expect(() => minimalHelper.simulateDisconnect('agent-1')).to.not.throw()
    })

    it('should handle full agent lifecycle with no optional deps', () => {
      const registerHandler = minimalHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      // Register
      const result = registerHandler!({projectPath: '/app'}, 'agent-1')
      expect(result).to.deep.equal({success: true})
      expect(minimalCoordinator.getAgentForProject('/app')).to.equal('agent-1')

      // Disconnect
      minimalHelper.simulateDisconnect('agent-1')
      expect(minimalCoordinator.getAgentForProject('/app')).to.be.undefined
      expect(minimalCoordinator.getDebugAgentClients()).to.deep.equal([])
    })

    it('should return error when clientManager not available for associateProject', () => {
      const handler = minimalHelper.requestHandlers.get(TransportClientEventNames.ASSOCIATE_PROJECT)
      const result = handler!({projectPath: '/app'}, 'client-1')

      expect(result).to.deep.equal({error: 'ClientManager not available', success: false})
    })

    it('should return error when clientManager not available for updateAgentName', () => {
      const handler = minimalHelper.requestHandlers.get(TransportClientEventNames.UPDATE_AGENT_NAME)
      const result = handler!({agentName: 'Windsurf'}, 'client-1')

      expect(result).to.deep.equal({error: 'ClientManager not available', success: false})
    })
  })

  // ==========================================================================
  // Multi-Agent / Multi-Project State Integrity
  // ==========================================================================

  describe('multi-agent state integrity', () => {
    it('should replace agent when new agent registers for same project', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      handler!({projectPath: '/app'}, 'agent-1')
      handler!({projectPath: '/app'}, 'agent-2')

      expect(coordinator.getAgentForProject('/app')).to.equal('agent-2')
      // Only one entry in debug (Map overwrites)
      const entries = coordinator.getDebugAgentClients()
      expect(entries).to.have.lengthOf(1)
      expect(entries[0]).to.deep.equal({clientId: 'agent-2', projectPath: '/app'})
    })

    it('should only disconnect specific agent, other project agents remain', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
      handler!({projectPath: '/other'}, 'agent-2')

      transportHelper.simulateDisconnect('agent-1')

      expect(coordinator.getAgentForProject('/app')).to.be.undefined
      expect(coordinator.getAgentForProject('/other')).to.equal('agent-2')
    })

    it('should only fail tasks for disconnected agent project, not other projects', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
      handler!({projectPath: '/other'}, 'agent-2')

      const appTasks = [
        {
          clientId: 'c1',
          content: 'test',
          createdAt: Date.now(),
          projectPath: '/app',
          taskId: 'task-app',
          type: 'curate',
        },
      ]
      const otherTasks = [
        {
          clientId: 'c2',
          content: 'test',
          createdAt: Date.now(),
          projectPath: '/other',
          taskId: 'task-other',
          type: 'query',
        },
      ]
      taskRouter.getTasksForProject.withArgs('/app').returns(appTasks)
      taskRouter.getTasksForProject.withArgs('/other').returns(otherTasks)

      transportHelper.simulateDisconnect('agent-1')

      // getTasksForProject called with '/app', not '/other'
      expect(taskRouter.getTasksForProject.calledWith('/app')).to.be.true
      expect(taskRouter.getTasksForProject.calledWith('/other')).to.be.false
      // Only app task failed
      expect(taskRouter.failTask.calledOnce).to.be.true
      expect(taskRouter.failTask.firstCall.args[0]).to.equal('task-app')
    })

    it('should handle register → disconnect → re-register without stale state', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      // Cycle 1
      handler!({projectPath: '/app'}, 'agent-1')
      transportHelper.simulateDisconnect('agent-1')
      expect(coordinator.getAgentForProject('/app')).to.be.undefined

      // Cycle 2 — fresh agent
      handler!({projectPath: '/app'}, 'agent-2')
      expect(coordinator.getAgentForProject('/app')).to.equal('agent-2')
      expect(coordinator.getDebugAgentClients()).to.deep.equal([{clientId: 'agent-2', projectPath: '/app'}])
    })

    it('should handle empty-string agent disconnect when project-specific agents also exist', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({}, 'agent-fallback') // stored under '' key
      handler!({projectPath: '/app'}, 'agent-specific')

      transportHelper.simulateDisconnect('agent-fallback')

      // Fallback removed, specific remains
      expect(coordinator.getAgentForProject('/app')).to.equal('agent-specific')
      // No '' key fallback anymore
      expect(coordinator.getAgentForProject('/unknown')).to.be.undefined
    })
  })

  // ==========================================================================
  // getAgentForProject — Lookup Boundary
  // ==========================================================================

  describe('getAgentForProject — boundary cases', () => {
    it('should NOT return first available when projectPath provided but no match', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/other'}, 'agent-1')

      // Explicit projectPath with no match — should NOT fallback to /other agent
      expect(coordinator.getAgentForProject('/app')).to.be.undefined
    })

    it('should treat empty string projectPath as falsy (falls through to fallback)', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({}, 'agent-fallback') // stored under '' key

      // Empty string is falsy → skips exact match → checks '' key → finds fallback
      expect(coordinator.getAgentForProject('')).to.equal('agent-fallback')
    })

    it('should return first available from multiple agents when no projectPath requested', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
      handler!({projectPath: '/other'}, 'agent-2')
      handler!({projectPath: '/third'}, 'agent-3')

      // No projectPath → first available
      const result = coordinator.getAgentForProject()
      expect(result).to.be.a('string')
      // Should be one of the registered agents
      expect(['agent-1', 'agent-2', 'agent-3']).to.include(result)
    })
  })

  // ==========================================================================
  // Agent Disconnect — Edge Cases
  // ==========================================================================

  describe('agent disconnect — edge cases', () => {
    it('should handle disconnect for agent that was never registered (no-op)', () => {
      // No agents registered — simulate disconnect for unknown agent
      expect(() => transportHelper.simulateDisconnect('unknown-agent')).to.not.throw()

      // ClientManager.unregister still called (for cleanup)
      expect(clientManager.unregister.calledWith('unknown-agent')).to.be.true
    })

    it('should handle disconnect for agent without projectPath (empty-string key)', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({}, 'agent-fallback') // stored under '' key

      agentPool.handleAgentDisconnected.resetHistory()
      ;(projectRouter.removeFromProjectRoom as SinonStub).resetHistory()

      transportHelper.simulateDisconnect('agent-fallback')

      // Agent removed from tracking
      expect(coordinator.getAgentForProject('/anything')).to.be.undefined

      // findProjectForAgent returns undefined for '' key → no room removal, no pool notify
      expect(agentPool.handleAgentDisconnected.called).to.be.false
      expect((projectRouter.removeFromProjectRoom as SinonStub).called).to.be.false
    })

    it('should fail tasks with undefined projectPath when projectless agent disconnects', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({}, 'agent-fallback')

      const projectlessTasks = [
        {
          clientId: 'c1',
          content: 'test',
          createdAt: Date.now(),
          projectPath: undefined,
          taskId: 'task-1',
          type: 'curate',
        },
      ]
      // eslint-disable-next-line unicorn/no-useless-undefined
      taskRouter.getTasksForProject.withArgs(undefined).returns(projectlessTasks)

      transportHelper.simulateDisconnect('agent-fallback')

      // getTasksForProject called with undefined (since findProjectForAgent returns undefined for '' key)
      // eslint-disable-next-line unicorn/no-useless-undefined
      expect(taskRouter.getTasksForProject.calledWith(undefined)).to.be.true
      expect(taskRouter.failTask.calledOnce).to.be.true
      expect(taskRouter.failTask.firstCall.args[0]).to.equal('task-1')
    })

    it('should not call agentPool.handleAgentDisconnected when agent had no projectPath', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({}, 'agent-fallback')

      agentPool.handleAgentDisconnected.resetHistory()

      transportHelper.simulateDisconnect('agent-fallback')

      expect(agentPool.handleAgentDisconnected.called).to.be.false
    })
  })

  // ==========================================================================
  // Agent Control — Client Project Resolution
  // ==========================================================================

  describe('agent control — client project resolution', () => {
    it('should find agent via fallback when restart client has no projectPath', () => {
      const registerHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({}, 'agent-fallback') // no projectPath → '' key

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTART)

      // Client has no projectPath → getClient returns client without projectPath
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', type: 'mcp'}))

      const result = handler!({reason: 'test'}, 'client-1')
      expect(result).to.deep.equal({success: true})

      // Should send to fallback agent
      expect(
        (transportHelper.transport.sendTo as SinonStub).calledWith('agent-fallback', TransportAgentEventNames.RESTART, {
          reason: 'test',
        }),
      ).to.be.true
    })

    it('should broadcast agent:restarting event to project room', () => {
      const registerHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-1')
      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTART)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      handler!({reason: 'config changed'}, 'client-1')

      // Should broadcast RESTARTING (not just RESTARTED)
      expect(
        (projectRouter.broadcastToProject as SinonStub).calledWith(
          makeProjectInfo('/app').sanitizedPath,
          TransportAgentEventNames.RESTARTING,
          {reason: 'config changed'},
        ),
      ).to.be.true
    })

    it('should not throw when clearActiveSession project is not in registry (newSession)', () => {
      // No agent → newSession triggers clearActiveSession
      coordinator.clearAgentClients()

      // projectRegistry.get returns undefined for this path
      // eslint-disable-next-line unicorn/no-useless-undefined
      projectRegistry.get.withArgs('/unknown').returns(undefined)

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/unknown', type: 'tui'}))

      expect(() => handler!({reason: 'test'}, 'client-1')).to.not.throw()
    })

    it('should handle newSession when clientManager is undefined', () => {
      // Create coordinator without clientManager
      const helper2 = makeStubTransportServer(sandbox)
      const taskRouter2 = makeStubTaskRouter(sandbox)
      const coord2 = new ConnectionCoordinator({
        taskRouter: taskRouter2,
        transport: helper2.transport,
      })
      coord2.setup()

      const handler = helper2.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)

      // No clientManager → clientProject is undefined → getAgentForProject(undefined) → no agent
      const result = handler!({reason: 'test'}, 'client-1')
      expect(result).to.deep.equal({success: true})
    })

    it('should return error when client project has no matching agent (restart)', () => {
      // Agent for /other, client for /app
      const registerHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/other'}, 'agent-1')

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTART)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      const result = handler!({reason: 'test'}, 'client-1')
      expect(result).to.deep.equal({error: 'Agent not connected', success: false})
    })
  })

  // ==========================================================================
  // Connection Handler — Edge Cases
  // ==========================================================================

  describe('connection handler — edge cases', () => {
    it('should unregister from clientManager even when getClient returns undefined', () => {
      // getClient returns undefined (default stub behavior)
      transportHelper.simulateDisconnect('unknown-client')

      expect(clientManager.unregister.calledWith('unknown-client')).to.be.true
    })

    it('should skip room removal for client without projectPath on disconnect', () => {
      // Register client without projectPath
      const registerHandler = transportHelper.requestHandlers.get(TransportClientEventNames.REGISTER)
      registerHandler!({clientType: 'mcp'}, 'client-1')
      ;(projectRouter.removeFromProjectRoom as SinonStub).resetHistory()

      // Client has no projectPath
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', type: 'mcp'}))

      transportHelper.simulateDisconnect('client-1')

      // Should NOT attempt room removal (no projectPath)
      expect((projectRouter.removeFromProjectRoom as SinonStub).called).to.be.false
      // But should still unregister
      expect(clientManager.unregister.calledWith('client-1')).to.be.true
    })

    it('should invoke onConnection handler on connect', () => {
      // Verify the handler was registered and fires without error
      expect(() => transportHelper.simulateConnect('new-client')).to.not.throw()
    })

    it('should call clientManager.unregister() even when handleAgentDisconnect throws', () => {
      // Register an agent
      const agentHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      agentHandler!({projectPath: '/tmp/brv-e2e-deleted'}, 'agent-del')

      // Simulate the projectRegistry.get() throwing (e.g. temp dir deleted by E2E test cleanup)
      projectRegistry.get.throws(new Error('ENOENT: no such file or directory'))

      // Disconnect must not propagate the error
      expect(() => transportHelper.simulateDisconnect('agent-del')).to.not.throw()

      // clientManager.unregister() must always be called regardless of errors in handleAgentDisconnect
      expect(clientManager.unregister.calledWith('agent-del')).to.be.true
    })
  })

  // ==========================================================================
  // Broadcast — Silent-Skip Paths
  // ==========================================================================

  describe('broadcast — silent-skip paths', () => {
    it('should silently skip broadcast when projectRegistry.get returns undefined', () => {
      // Override projectRegistry.get to return undefined
      // eslint-disable-next-line unicorn/no-useless-undefined
      projectRegistry.get.returns(undefined)

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      handler!({projectPath: '/app'}, 'agent-1')
      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      // Disconnect triggers broadcastToProjectRoom which calls projectRegistry.get
      transportHelper.simulateDisconnect('agent-1')

      // broadcastToProject never called because get() returned undefined
      expect((projectRouter.broadcastToProject as SinonStub).called).to.be.false
    })

    it('should silently skip agent status broadcast when agent has no project', () => {
      const registerHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({}, 'agent-fallback') // no projectPath
      ;(projectRouter.broadcastToProject as SinonStub).resetHistory()

      const handler = transportHelper.requestHandlers.get(AgentStatusEventNames.STATUS_CHANGED)
      const statusData = {activeTasks: 0, hasAuth: true, hasConfig: true, isInitialized: true, queuedTasks: 0}

      expect(() => handler!(statusData, 'agent-fallback')).to.not.throw()

      // findProjectForAgent returns undefined for '' key → broadcastToProjectRoom skips
      expect((projectRouter.broadcastToProject as SinonStub).called).to.be.false
    })
  })

  // ==========================================================================
  // Setup — Handler Registration Structural
  // ==========================================================================

  describe('setup — handler registration', () => {
    it('should register all 9 request event handlers', () => {
      // Setup already called in beforeEach
      expect((transportHelper.transport.onRequest as SinonStub).callCount).to.equal(9)
    })

    it('should register connection and disconnection handlers', () => {
      expect((transportHelper.transport.onConnection as SinonStub).calledOnce).to.be.true
      expect((transportHelper.transport.onDisconnection as SinonStub).calledOnce).to.be.true
    })
  })

  // ==========================================================================
  // clearActiveSession Behavior (tested via newSession handler)
  // ==========================================================================

  describe('clearActiveSession (via newSession handler)', () => {
    beforeEach(() => {
      // Ensure no agent is running so newSession triggers clearActiveSession
      coordinator.clearAgentClients()
    })

    it('should not attempt deletion when client has no projectPath', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)

      // Client with no projectPath
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', type: 'mcp'}))

      // Should succeed without attempting file deletion
      const result = handler!({reason: 'test'}, 'client-1')
      expect(result).to.deep.equal({success: true})
    })

    it('should not throw when active.json does not exist (unlinkSync fails)', () => {
      // projectRegistry.get returns valid info (file path won't actually exist)
      projectRegistry.get.withArgs('/app').returns(makeProjectInfo('/app'))

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      // unlinkSync will throw ENOENT since path doesn't exist — should be caught
      expect(() => handler!({reason: 'test'}, 'client-1')).to.not.throw()
    })

    it('should not attempt deletion when project not in registry', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined
      projectRegistry.get.withArgs('/app').returns(undefined)

      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      expect(() => handler!({reason: 'test'}, 'client-1')).to.not.throw()
    })
  })

  // ==========================================================================
  // Agent Re-registration Race Conditions
  // ==========================================================================

  describe('agent re-registration race', () => {
    it('should overwrite empty-string key when new projectless agent registers', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      handler!({}, 'agent-old')
      handler!({}, 'agent-new')

      expect(coordinator.getAgentForProject('/anything')).to.equal('agent-new')
      expect(coordinator.getDebugAgentClients()).to.deep.equal([{clientId: 'agent-new', projectPath: ''}])
    })

    it('should handle old agent disconnect after new agent registers for same project', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)

      // agent-1 registers, then agent-2 overwrites
      handler!({projectPath: '/app'}, 'agent-1')
      handler!({projectPath: '/app'}, 'agent-2')

      // agent-1 disconnects AFTER being overwritten — removeAgentClient scans for agent-1,
      // finds nothing (map has agent-2), so it's a no-op
      transportHelper.simulateDisconnect('agent-1')

      // agent-2 should still be intact
      expect(coordinator.getAgentForProject('/app')).to.equal('agent-2')
    })
  })

  // ==========================================================================
  // Data Payload Forwarding
  // ==========================================================================

  describe('data payload forwarding', () => {
    beforeEach(() => {
      const registerHandler = transportHelper.requestHandlers.get(TransportAgentEventNames.REGISTER)
      registerHandler!({projectPath: '/app'}, 'agent-1')
    })

    it('should forward only reason field for restart', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.RESTART)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      handler!({extraField: 'should-be-ignored', reason: 'config changed'}, 'client-1')

      const sendToCall = (transportHelper.transport.sendTo as SinonStub).lastCall
      expect(sendToCall.args[2]).to.deep.equal({reason: 'config changed'})
    })

    it('should forward only reason field for newSession', () => {
      const handler = transportHelper.requestHandlers.get(TransportAgentEventNames.NEW_SESSION)
      clientManager.getClient
        .withArgs('client-1')
        .returns(new ClientInfo({connectedAt: Date.now(), id: 'client-1', projectPath: '/app', type: 'tui'}))

      handler!({extraField: 'should-be-ignored', reason: 'user requested'}, 'client-1')

      const sendToCall = (transportHelper.transport.sendTo as SinonStub).lastCall
      expect(sendToCall.args[2]).to.deep.equal({reason: 'user requested'})
    })
  })
})
