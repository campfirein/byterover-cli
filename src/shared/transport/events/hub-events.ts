 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {AuthScheme} from '../types/auth-scheme.js'
import type {HubEntryDTO} from '../types/dto.js'

export const HubEvents = {
  INSTALL: 'hub:install',
  LIST: 'hub:list',
  LIST_PROGRESS: 'hub:list:progress',
  REGISTRY_ADD: 'hub:registry:add',
  REGISTRY_ADD_PROGRESS: 'hub:registry:add:progress',
  REGISTRY_LIST: 'hub:registry:list',
  REGISTRY_LIST_PROGRESS: 'hub:registry:list:progress',
  REGISTRY_REMOVE: 'hub:registry:remove',
} as const

export interface HubProgressEvent {
  message: string
  step: string
}

/**
 * M13.2 Group C — `hub:list` is a no-payload oclif call. Define the Request
 * interface so M13.3 can attach `cli_metadata`.
 */
export interface HubListRequest {
  cli_metadata?: CliMetadata
}

export interface HubListResponse {
  entries: HubEntryDTO[]
  version: string
}

export interface HubInstallRequest {
  agent?: string
  cli_metadata?: CliMetadata
  entryId: string
  registry?: string
  scope?: 'global' | 'project'
}

export interface HubInstallResponse {
  installedFiles: string[]
  installedPath: string
  message: string
  success: boolean
}

// Registry management

export interface HubRegistryAddRequest {
  authScheme?: AuthScheme
  cli_metadata?: CliMetadata
  headerName?: string
  name: string
  token?: string
  url: string
}

export interface HubRegistryAddResponse {
  message: string
  success: boolean
}

export interface HubRegistryRemoveRequest {
  cli_metadata?: CliMetadata
  name: string
}

export interface HubRegistryRemoveResponse {
  message: string
  success: boolean
}

export interface HubRegistryDTO {
  authScheme: AuthScheme
  entryCount: number
  error?: string
  hasToken: boolean
  name: string
  status: 'error' | 'ok'
  url: string
}

/**
 * M13.2 Group C — `hub:registry:list` is a no-payload oclif call.
 */
export interface HubRegistryListRequest {
  cli_metadata?: CliMetadata
}

export interface HubRegistryListResponse {
  registries: HubRegistryDTO[]
}
