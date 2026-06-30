 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'

export const AgentEvents = {
  CONNECTED: 'agent:connected',
  DISCONNECTED: 'agent:disconnected',
  NEW_SESSION: 'agent:newSession',
  NEW_SESSION_CREATED: 'agent:newSessionCreated',
  RESTART: 'agent:restart',
  RESTARTED: 'agent:restarted',
  RESTARTING: 'agent:restarting',
  STATUS_CHANGED: 'agent:status:changed',
} as const

export interface AgentRestartRequest {
  cli_metadata?: CliMetadata
  reason: string
}

export interface AgentRestartResponse {
  success: boolean
}

export interface AgentNewSessionRequest {
  cli_metadata?: CliMetadata
  reason?: string
}

export interface AgentNewSessionResponse {
  error?: string
  sessionId?: string
  success: boolean
}
