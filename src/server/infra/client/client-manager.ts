/**
 * ClientManager — Tracks connected clients and project membership.
 *
 * Pure data structure with no external dependencies.
 * TransportHandlers coordinates between ClientManager and ProjectRouter
 * for Socket.IO room management.
 *
 * Key behaviors:
 * - Tracks all connected clients (tui, mcp, agent)
 * - Maintains a projectPath → clientIds index for fast lookup
 * - Fires onProjectEmpty when last external client leaves a project
 * - Agent clients don't count toward project membership (workers, not users)
 * - Global-scope MCP clients start without a project and get associated later
 */

import type {ClientType} from '../../core/domain/client/client-info.js'
import type {IAnalyticsClient} from '../../core/interfaces/analytics/i-analytics-client.js'
import type {IClientManager, ProjectEmptyCallback} from '../../core/interfaces/client/i-client-manager.js'

import {AnalyticsEventNames} from '../../../shared/analytics/event-names.js'
import {ClientInfo} from '../../core/domain/client/client-info.js'
import {hashProjectPath} from '../../utils/hash-path.js'
import {processLog} from '../../utils/process-logger.js'
import {clientKindContext} from '../transport/client-kind-context.js'

export class ClientManager implements IClientManager {
  /** Optional analytics client for M15.5 WebUI session events */
  private analyticsClient: IAnalyticsClient | undefined
  /** Callback for when a client registers */
  private clientConnectedCallback?: () => void
  /** Callback for when a client unregisters */
  private clientDisconnectedCallback?: () => void
  /** All registered clients: clientId → ClientInfo */
  private readonly clients: Map<string, ClientInfo> = new Map()
  /** Project membership index: projectPath → Set of clientIds */
  private readonly projectClients: Map<string, Set<string>> = new Map()
  /** Callback for when a project has no external clients */
  private projectEmptyCallback: ProjectEmptyCallback | undefined

  associateProject(clientId: string, projectPath: string): void {
    const client = this.clients.get(clientId)
    if (!client) return
    if (client.hasProject) return

    client.associateProject(projectPath)
    this.addToProjectIndex(clientId, projectPath)
  }

  getActiveProjects(): string[] {
    return [...this.projectClients.keys()]
  }

  /**
   * Returns all registered clients for debugging.
   * Used by daemon:getState handler in brv-server.ts.
   */
  getAllClients(): ClientInfo[] {
    return [...this.clients.values()]
  }

  getClient(clientId: string): ClientInfo | undefined {
    return this.clients.get(clientId)
  }

  getClientsByProject(projectPath: string): ClientInfo[] {
    const clientIds = this.projectClients.get(projectPath)
    if (!clientIds) return []

    const clients: ClientInfo[] = []
    for (const id of clientIds) {
      const client = this.clients.get(id)
      if (client) clients.push(client)
    }

    return clients
  }

  onClientConnected(callback: () => void): void {
    this.clientConnectedCallback = callback
  }

  onClientDisconnected(callback: () => void): void {
    this.clientDisconnectedCallback = callback
  }

  onProjectEmpty(callback: ProjectEmptyCallback): void {
    this.projectEmptyCallback = callback
  }

  register(clientId: string, type: ClientType, projectPath?: string): void {
    // Cleanup old project index if clientId already registered (reconnect scenario)
    const existing = this.clients.get(clientId)
    if (existing?.projectPath) {
      this.removeFromProjectIndex(clientId, existing.projectPath)
    }

    // M15.5: on reconnect of a webui client, close out the prior session so
    // analytics doesn't orphan an unmatched started event.
    if (existing?.type === 'webui') {
      this.emitWebuiSessionEnded(existing)
    }

    const client = new ClientInfo({
      connectedAt: Date.now(),
      id: clientId,
      projectPath,
      type,
    })
    this.clients.set(clientId, client)

    if (projectPath) {
      this.addToProjectIndex(clientId, projectPath)
    }

    // M15.5: WebUI session lifecycle. Fires AFTER `clients.set` so any
    // analytics-side hook can still look the client up by id.
    if (type === 'webui') {
      this.emitWebuiSessionStarted(client)
    }

    // Only notify idle timeout policy for new clients, not re-registrations.
    // Re-registrations replace the existing entry without unregister, so firing
    // clientConnectedCallback again would desync IdleTimeoutPolicy.clientCount.
    if (!existing) {
      this.clientConnectedCallback?.()
    }
  }

  setAgentName(clientId: string, agentName: string): void {
    const client = this.clients.get(clientId)
    if (!client) return

    client.setAgentName(agentName)
  }

