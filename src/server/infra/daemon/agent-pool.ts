/**
 * AgentPool - Manages up to N forked child process agents.
 *
 * Each agent is a separate Node.js process (child_process.fork())
 * associated with a projectPath. Communicates with agents via the
 * daemon's transport server (Socket.IO).
 *
 * When the pool is full, submitTask() returns an error for new projects.
 * Existing agents can still queue tasks. Idle agents are automatically
 * cleaned up by AgentIdleTimeoutPolicy after a period of inactivity.
 *
 * Pool is pure lifecycle management — zero knowledge of auth,
 * project config, or agent internals. Each child process handles
 * all agent setup independently.
 *
 * Consumed by:
 * - brv-server.ts: instantiation and wiring
 * - TransportHandlers: delegates task submission via submitTask()
 * - ClientManager.onProjectEmpty → markIdle() for potential cleanup
 */

import type {ChildProcess} from 'node:child_process'

import type {TaskExecute} from '../../core/domain/transport/schemas.js'
import type {AgentEntryInfo, IAgentPool, SubmitTaskResult} from '../../core/interfaces/agent/i-agent-pool.js'
import type {IAgentIdleTimeoutPolicy} from '../../core/interfaces/daemon/i-agent-idle-timeout-policy.js'
import type {ITransportServer} from '../../core/interfaces/transport/i-transport-server.js'

import {
  AGENT_MAX_CONCURRENT_TASKS,
  AGENT_POOL_MAX_SIZE,
  AGENT_PROCESS_READY_TIMEOUT_MS,
  AGENT_PROCESS_STOP_TIMEOUT_MS,
} from '../../constants.js'
import {TransportTaskEventNames} from '../../core/domain/transport/schemas.js'
import {ProjectTaskQueue} from './project-task-queue.js'

/**
 * IPC message sent by child process when ready.
 * Contains the child's Socket.IO client ID for task routing.
 */
type AgentReadyMessage = {
  clientId: string
  type: 'ready'
}

/**
 * Factory function that forks a child process for an agent.
 * Injected by consumer (brv-server.ts). Pool has no knowledge
 * of CipherAgent, auth, or agent internals.
 *
 * The factory handles fork() invocation with correct module path
 * and env vars (port, projectPath). Pool only provides projectPath.
 * The returned ChildProcess must send IPC { type: 'ready', clientId }
 * once initialized and connected to the transport server.
 */
export type AgentProcessFactory = (projectPath: string) => ChildProcess

type ForkedAgent = {
  activeTasks: number
  childProcess: ChildProcess
  clientId: string
  maxConcurrentTasks: number
  stop: () => Promise<void>
}

type ManagedAgent = {
  agent: ForkedAgent
  createdAt: number
  isIdle: boolean
  lastUsedAt: number
  projectPath: string
}

type AgentPoolOptions = {
  agentIdleTimeoutPolicy?: IAgentIdleTimeoutPolicy
  agentProcessFactory: AgentProcessFactory
  log?: (message: string) => void
  maxConcurrentTasks?: number
  maxSize?: number
  readyTimeoutMs?: number
  stopTimeoutMs?: number
  transportServer: ITransportServer
}

export class AgentPool implements IAgentPool {
  private readonly agentIdleTimeoutPolicy?: IAgentIdleTimeoutPolicy
  private readonly agentProcessFactory: AgentProcessFactory
  private readonly agents: Map<string, ManagedAgent> = new Map()
  private readonly log: (message: string) => void
  private readonly maxConcurrentTasks: number
  private readonly maxSize: number
  private readonly pendingForks: Set<string> = new Set()
  private readonly readyTimeoutMs: number
  private shutdownRequested = false
  private readonly stopTimeoutMs: number
  private readonly taskQueue: ProjectTaskQueue = new ProjectTaskQueue()
  private readonly transportServer: ITransportServer

