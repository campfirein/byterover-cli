 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'

export const SourceEvents = {
  ADD: 'source:add',
  LIST: 'source:list',
  REMOVE: 'source:remove',
} as const

export interface SourceAddRequest {
  alias?: string
  cli_metadata?: CliMetadata
  targetPath: string
}

export interface SourceAddResponse {
  message: string
  success: boolean
}

export interface SourceRemoveRequest {
  aliasOrPath: string
  cli_metadata?: CliMetadata
}

export interface SourceRemoveResponse {
  message: string
  success: boolean
}

/**
 * M13.2 — `SourceListRequest` upgraded from `void` to an interface with optional
 * `cli_metadata` so client-side callers can attach invocation metadata. The
 * field stays optional, so existing daemon-internal call sites that pass
 * nothing continue to work over the wire.
 */
export interface SourceListRequest {
  cli_metadata?: CliMetadata
}

export interface SourceListResponse {
  error?: string
  statuses: Array<{alias: string; contextTreeSize?: number; projectRoot: string; valid: boolean}>
}
