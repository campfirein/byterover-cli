 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'

export const WorktreeEvents = {
  ADD: 'worktree:add',
  LIST: 'worktree:list',
  REMOVE: 'worktree:remove',
} as const

export interface WorktreeAddRequest {
  cli_metadata?: CliMetadata
  force?: boolean
  worktreePath: string
}

export interface WorktreeAddResponse {
  backedUp?: boolean
  message: string
  success: boolean
}

export interface WorktreeRemoveRequest {
  cli_metadata?: CliMetadata
  worktreePath: string
}

export interface WorktreeRemoveResponse {
  message: string
  success: boolean
}

/**
 * M13.2 — `WorktreeListRequest` upgraded from `void` to an interface with
 * optional `cli_metadata` so client-side callers can attach invocation
 * metadata. Field stays optional, so wire-level back-compat is preserved.
 */
export interface WorktreeListRequest {
  cli_metadata?: CliMetadata
}

export interface WorktreeListResponse {
  projectRoot: string
  source: 'direct' | 'flag' | 'linked'
  worktreeRoot: string
  worktrees: Array<{name: string; worktreePath: string}>
}