  constructor(options: AgentPoolOptions) {
    this.agentIdleTimeoutPolicy = options.agentIdleTimeoutPolicy
    this.agentProcessFactory = options.agentProcessFactory
    this.maxConcurrentTasks = options.maxConcurrentTasks ?? AGENT_MAX_CONCURRENT_TASKS
    this.maxSize = options.maxSize ?? AGENT_POOL_MAX_SIZE
    this.readyTimeoutMs = options.readyTimeoutMs ?? AGENT_PROCESS_READY_TIMEOUT_MS
    this.stopTimeoutMs = options.stopTimeoutMs ?? AGENT_PROCESS_STOP_TIMEOUT_MS
    this.log = options.log ?? (() => {})
    this.transportServer = options.transportServer
  }

  /**
   * Remove a queued task by id from any project's FIFO. Returns true when the
   * task was found and removed; false when the task is not in any queue.
   * Tasks that are mid-execution on an agent are not visible here.
   */
  cancelQueuedTask(taskId: string): boolean {
    return this.taskQueue.cancel(taskId)
  }

  getEntries(): readonly AgentEntryInfo[] {
    return [...this.agents.values()].map((entry) => ({
      activeTasks: entry.agent.activeTasks,
      childPid: entry.agent.childProcess.pid ?? -1,
      createdAt: entry.createdAt,
      hasActiveTask: entry.agent.activeTasks > 0,
      isIdle: entry.isIdle,
      lastUsedAt: entry.lastUsedAt,
      projectPath: entry.projectPath,
    }))
  }

  /**
   * Returns task queue summary for debugging.
   * Used by daemon:getState handler in brv-server.ts.
   */
  getQueueState(): Array<{projectPath: string; queueLength: number}> {
    return this.taskQueue.getProjectsWithTasks().map((projectPath) => ({
      projectPath,
      queueLength: this.taskQueue.getQueueLength(projectPath),
    }))
  }

  getSize(): number {
    return this.agents.size
  }

  /**
   * Handle agent socket disconnection.
   * Removes the agent entry, best-effort stops the child process,
   * and re-forks a new agent if queued tasks remain.
   */
  handleAgentDisconnected(projectPath: string): void {
    const entry = this.agents.get(projectPath)
    if (!entry) return

    this.log(`Agent socket disconnected, removing from pool: ${projectPath} (pid=${entry.agent.childProcess.pid})`)
    this.removeAgentAndRetryQueue(projectPath)
  }

  hasAgent(projectPath: string): boolean {
    return this.agents.has(projectPath)
  }

  markIdle(projectPath: string): void {
    const entry = this.agents.get(projectPath)
    if (entry) {
      entry.isIdle = true
      this.log(`Agent marked idle: ${projectPath}`)
    }
  }

  /**
   * Called by TransportHandlers when an agent completes or errors a task.
   * Decrements active task count and drains queued tasks for the project.
   */
  notifyTaskCompleted(projectPath: string): void {
    const entry = this.agents.get(projectPath)
    if (!entry) return

    entry.agent.activeTasks = Math.max(0, entry.agent.activeTasks - 1)
    entry.lastUsedAt = Date.now()
    this.agentIdleTimeoutPolicy?.onAgentActivity(projectPath)
    this.drainQueue(projectPath)
  }

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    this.taskQueue.clear()

    const stopPromises = [...this.agents.values()].map(async (entry) => {
      try {
        await entry.agent.stop()
      } catch {
        // Best-effort cleanup
      }
    })

