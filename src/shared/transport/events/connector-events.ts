 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {Agent} from '../../types/agent.js'
import type {ConnectorType} from '../../types/connector-type.js'
import type {AgentDTO, ConnectorDTO} from '../types/dto.js'

export const ConnectorEvents = {
  GET_AGENT_CONFIG_PATHS: 'connectors:getAgentConfigPaths',
  GET_AGENTS: 'connectors:getAgents',
  INSTALL: 'connectors:install',
  LIST: 'connectors:list',
} as const

/**
 * M13.2 Group C — `connectors:getAgents` is a no-payload oclif call. Define the
 * Request interface for M13.3's payload attachment.
 */
export interface ConnectorGetAgentsRequest {
  cli_metadata?: CliMetadata
}

export interface ConnectorGetAgentsResponse {
  agents: AgentDTO[]
}

/**
 * M13.2 Group C — `connectors:list` is a no-payload oclif call.
 */
export interface ConnectorListRequest {
  cli_metadata?: CliMetadata
}

export interface ConnectorListResponse {
  connectors: ConnectorDTO[]
}

export interface ConnectorGetAgentConfigPathsRequest {
  agentId: Agent
  cli_metadata?: CliMetadata
}

export interface ConnectorGetAgentConfigPathsResponse {
  configPaths: Partial<Record<ConnectorType, string>>
}

export interface ConnectorInstallRequest {
  agentId: Agent
  cli_metadata?: CliMetadata
  connectorType: ConnectorType
}

export interface ConnectorInstallResponse {
  configPath?: string
  manualInstructions?: {configContent: string; guide: string}
  message: string
  requiresManualSetup?: boolean
  success: boolean
}
