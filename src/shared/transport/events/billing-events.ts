import type {BillingFreeUserLimitDTO, BillingUsageDTO, StatusBillingDTO} from '../types/dto.js'

export const BillingEvents = {
  GET_FREE_USER_LIMIT: 'billing:getFreeUserLimit',
  GET_PINNED_TEAM: 'billing:getPinnedTeam',
  GET_USAGE: 'billing:getUsage',
  LIST_USAGE: 'billing:listUsage',
  RESOLVE: 'billing:resolve',
  SET_PINNED_TEAM: 'billing:setPinnedTeam',
} as const

export interface BillingResolveResponse {
  billing?: StatusBillingDTO
  error?: string
}

export interface BillingGetUsageRequest {
  /** Organization (team) whose usage should be reported. */
  organizationId: string
}

export interface BillingGetUsageResponse {
  error?: string
  usage?: BillingUsageDTO
}

export interface BillingListUsageResponse {
  /** Top-level error (auth/transport). When present, `usage` is omitted. */
  error?: string
  /** Every organization the user belongs to, keyed by organizationId. */
  usage?: Record<string, BillingUsageDTO>
}

export interface BillingGetFreeUserLimitResponse {
  error?: string
  limit?: BillingFreeUserLimitDTO
}

export interface BillingGetPinnedTeamRequest {
  projectPath: string
}

export interface BillingGetPinnedTeamResponse {
  error?: string
  /** When undefined, no pin is set and the consumer should fall back to its workspace default. */
  teamId?: string
}

export interface BillingSetPinnedTeamRequest {
  projectPath: string
  /** Pass `undefined` (or omit) to clear the pin. */
  teamId?: string
}

export interface BillingSetPinnedTeamResponse {
  error?: string
  success: boolean
}