    await Promise.allSettled(stopPromises)
    this.agents.clear()
    this.log('Agent pool shut down')
  }

  async submitTask(task: TaskExecute): Promise<SubmitTaskResult> {
    const {projectPath} = task
    if (!projectPath) {
      return {message: 'Task missing projectPath', reason: 'invalid_task', success: false}
    }

    // Fast path: Agent exists for this project
    const existing = this.agents.get(projectPath)
    if (existing) {
      if (existing.agent.activeTasks < existing.agent.maxConcurrentTasks) {
        this.sendTaskToAgent(existing, task)

        return {success: true}
      }

      // Agent at capacity → queue
      this.taskQueue.enqueue(projectPath, task)
      this.log(
        `Task queued for busy agent: ${projectPath} (active: ${existing.agent.activeTasks}/${existing.agent.maxConcurrentTasks}, queue: ${this.taskQueue.getQueueLength(projectPath)})`,
      )

      return {success: true}
    }

    // Fork in progress for this project — queue to avoid duplicate forks.
    // createAgentAndExecute() drains this queue once the fork completes.
    if (this.pendingForks.has(projectPath)) {
      this.taskQueue.enqueue(projectPath, task)
      this.log(`Task queued (fork in progress): ${projectPath} (queue: ${this.taskQueue.getQueueLength(projectPath)})`)
      return {success: true}
    }

    // No agent exists — check if we can fork (count pending forks toward the limit).
    // Pool full: try to evict the LRU idle agent (no active tasks, no queued tasks,
    // no remaining clients) before giving up with pool_full.
    if (this.agents.size + this.pendingForks.size >= this.maxSize && !this.evictIdleAgent(projectPath)) {
      this.log(
        `Pool full (${this.agents.size + this.pendingForks.size}/${this.maxSize}) - cannot create agent for: ${projectPath}`,
      )
      return {
        message: `Agent pool is full (${this.maxSize} agents). Cannot create agent for new project. Wait for idle agents to be cleaned up.`,
        reason: 'pool_full',
        success: false,
      }
    }

    return this.tryCreateAndExecute(projectPath, task)
  }

  private async createAgentAndExecute(projectPath: string, task: TaskExecute): Promise<void> {
    const agent = await this.forkAgent(projectPath)

    const entry: ManagedAgent = {
      agent,
      createdAt: Date.now(),
      isIdle: false,
      lastUsedAt: Date.now(),
      projectPath,
    }

    this.agents.set(projectPath, entry)
    this.log(
      `Agent forked for: ${projectPath} (pid=${agent.childProcess.pid}, pool: ${this.agents.size}/${this.maxSize})`,
    )

    this.sendTaskToAgent(entry, task)
    // Drain tasks that were queued while this fork was in progress
    this.drainQueue(projectPath)
  }

  private drainQueue(projectPath: string): void {
    const entry = this.agents.get(projectPath)
    if (!entry) return

    // Drain as many queued tasks as concurrency allows
    while (entry.agent.activeTasks < entry.agent.maxConcurrentTasks) {
      const nextTask = this.taskQueue.dequeue(projectPath)
      if (!nextTask) break

      this.log(
        `Draining queue for: ${projectPath} (active: ${entry.agent.activeTasks}/${entry.agent.maxConcurrentTasks})`,
      )
      this.sendTaskToAgent(entry, nextTask)
    }
  }

  /**
   * Evict the least-recently-used idle agent to make room for a new project.
   * Only evicts agents that are idle (no more external clients), have no active
   * tasks, and have no queued tasks. Returns true if an agent was evicted.
   *
   * Invariant: evicted agents always have an empty task queue (enforced by the
   * `getQueueLength === 0` guard), so `removeAgentAndRetryQueue` will never
   * trigger a re-fork for the evicted project. This is what keeps eviction safe
   * without going through `submitTask`'s capacity check.
   */
  private evictIdleAgent(incomingProject: string): boolean {
    let lruEntry: ManagedAgent | undefined

    for (const entry of this.agents.values()) {
      if (
        entry.isIdle &&
        entry.agent.activeTasks === 0 &&
        this.taskQueue.getQueueLength(entry.projectPath) === 0 &&
        (!lruEntry || entry.lastUsedAt < lruEntry.lastUsedAt)
      ) {
        lruEntry = entry
      }
    }

    if (!lruEntry) return false

    this.log(
      `Evicting idle agent to make room for ${incomingProject}: ${lruEntry.projectPath} (last used: ${new Date(lruEntry.lastUsedAt).toISOString()})`,
    )
    this.removeAgentAndRetryQueue(lruEntry.projectPath)
    return true
  }

  private async forkAgent(projectPath: string): Promise<ForkedAgent> {
    const childProcess = this.agentProcessFactory(projectPath)

    // Wait for child to report ready with its Socket.IO clientId
    const clientId = await this.waitForReady(childProcess, projectPath)

    const agent: ForkedAgent = {
      activeTasks: 0,
      childProcess,
      clientId,
      maxConcurrentTasks: this.maxConcurrentTasks,
      stop: () => this.stopChildProcess(childProcess),
    }

    // Handle unexpected exit — cleanup entry and retry queued tasks.
    // Guard: only cleanup if this process is still the current agent
    // (a newer agent may have been forked for the same project).
    childProcess.on('exit', (code) => {
      this.log(`Agent process exited: ${projectPath} (pid=${childProcess.pid}, code=${code})`)
      const current = this.agents.get(projectPath)
      if (current?.agent.childProcess === childProcess) {
        this.removeAgentAndRetryQueue(projectPath)
      }
    })

    return agent
  }

  /**
   * Shared cleanup: remove agent entry, stop process, and re-fork
   * a new agent if queued tasks remain for the project.
   *
   * Idempotent: no-op if agent was already removed.
   */
  private removeAgentAndRetryQueue(projectPath: string): void {
    const entry = this.agents.get(projectPath)
    if (!entry) return

    this.agents.delete(projectPath)
    this.agentIdleTimeoutPolicy?.removeAgent(projectPath)
    entry.agent.stop().catch(() => {})

    // Re-fork a new agent to process remaining queued tasks.
    // The new agent will drain further tasks via notifyTaskCompleted → drainQueue.
    // Skip during shutdown to prevent orphaned child processes.
    if (this.shutdownRequested) return
    const nextTask = this.taskQueue.dequeue(projectPath)
    if (nextTask) {
      this.log(
        `Re-forking agent for queued tasks: ${projectPath} (remaining: ${this.taskQueue.getQueueLength(projectPath)})`,
      )
      this.tryCreateAndExecute(projectPath, nextTask).then((result) => {
        if (!result.success) {
          this.log(`Failed to re-fork agent for ${projectPath}: ${result.message}`)
        }
      })
    }
  }

  private sendTaskToAgent(entry: ManagedAgent, task: TaskExecute): void {
    entry.isIdle = false
    entry.agent.activeTasks++
    entry.lastUsedAt = Date.now()
    this.agentIdleTimeoutPolicy?.onAgentActivity(entry.projectPath)

    this.transportServer.sendTo(entry.agent.clientId, TransportTaskEventNames.EXECUTE, task)
  }

  private stopChildProcess(childProcess: ChildProcess): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!childProcess.connected && childProcess.exitCode !== null) {
        resolve()
        return
      }

      const timeout = setTimeout(() => {
        childProcess.kill('SIGKILL')
        resolve()
      }, this.stopTimeoutMs)

      childProcess.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })

      childProcess.kill('SIGTERM')
    })
  }

  private async tryCreateAndExecute(projectPath: string, task: TaskExecute): Promise<SubmitTaskResult> {
    this.pendingForks.add(projectPath)
    try {
      await this.createAgentAndExecute(projectPath, task)
      return {success: true}
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`Failed to create agent for ${projectPath}: ${message}`)
      return {message, reason: 'create_failed', success: false}
    } finally {
      this.pendingForks.delete(projectPath)
    }
  }

  private waitForReady(childProcess: ChildProcess, projectPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup()
        childProcess.kill('SIGKILL')
        reject(new Error(`Agent process ready timeout (${this.readyTimeoutMs}ms): ${projectPath}`))
      }, this.readyTimeoutMs)

      const onMessage = (msg: unknown): void => {
        if (isReadyMessage(msg)) {
          cleanup()
          resolve(msg.clientId)
        }
      }

      const onExit = (code: null | number): void => {
        cleanup()
        reject(new Error(`Agent process exited before ready (code=${code}): ${projectPath}`))
      }

      const cleanup = (): void => {
        clearTimeout(timeout)
        childProcess.off('message', onMessage)
        childProcess.off('exit', onExit)
      }

      childProcess.on('message', onMessage)
      childProcess.on('exit', onExit)
    })
  }
}

function isReadyMessage(msg: unknown): msg is AgentReadyMessage {
  if (typeof msg !== 'object' || msg === null) return false
  if (!('type' in msg) || !('clientId' in msg)) return false
  return msg.type === 'ready' && typeof msg.clientId === 'string'
}
