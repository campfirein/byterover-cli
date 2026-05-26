 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'
import type {ProviderDTO} from '../types/dto.js'

export const ProviderEvents = {
  AWAIT_OAUTH_CALLBACK: 'provider:awaitOAuthCallback',
  CANCEL_OAUTH: 'provider:cancelOAuth',
  CONNECT: 'provider:connect',
  DISCONNECT: 'provider:disconnect',
  GET_ACTIVE: 'provider:getActive',
  LIST: 'provider:list',
  SET_ACTIVE: 'provider:setActive',
  START_OAUTH: 'provider:startOAuth',
  SUBMIT_OAUTH_CODE: 'provider:submitOAuthCode',
  UPDATED: 'provider:updated',
  VALIDATE_API_KEY: 'provider:validateApiKey',
} as const

/**
 * M13.2 Group C — `provider:list` is a no-payload oclif call. Define the Request
 * interface so M13.3 can attach `cli_metadata`.
 */
export interface ProviderListRequest {
  cli_metadata?: CliMetadata
}

export interface ProviderListResponse {
  providers: ProviderDTO[]
}

export interface ProviderConnectRequest {
  apiKey?: string
  baseUrl?: string
  cli_metadata?: CliMetadata
  providerId: string
}

export interface ProviderConnectResponse {
  error?: string
  success: boolean
}

export interface ProviderDisconnectRequest {
  cli_metadata?: CliMetadata
  providerId: string
}

export interface ProviderDisconnectResponse {
  success: boolean
}

export interface ProviderValidateApiKeyRequest {
  apiKey: string
  cli_metadata?: CliMetadata
  providerId: string
}

export interface ProviderValidateApiKeyResponse {
  error?: string
  isValid: boolean
}

/**
 * M13.2 Group C — `provider:getActive` is a no-payload oclif call.
 */
export interface ProviderGetActiveRequest {
  cli_metadata?: CliMetadata
}

export interface ProviderGetActiveResponse {
  activeModel?: string
  activeProviderId: string
  /** True when the active provider requires login but the user is not logged in. */
  loginRequired?: boolean
}

export interface ProviderSetActiveRequest {
  cli_metadata?: CliMetadata
  providerId: string
}

export interface ProviderSetActiveResponse {
  error?: string
  success: boolean
}

// ==================== OAuth Events ====================

export interface ProviderCancelOAuthRequest {
  cli_metadata?: CliMetadata
  providerId: string
}

export interface ProviderCancelOAuthResponse {
  success: boolean
}

export interface ProviderStartOAuthRequest {
  cli_metadata?: CliMetadata
  mode?: string
  providerId: string
}

export interface ProviderStartOAuthResponse {
  authUrl: string
  callbackMode: 'auto' | 'code-paste'
  error?: string
  success: boolean
}

export interface ProviderAwaitOAuthCallbackRequest {
  cli_metadata?: CliMetadata
  providerId: string
}

export interface ProviderAwaitOAuthCallbackResponse {
  error?: string
  success: boolean
}

export interface ProviderSubmitOAuthCodeRequest {
  cli_metadata?: CliMetadata
  code: string
  providerId: string
}

export interface ProviderSubmitOAuthCodeResponse {
  error?: string
  success: boolean
}