  /**
   * M15.5: register the analytics client. Setter pattern because
   * ClientManager is constructed in brv-server.ts before analyticsClient
   * exists (which is built inside setupFeatureHandlers).
   */
  setAnalyticsClient(client: IAnalyticsClient): void {
    this.analyticsClient = client
  }

  unregister(clientId: string): void {
    const client = this.clients.get(clientId)
    if (!client) return

    // M15.5: emit BEFORE clients.delete so we can still read client.type /
    // .connectedAt / .projectPath.
    if (client.type === 'webui') {
      this.emitWebuiSessionEnded(client)
    }

    this.clients.delete(clientId)

    if (client.projectPath) {
      this.removeFromProjectIndex(clientId, client.projectPath)

      // Check if project now has 0 external clients
      if (client.isExternalClient) {
        this.checkProjectEmpty(client.projectPath)
      }
    }

    // Notify idle timeout policy
    this.clientDisconnectedCallback?.()
  }

  updateProjectPath(clientId: string, newProjectPath: string): string | undefined {
    const client = this.clients.get(clientId)
    if (!client) return undefined

    const oldPath = client.updateProjectPath(newProjectPath)

    // Move between project indexes
    if (oldPath) {
      this.removeFromProjectIndex(clientId, oldPath)
    }

    this.addToProjectIndex(clientId, newProjectPath)

    // Check if old project is now empty
    if (oldPath && oldPath !== newProjectPath && client.isExternalClient) {
      this.checkProjectEmpty(oldPath)
    }

    return oldPath
  }

  private addToProjectIndex(clientId: string, projectPath: string): void {
    let members = this.projectClients.get(projectPath)
    if (!members) {
      members = new Set()
      this.projectClients.set(projectPath, members)
    }

    members.add(clientId)
  }

  /**
   * Check if a project has no remaining external clients.
   * Fires the onProjectEmpty callback if so.
   */
  private checkProjectEmpty(projectPath: string): void {
    if (!this.projectEmptyCallback) return

    const clients = this.getClientsByProject(projectPath)
    const hasExternalClients = clients.some((c) => c.isExternalClient)
    if (!hasExternalClients) {
      this.projectEmptyCallback(projectPath)
    }
  }

  /**
   * M15.5: emit webui_session_ended. Wrapped in clientKindContext so
   * SuperPropertiesResolver stamps client_kind='webui' on the envelope
   * (daemon-internal emit bypasses the transport wrap). try/processLog
   * pattern so analytics failures never block connection bookkeeping.
   */
  private emitWebuiSessionEnded(client: ClientInfo): void {
    const {analyticsClient} = this
    if (!analyticsClient) return
    // Clamp at 0 to defend against clock skew (e.g. NTP adjustment between
    // register and unregister). The schema enforces `nonnegative()`; a
    // negative value would otherwise leak through this direct-track path
    // (which bypasses the wire-side safeParse in AnalyticsHandler).
    const sessionDurationMs = Math.max(0, Date.now() - client.connectedAt)
    // eslint-disable-next-line camelcase
    clientKindContext.run({client_kind: 'webui'}, () => {
      try {
        /* eslint-disable camelcase */
        analyticsClient.track(AnalyticsEventNames.WEBUI_SESSION_ENDED, {
          ...(client.projectPath === undefined ? {} : {project_path_hash: hashProjectPath(client.projectPath)}),
          session_duration_ms: sessionDurationMs,
          started_at_unix_ms: client.connectedAt,
        })
        /* eslint-enable camelcase */
      } catch (error) {
        processLog(
          `[ClientManager] analytics track webui_session_ended failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  }

  /**
   * M15.5: emit webui_session_started. See emitWebuiSessionEnded for the
   * clientKindContext rationale.
   */
  private emitWebuiSessionStarted(client: ClientInfo): void {
    const {analyticsClient} = this
    if (!analyticsClient) return
    // eslint-disable-next-line camelcase
    clientKindContext.run({client_kind: 'webui'}, () => {
      try {
        /* eslint-disable camelcase */
        analyticsClient.track(AnalyticsEventNames.WEBUI_SESSION_STARTED, {
          ...(client.projectPath === undefined ? {} : {project_path_hash: hashProjectPath(client.projectPath)}),
          started_at_unix_ms: client.connectedAt,
        })
        /* eslint-enable camelcase */
      } catch (error) {
        processLog(
          `[ClientManager] analytics track webui_session_started failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  }

  private removeFromProjectIndex(clientId: string, projectPath: string): void {
    const members = this.projectClients.get(projectPath)
    if (!members) return

    members.delete(clientId)
    if (members.size === 0) {
      this.projectClients.delete(projectPath)
    }
  }
}
