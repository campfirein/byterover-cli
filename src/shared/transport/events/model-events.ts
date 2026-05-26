 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {ModelDTO} from '../types/dto.js'

export const ModelEvents = {
  LIST: 'model:list',
  LIST_BY_PROVIDERS: 'model:listByProviders',
  SET_ACTIVE: 'model:setActive',
} as const

export interface ModelListRequest {
  cli_metadata?: CliMetadata
  providerId: string
}

export interface ModelListResponse {
  activeModel?: string
  error?: string
  favorites: string[]
  models: ModelDTO[]
  recent: string[]
}

export interface ModelListByProvidersRequest {
  cli_metadata?: CliMetadata
  providerIds: string[]
}

export interface ModelListByProvidersResponse {
  models: ModelDTO[]
  providerErrors?: Record<string, string>
}

export interface ModelSetActiveRequest {
  cli_metadata?: CliMetadata
  contextLength?: number
  modelId: string
  providerId: string
}

export interface ModelSetActiveResponse {
  error?: string
  success: boolean
}
