import type {AuthTokenDTO, BrvConfigDTO, UserDTO} from '../types/dto.js'

export const AuthEvents = {
  EXPIRED: 'auth:expired',
  GET_STATE: 'auth:getState',
  LOGIN_COMPLETED: 'auth:loginCompleted',
  LOGIN_WITH_API_KEY: 'auth:loginWithApiKey',
  LOGOUT: 'auth:logout',
  REFRESH: 'auth:refresh',
  START_LOGIN: 'auth:startLogin',
  STATE_CHANGED: 'auth:stateChanged',
  UPDATED: 'auth:updated',
} as const

export interface AuthGetStateRequest {
  projectPath: string
}

export interface AuthGetStateResponse {
  authToken?: AuthTokenDTO
  brvConfig?: BrvConfigDTO
  isAuthorized: boolean
  user?: UserDTO
}

export interface AuthStartLoginRequest {
  /**
   * When true, the daemon returns the auth URL without launching the system browser.
   * Used by clients (e.g. web UI) that prefer to open the URL themselves.
   */
  skipBrowserLaunch?: boolean
}

export interface AuthStartLoginResponse {
  authUrl: string
}

export interface AuthLoginCompletedEvent {
  error?: string
  success: boolean
  user?: UserDTO
}

export interface AuthLoginWithApiKeyRequest {
  apiKey: string
}

export interface AuthLoginWithApiKeyResponse {
  error?: string
  success: boolean
  userEmail?: string
}

export interface AuthLogoutResponse {
  error?: string
  success: boolean
}

export interface AuthRefreshResponse {
  success: boolean
}

export interface AuthStateChangedEvent {
  brvConfig?: BrvConfigDTO
  isAuthorized: boolean
  user?: UserDTO
}
