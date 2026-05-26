 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'

export const PushEvents = {
  EXECUTE: 'push:execute',
  PREPARE: 'push:prepare',
  PROGRESS: 'push:progress',
} as const

export interface PushPrepareRequest {
  branch: string
  cli_metadata?: CliMetadata
}

export interface PushPrepareResponse {
  /** Number of changed files excluded from push due to pending/rejected reviews. */
  excludedReviewCount: number
  fileCount: number
  hasChanges: boolean
  /** Number of files with pending HITL reviews (0 if none). */
  pendingReviewCount: number
  /** URL to the local review UI (only set when pendingReviewCount > 0). */
  reviewUrl?: string
  summary: string
}

export interface PushExecuteRequest {
  branch: string
  cli_metadata?: CliMetadata
}

export interface PushExecuteResponse {
  added: number
  deleted: number
  edited: number
  success: boolean
  url: string
}

export interface PushProgressEvent {
  message: string
  step: string
}
