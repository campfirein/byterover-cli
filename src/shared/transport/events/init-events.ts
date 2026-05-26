 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {Agent} from '../../types/agent.js'
import type {ConnectorType} from '../../types/connector-type.js'
import type {AgentDTO, BrvConfigDTO, SpaceDTO, TeamDTO} from '../types/dto.js'

export const InitEvents = {
  COMPLETED: 'init:completed',
  EXECUTE: 'init:execute',
  GET_AGENTS: 'init:getAgents',
  GET_SPACES: 'init:getSpaces',
  GET_TEAMS: 'init:getTeams',
  LOCAL: 'init:local',
  PROGRESS: 'init:progress',
} as const

export interface InitGetTeamsResponse {
  teams: TeamDTO[]
}

export interface InitGetSpacesRequest {
  cli_metadata?: CliMetadata
  teamId: string
}

export interface InitGetSpacesResponse {
  spaces: SpaceDTO[]
}

export interface InitGetAgentsResponse {
  agents: AgentDTO[]
}

export interface InitExecuteRequest {
  agentId: Agent
  cli_metadata?: CliMetadata
  connectorType: ConnectorType
  force?: boolean
  spaceId: string
  teamId: string
}

export interface InitExecuteResponse {
  success: boolean
}

export interface InitLocalRequest {
  cli_metadata?: CliMetadata
  force?: boolean
}

export interface InitLocalResponse {
  alreadyInitialized: boolean
  success: boolean
}

export interface InitProgressEvent {
  message: string
  step: string
}

export interface InitCompletedEvent {
  config?: BrvConfigDTO
  success: boolean
}
