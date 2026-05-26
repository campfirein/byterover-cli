 
import type {CliMetadata} from '../../analytics/cli-metadata-schema.js'

export const OnboardingEvents = {
  AUTO_SETUP: 'onboarding:autoSetup',
  COMPLETE: 'onboarding:complete',
  GET_STATE: 'onboarding:getState',
} as const

export interface OnboardingGetStateResponse {
  hasOnboarded: boolean
}

export interface OnboardingAutoSetupResponse {
  error?: string
  success: boolean
}

export interface OnboardingCompleteRequest {
  cli_metadata?: CliMetadata
  skipped?: boolean
}

export interface OnboardingCompleteResponse {
  success: boolean
}
