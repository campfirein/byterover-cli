import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {PropsArg} from '../../../../shared/analytics/events/index.js'
import type {ConnectorDTO} from '../../../../shared/transport/types/dto.js'
import type {ConnectorType} from '../../../../shared/types/connector-type.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {IConnectorManager} from '../../../core/interfaces/connectors/i-connector-manager.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {
  ConnectorEvents,
  type ConnectorGetAgentConfigPathsRequest,
  type ConnectorGetAgentConfigPathsResponse,
  type ConnectorGetAgentsResponse,
  type ConnectorInstallRequest,
  type ConnectorInstallResponse,
  type ConnectorListResponse,
} from '../../../../shared/transport/events/connector-events.js'
import {isConnectorType} from '../../../../shared/types/connector-type.js'
import {AGENT_CONNECTOR_CONFIG, isAgent} from '../../../core/domain/entities/agent.js'
import {processLog} from '../../../utils/process-logger.js'
import {mapAgentsToDTOs} from './agent-dto-mapper.js'
import {type ProjectPathResolver, resolveRequiredProjectPath} from './handler-types.js'

export interface ConnectorsHandlerDeps {
  /**
   * Optional. When provided, the handler emits `connector_installed`
   * analytics events at both terminals.
   */
  analyticsClient?: IAnalyticsClient
  connectorManagerFactory: (projectRoot: string) => IConnectorManager
  resolveProjectPath: ProjectPathResolver
  transport: ITransportServer
}

/**
 * Handles connectors:* events.
 * Business logic for connector management — no terminal/UI calls.
 */
export class ConnectorsHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly connectorManagerFactory: (projectRoot: string) => IConnectorManager
  private readonly resolveProjectPath: ProjectPathResolver
  private readonly transport: ITransportServer

  constructor(deps: ConnectorsHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.connectorManagerFactory = deps.connectorManagerFactory
    this.resolveProjectPath = deps.resolveProjectPath
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<void, ConnectorGetAgentsResponse>(ConnectorEvents.GET_AGENTS, () => this.handleGetAgents())

    this.transport.onRequest<ConnectorGetAgentConfigPathsRequest, ConnectorGetAgentConfigPathsResponse>(
      ConnectorEvents.GET_AGENT_CONFIG_PATHS,
      (data, clientId) => this.handleGetAgentConfigPaths(data, clientId),
    )

    this.transport.onRequest<void, ConnectorListResponse>(ConnectorEvents.LIST, (_data, clientId) =>
      this.handleList(clientId),
    )

    this.transport.onRequest<ConnectorInstallRequest, ConnectorInstallResponse>(
      ConnectorEvents.INSTALL,
      (data, clientId) => this.handleInstall(data, clientId),
    )
  }

  /**
   * Analytics emit helper. Mirrors the try/processLog pattern from other
   * handlers so analytics failures never affect command outcomes.
   */
  private emitAnalytics<E extends AnalyticsEventName>(event: E, ...rest: PropsArg<E>): void {
    const client = this.analyticsClient
    if (!client) return
    try {
      client.track(event, ...rest)
    } catch (error) {
      processLog(
        `[Connectors] analytics track ${event} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  private handleGetAgentConfigPaths(
    data: ConnectorGetAgentConfigPathsRequest,
    clientId: string,
  ): ConnectorGetAgentConfigPathsResponse {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const connectorManager = this.connectorManagerFactory(projectPath)

    const configPaths: Partial<Record<ConnectorType, string>> = {}
    if (isAgent(data.agentId)) {
      const supportedTypes = AGENT_CONNECTOR_CONFIG[data.agentId].supported
      for (const type of supportedTypes) {
        configPaths[type] = connectorManager.getConnector(type).getConfigPath(data.agentId)
      }
    }

    return {configPaths}
  }

  private handleGetAgents(): ConnectorGetAgentsResponse {
    return {agents: mapAgentsToDTOs()}
  }

  private async handleInstall(data: ConnectorInstallRequest, clientId: string): Promise<ConnectorInstallResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    // Wire-side fields are always strings; coerce defensively so the
    // emit doesn't carry undefined/null when the validation guards reject.
    const agentTarget = String(data.agentId)
    const connectorId = String(data.connectorType)

    if (!isAgent(data.agentId)) {
      this.emitAnalytics(AnalyticsEventNames.CONNECTOR_INSTALLED, {
        // eslint-disable-next-line camelcase
        agent_target: agentTarget,
        // eslint-disable-next-line camelcase
        connector_id: connectorId,
        // eslint-disable-next-line camelcase
        failure_kind: 'invalid_agent',
        outcome: 'failure',
      })
      return {message: `Unsupported agent: ${data.agentId}`, success: false}
    }

    if (!isConnectorType(data.connectorType)) {
      this.emitAnalytics(AnalyticsEventNames.CONNECTOR_INSTALLED, {
        // eslint-disable-next-line camelcase
        agent_target: agentTarget,
        // eslint-disable-next-line camelcase
        connector_id: connectorId,
        // eslint-disable-next-line camelcase
        failure_kind: 'invalid_connector',
        outcome: 'failure',
      })
      return {message: `Unsupported connector type: ${data.connectorType}`, success: false}
    }

    const connectorManager = this.connectorManagerFactory(projectPath)
    const result = await connectorManager.switchConnector(data.agentId, data.connectorType)

    if (result.success) {
      this.emitAnalytics(AnalyticsEventNames.CONNECTOR_INSTALLED, {
        // eslint-disable-next-line camelcase
        agent_target: agentTarget,
        // eslint-disable-next-line camelcase
        connector_id: connectorId,
        outcome: 'success',
      })
    } else {
      this.emitAnalytics(AnalyticsEventNames.CONNECTOR_INSTALLED, {
        // eslint-disable-next-line camelcase
        agent_target: agentTarget,
        // eslint-disable-next-line camelcase
        connector_id: connectorId,
        // eslint-disable-next-line camelcase
        failure_kind: 'install_failed',
        outcome: 'failure',
      })
    }

    return {
      configPath: result.installResult.configPath,
      manualInstructions: result.installResult.manualInstructions,
      message: result.message,
      requiresManualSetup: result.installResult.requiresManualSetup,
      success: result.success,
    }
  }

  private async handleList(clientId: string): Promise<ConnectorListResponse> {
    const projectPath = resolveRequiredProjectPath(this.resolveProjectPath, clientId)
    const connectorManager = this.connectorManagerFactory(projectPath)

    const installedMap = await connectorManager.getAllInstalledConnectors()
    const connectors: ConnectorDTO[] = []

    for (const [agent, connectorType] of installedMap) {
      connectors.push({
        agent,
        connectorType,
        defaultType: connectorManager.getDefaultConnectorType(agent),
        supportedTypes: connectorManager.getSupportedConnectorTypes(agent),
      })
    }

    return {connectors}
  }

}
