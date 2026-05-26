 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'

export const PullEvents = {
  EXECUTE: 'pull:execute',
  PREPARE: 'pull:prepare',
  PROGRESS: 'pull:progress',
} as const

export interface PullPrepareRequest {
  branch: string
  cli_metadata?: CliMetadata
}

export interface PullPrepareResponse {
  hasChanges: boolean
  summary: string
}

export interface PullExecuteRequest {
  branch: string
  cli_metadata?: CliMetadata
}

export interface PullExecuteResponse {
  added: number
  commitSha: string
  deleted: number
  edited: number
  success: boolean
}

export interface PullProgressEvent {
  message: string
  step: string
}
