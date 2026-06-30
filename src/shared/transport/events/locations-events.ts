 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {ProjectLocationDTO} from '../types/dto.js'

export const LocationsEvents = {
  GET: 'locations:get',
  REVEAL: 'locations:reveal',
} as const

/**
 * M13.2 Group C — `locations:get` is a no-payload oclif call. Define the Request
 * interface so M13.3 can attach `cli_metadata`.
 */
export interface LocationsGetRequest {
  cli_metadata?: CliMetadata
}

export interface LocationsGetResponse {
  locations: ProjectLocationDTO[]
}

export interface LocationsRevealRequest {
  cli_metadata?: CliMetadata
  projectPath: string
}

export interface LocationsRevealResponse {
  projectPath: string
}
