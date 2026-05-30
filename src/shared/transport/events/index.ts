// DTOs
export * from '../types/dto.js'

// Event constants and types
export * from './agent-events.js'
export * from './auth-events.js'
export * from './billing-events.js'
export * from './client-events.js'
export * from './config-events.js'
export * from './connector-events.js'
export * from './context-tree-events.js'
export * from './hub-events.js'
export * from './init-events.js'
export * from './llm-events.js'
export * from './locations-events.js'
export * from './migrate-events.js'
export * from './model-events.js'
export * from './onboarding-events.js'
export * from './provider-events.js'
export * from './pull-events.js'
export * from './push-events.js'
export * from './reset-events.js'
export * from './review-events.js'
export * from './session-events.js'
export * from './settings-events.js'
export * from './source-events.js'
export * from './space-events.js'
export * from './status-events.js'
export * from './task-events.js'
export * from './team-events.js'
export * from './vc-events.js'
export * from './worktree-events.js'

// Utility exports
import {AgentEvents} from './agent-events.js'
import {AuthEvents} from './auth-events.js'
import {BillingEvents} from './billing-events.js'
import {ClientEvents} from './client-events.js'
import {ConfigEvents} from './config-events.js'
import {ConnectorEvents} from './connector-events.js'
import {ContextTreeEvents} from './context-tree-events.js'
import {HubEvents} from './hub-events.js'
import {InitEvents} from './init-events.js'
import {LlmEvents} from './llm-events.js'
import {LocationsEvents} from './locations-events.js'
import {MigrateEvents} from './migrate-events.js'
import {ModelEvents} from './model-events.js'
import {OnboardingEvents} from './onboarding-events.js'
import {ProviderEvents} from './provider-events.js'
import {PullEvents} from './pull-events.js'
import {PushEvents} from './push-events.js'
import {ResetEvents} from './reset-events.js'
import {ReviewEvents} from './review-events.js'
import {SessionEvents} from './session-events.js'
import {SettingsEvents} from './settings-events.js'
import {SourceEvents} from './source-events.js'
import {SpaceEvents} from './space-events.js'
import {StatusEvents} from './status-events.js'
import {TaskEvents} from './task-events.js'
import {TeamEvents} from './team-events.js'
import {VcEvents} from './vc-events.js'
import {WorktreeEvents} from './worktree-events.js'

/**
 * Array of all event group objects for iteration.
 * Use this to subscribe to all events without key collisions.
 */
export const AllEventGroups = [
  AgentEvents,
  AuthEvents,
  BillingEvents,
  ClientEvents,
  ConfigEvents,
  ConnectorEvents,
  ContextTreeEvents,
  HubEvents,
  InitEvents,
  LlmEvents,
  MigrateEvents,
  ModelEvents,
  OnboardingEvents,
  ProviderEvents,
  PullEvents,
  PushEvents,
  ResetEvents,
  ReviewEvents,
  SessionEvents,
  SettingsEvents,
  LocationsEvents,
  SourceEvents,
  SpaceEvents,
  StatusEvents,
  TaskEvents,
  TeamEvents,
  VcEvents,
  WorktreeEvents,
] as const

/**
 * Get all unique event values from all event groups.
 */
export function getAllEventValues(): string[] {
  const values = new Set<string>()
  for (const group of AllEventGroups) {
    for (const value of Object.values(group)) {
      values.add(value)
    }
  }

  return [...values]
}
