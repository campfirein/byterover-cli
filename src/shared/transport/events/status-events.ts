 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {StatusDTO} from '../types/dto.js'

export const StatusEvents = {
  GET: 'status:get',
} as const

export interface StatusGetRequest {
  cli_metadata?: CliMetadata
  cwd?: string
  projectRootFlag?: string
  verbose?: boolean
}

export interface StatusGetResponse {
  status: StatusDTO
}
