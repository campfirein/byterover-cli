/**
 * TransportHandlers - Orchestrates message routing in the daemon Transport Server.
 *
 * Delegates responsibilities to focused sub-handlers:
 * - TaskRouter: task lifecycle + LLM event routing
 * - ConnectionCoordinator: client/agent connection lifecycle + project rooms
 *
 * This class wires the sub-handlers together, provides the public API
 * consumed by brv-server.ts, and exposes debug state for `brv debug`.
 *
 * Event naming convention:
 * - task:* events are Transport-generated (ack, created, started, completed, error)
 * - llmservice:* events are forwarded from Agent with ORIGINAL names
 *
 * Message flows:
 * 1. Client → Transport: task:create {taskId, type, content}
 *    Transport → Agent: task:execute {taskId, type, content, clientId}
 *    Transport → Client: task:ack {taskId}
 *    Transport → project-room: task:created {taskId, type, content, files?}
 *
 * 2. Agent → Transport: llmservice:response {taskId, content}
 *    Transport → Client (direct): llmservice:response
 *    Transport → project-room: llmservice:response (for TUI monitoring)
 *
 * 3. Agent → Transport: task:completed {taskId}
 *    Transport → Client (direct): task:completed
 *    Transport → project-room: task:completed (for TUI monitoring)
 */

import type {IAgentPool} from '../../core/interfaces/agent/i-agent-pool.js'
import type {IClientManager} from '../../core/interfaces/client/i-client-manager.js'
import type {ITaskLifecycleHook} from '../../core/interfaces/process/i-task-lifecycle-hook.js'
import type {IProjectRegistry} from '../../core/interfaces/project/i-project-registry.js'
import type {IProjectRouter} from '../../core/interfaces/routing/i-project-router.js'
import type {ITaskHistoryStore} from '../../core/interfaces/storage/i-task-history-store.js'
import type {ITransportServer} from '../../core/interfaces/transport/i-transport-server.js'
import type {IsReviewDisabledResolver, PreDispatchCheck} from './task-router.js'

import {ConnectionCoordinator} from './connection-coordinator.js'
import {TaskHeartbeatManager} from './task-heartbeat-manager.js'
import {TaskRouter} from './task-router.js'

export type {IsReviewDisabledResolver, PreDispatchCheck, PreDispatchCheckResult} from './task-router.js'
export type {TaskInfo} from './types.js'

type TransportHandlersOptions = {
  agentPool?: IAgentPool
  clientManager?: IClientManager
  /**
   * Daemon's CLI version (read from package.json at startup). Surfaced in the
   * `client:register` ack so clients can render version-drift indicators.
   */
  daemonVersion?: string
  /** Per-project `ITaskHistoryStore` factory used by the M2.09 persistent-history handlers. */
  getTaskHistoryStore?: (projectPath: string) => ITaskHistoryStore
  /** Resolves project's review-disabled flag at task-create. Snapshotted once into TaskInfo + TaskExecute. */
  isReviewDisabled?: IsReviewDisabledResolver
  /** Lifecycle hooks for task events (e.g. CurateLogHandler). */
  lifecycleHooks?: ITaskLifecycleHook[]
  /** Optional daemon-side gate run before dispatching a task to the agent pool. */
  preDispatchCheck?: PreDispatchCheck
  projectRegistry?: IProjectRegistry
  projectRouter?: IProjectRouter
  /** Resolves the active provider/model snapshot stamped onto created tasks. */
  resolveActiveProvider?: () => Promise<{model?: string; provider?: string}>
  /**
   * Optional liveness ticker. Constructed by the daemon and shared so
   * `clearTasks()` can dispose its timers alongside in-memory task state.
   */
  taskHeartbeatManager?: TaskHeartbeatManager
  transport: ITransportServer
}

/**
 * TransportHandlers - Orchestrator for message routing.
 *
 * Wires TaskRouter and ConnectionCoordinator, provides public API
 * for brv-server.ts and debug state for `brv debug`.
 */
export class TransportHandlers {
  private readonly connectionCoordinator: ConnectionCoordinator
  private readonly taskRouter: TaskRouter

  constructor(options: TransportHandlersOptions) {
    this.taskRouter = new TaskRouter({
      agentPool: options.agentPool,
      getAgentForProject: (projectPath) => this.connectionCoordinator.getAgentForProject(projectPath),
      getTaskHistoryStore: options.getTaskHistoryStore,
      heartbeatManager: options.taskHeartbeatManager,
      isReviewDisabled: options.isReviewDisabled,
      lifecycleHooks: options.lifecycleHooks,
      preDispatchCheck: options.preDispatchCheck,
      projectRegistry: options.projectRegistry,
      projectRouter: options.projectRouter,
      resolveActiveProvider: options.resolveActiveProvider,
      resolveClientProjectPath: (clientId) => options.clientManager?.getClient(clientId)?.projectPath,
      transport: options.transport,
    })

    this.connectionCoordinator = new ConnectionCoordinator({
      agentPool: options.agentPool,
      clientManager: options.clientManager,
      daemonVersion: options.daemonVersion,
      projectRegistry: options.projectRegistry,
      projectRouter: options.projectRouter,
      taskRouter: this.taskRouter,
      transport: options.transport,
    })
  }

  /**
   * Cleanup all internal state.
   */
  cleanup(): void {
    this.taskRouter.clearTasks()
    this.connectionCoordinator.clearAgentClients()
  }

  /**
   * Returns a serializable snapshot of internal state for debugging.
   * Used by the daemon:getState handler in brv-server.ts.
   */
  getDebugState(): {
    activeTasks: Array<{clientId: string; createdAt: number; projectPath?: string; taskId: string; type: string}>
    agentClients: Array<{clientId: string; projectPath: string}>
    completedTasks: Array<{completedAt: number; projectPath?: string; taskId: string; type: string}>
  } {
    const taskState = this.taskRouter.getDebugState()
    return {
      activeTasks: taskState.activeTasks,
      agentClients: this.connectionCoordinator.getDebugAgentClients(),
      completedTasks: taskState.completedTasks,
    }
  }

  /**
   * Setup all message handlers.
   */
  setup(): void {
    this.connectionCoordinator.setup()
    this.taskRouter.setup()
  }
}
