 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {BrvConfigDTO, SpaceDTO} from '../types/dto.js'

export const SpaceEvents = {
  LIST: 'space:list',
  SWITCH: 'space:switch',
} as const

export interface TeamWithSpacesDTO {
  spaces: SpaceDTO[]
  teamId: string
  teamName: string
}

export interface SpaceListResponse {
  teams: TeamWithSpacesDTO[]
}

export interface SpaceSwitchRequest {
  cli_metadata?: CliMetadata
  spaceId: string
}

export interface SpaceSwitchPullResult {
  added: number
  commitSha: string
  conflicted?: number
  deleted: number
  edited: number
  restoredFromRemote?: number
}

export interface SpaceSwitchResponse {
  config: BrvConfigDTO
  pullError?: string
  pullResult?: SpaceSwitchPullResult
  success: boolean
}
