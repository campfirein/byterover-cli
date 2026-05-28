import type {AnalyticsEventName} from '../event-names.js'

import {AnalyticsEventNames} from '../event-names.js'
import {type AnalyticsDisabledProps, AnalyticsDisabledSchema} from './analytics-disabled.js'
import {type AuthLoginProps, AuthLoginSchema} from './auth-login.js'
import {type AuthLogoutProps, AuthLogoutSchema} from './auth-logout.js'
import {type BrvInitProps, BrvInitSchema} from './brv-init.js'
import {type CliInvocationProps, CliInvocationSchema} from './cli-invocation.js'
import {type ConnectorInstalledProps, ConnectorInstalledSchema} from './connector-installed.js'
import {type ContextTreeFileEditedProps, ContextTreeFileEditedSchema} from './context-tree-file-edited.js'
import {type CurateOperationAppliedProps, CurateOperationAppliedSchema} from './curate-operation-applied.js'
import {type CurateRunCompletedProps, CurateRunCompletedSchema} from './curate-run-completed.js'
import {type DaemonResetExecutedProps, DaemonResetExecutedSchema} from './daemon-reset-executed.js'
import {type DaemonStartProps, DaemonStartSchema} from './daemon-start.js'
import {type HubPackageInstalledProps, HubPackageInstalledSchema} from './hub-package-installed.js'
import {type HubRegistryAddedProps, HubRegistryAddedSchema} from './hub-registry-added.js'
import {type HubRegistryRemovedProps, HubRegistryRemovedSchema} from './hub-registry-removed.js'
import {type McpSessionEndedProps, McpSessionEndedSchema} from './mcp-session-ended.js'
import {type McpSessionStartProps, McpSessionStartSchema} from './mcp-session-start.js'
import {type McpToolCalledProps, McpToolCalledSchema} from './mcp-tool-called.js'
import {type MigrateRunProps, MigrateRunSchema} from './migrate-run.js'
import {type OnboardingAutoSetupStartedProps, OnboardingAutoSetupStartedSchema} from './onboarding-auto-setup-started.js'
import {type OnboardingCompletedProps, OnboardingCompletedSchema} from './onboarding-completed.js'
import {type QueryCompletedProps, QueryCompletedSchema} from './query-completed.js'
import {type ReviewApprovedProps, ReviewApprovedSchema} from './review-approved.js'
import {type ReviewRejectedProps, ReviewRejectedSchema} from './review-rejected.js'
import {type ReviewToggledProps, ReviewToggledSchema} from './review-toggled.js'
import {type SettingChangedProps, SettingChangedSchema} from './setting-changed.js'
import {type SettingResetProps, SettingResetSchema} from './setting-reset.js'
import {type SourceAddedProps, SourceAddedSchema} from './source-added.js'
import {type SourceRemovedProps, SourceRemovedSchema} from './source-removed.js'
import {type SpaceSwitchedProps, SpaceSwitchedSchema} from './space-switched.js'
import {type TaskCompletedProps, TaskCompletedSchema} from './task-completed.js'
import {type TaskCreatedProps, TaskCreatedSchema} from './task-created.js'
import {type TaskFailedProps, TaskFailedSchema} from './task-failed.js'
import {type VcBranchedProps, VcBranchedSchema} from './vc-branched.js'
import {type VcCheckedOutProps, VcCheckedOutSchema} from './vc-checked-out.js'
import {type VcClonedProps, VcClonedSchema} from './vc-cloned.js'
import {type VcCommitProps, VcCommitSchema} from './vc-commit.js'
import {type VcDiscardedProps, VcDiscardedSchema} from './vc-discarded.js'
import {type VcFetchedProps, VcFetchedSchema} from './vc-fetched.js'
import {type VcInitProps, VcInitSchema} from './vc-init.js'
import {type VcMergedProps, VcMergedSchema} from './vc-merged.js'
import {type VcPulledProps, VcPulledSchema} from './vc-pulled.js'
import {type VcPushedProps, VcPushedSchema} from './vc-pushed.js'
import {type VcRemoteChangedProps, VcRemoteChangedSchema} from './vc-remote-changed.js'
import {type VcResetExecutedProps, VcResetExecutedSchema} from './vc-reset-executed.js'
import {type WebuiSessionEndedProps, WebuiSessionEndedSchema} from './webui-session-ended.js'
import {type WebuiSessionStartedProps, WebuiSessionStartedSchema} from './webui-session-started.js'
import {type WorktreeAddedProps, WorktreeAddedSchema} from './worktree-added.js'
import {type WorktreeRemovedProps, WorktreeRemovedSchema} from './worktree-removed.js'

/**
 * Registry of every shipped event schema, keyed by wire name. Used by:
 *   - The privacy fixture, which walks every entry and asserts no field
 *     name appears on the forbidden PII list.
 *   - Per-event validation at the wire boundary (`AnalyticsHandler`).
 *
 * Adding a new event requires three steps:
 *   1. New constant in `../event-names.ts`.
 *   2. New per-event file in this folder.
 *   3. New entry in both `ALL_EVENT_SCHEMAS` and `AnyAnalyticsEvent` below.
 *
 * Some entries are deferred scaffolding for upcoming milestones — they have
 * schemas but no emitter today. The wire-side handler dispatch must still
 * cover them (drop with Zod parse) once an emitter lands.
 */
export const ALL_EVENT_SCHEMAS = {
  [AnalyticsEventNames.ANALYTICS_DISABLED]: AnalyticsDisabledSchema,
  [AnalyticsEventNames.AUTH_LOGIN]: AuthLoginSchema,
  [AnalyticsEventNames.AUTH_LOGOUT]: AuthLogoutSchema,
  [AnalyticsEventNames.BRV_INIT]: BrvInitSchema,
  [AnalyticsEventNames.CLI_INVOCATION]: CliInvocationSchema,
  [AnalyticsEventNames.CONNECTOR_INSTALLED]: ConnectorInstalledSchema,
  [AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED]: ContextTreeFileEditedSchema,
  [AnalyticsEventNames.CURATE_OPERATION_APPLIED]: CurateOperationAppliedSchema,
  [AnalyticsEventNames.CURATE_RUN_COMPLETED]: CurateRunCompletedSchema,
  [AnalyticsEventNames.DAEMON_RESET_EXECUTED]: DaemonResetExecutedSchema,
  [AnalyticsEventNames.DAEMON_START]: DaemonStartSchema,
  [AnalyticsEventNames.HUB_PACKAGE_INSTALLED]: HubPackageInstalledSchema,
  [AnalyticsEventNames.HUB_REGISTRY_ADDED]: HubRegistryAddedSchema,
  [AnalyticsEventNames.HUB_REGISTRY_REMOVED]: HubRegistryRemovedSchema,
  [AnalyticsEventNames.MCP_SESSION_ENDED]: McpSessionEndedSchema,
  [AnalyticsEventNames.MCP_SESSION_START]: McpSessionStartSchema,
  [AnalyticsEventNames.MCP_TOOL_CALLED]: McpToolCalledSchema,
  [AnalyticsEventNames.MIGRATE_RUN]: MigrateRunSchema,
  [AnalyticsEventNames.ONBOARDING_AUTO_SETUP_STARTED]: OnboardingAutoSetupStartedSchema,
  [AnalyticsEventNames.ONBOARDING_COMPLETED]: OnboardingCompletedSchema,
  [AnalyticsEventNames.QUERY_COMPLETED]: QueryCompletedSchema,
  [AnalyticsEventNames.REVIEW_APPROVED]: ReviewApprovedSchema,
  [AnalyticsEventNames.REVIEW_REJECTED]: ReviewRejectedSchema,
  [AnalyticsEventNames.REVIEW_TOGGLED]: ReviewToggledSchema,
  [AnalyticsEventNames.SETTING_CHANGED]: SettingChangedSchema,
  [AnalyticsEventNames.SETTING_RESET]: SettingResetSchema,
  [AnalyticsEventNames.SOURCE_ADDED]: SourceAddedSchema,
  [AnalyticsEventNames.SOURCE_REMOVED]: SourceRemovedSchema,
  [AnalyticsEventNames.SPACE_SWITCHED]: SpaceSwitchedSchema,
  [AnalyticsEventNames.TASK_COMPLETED]: TaskCompletedSchema,
  [AnalyticsEventNames.TASK_CREATED]: TaskCreatedSchema,
  [AnalyticsEventNames.TASK_FAILED]: TaskFailedSchema,
  [AnalyticsEventNames.VC_BRANCHED]: VcBranchedSchema,
  [AnalyticsEventNames.VC_CHECKED_OUT]: VcCheckedOutSchema,
  [AnalyticsEventNames.VC_CLONED]: VcClonedSchema,
  [AnalyticsEventNames.VC_COMMIT]: VcCommitSchema,
  [AnalyticsEventNames.VC_DISCARDED]: VcDiscardedSchema,
  [AnalyticsEventNames.VC_FETCHED]: VcFetchedSchema,
  [AnalyticsEventNames.VC_INIT]: VcInitSchema,
  [AnalyticsEventNames.VC_MERGED]: VcMergedSchema,
  [AnalyticsEventNames.VC_PULLED]: VcPulledSchema,
  [AnalyticsEventNames.VC_PUSHED]: VcPushedSchema,
  [AnalyticsEventNames.VC_REMOTE_CHANGED]: VcRemoteChangedSchema,
  [AnalyticsEventNames.VC_RESET_EXECUTED]: VcResetExecutedSchema,
  [AnalyticsEventNames.WEBUI_SESSION_ENDED]: WebuiSessionEndedSchema,
  [AnalyticsEventNames.WEBUI_SESSION_STARTED]: WebuiSessionStartedSchema,
  [AnalyticsEventNames.WORKTREE_ADDED]: WorktreeAddedSchema,
  [AnalyticsEventNames.WORKTREE_REMOVED]: WorktreeRemovedSchema,
} as const

/**
 * Discriminated union over every event in the catalog. A consumer can
 * destructure {name, properties} and TypeScript will narrow `properties`
 * against the matching per-event type.
 */
export type AnyAnalyticsEvent =
  | {name: typeof AnalyticsEventNames.ANALYTICS_DISABLED; properties: AnalyticsDisabledProps}
  | {name: typeof AnalyticsEventNames.AUTH_LOGIN; properties: AuthLoginProps}
  | {name: typeof AnalyticsEventNames.AUTH_LOGOUT; properties: AuthLogoutProps}
  | {name: typeof AnalyticsEventNames.BRV_INIT; properties: BrvInitProps}
  | {name: typeof AnalyticsEventNames.CLI_INVOCATION; properties: CliInvocationProps}
  | {name: typeof AnalyticsEventNames.CONNECTOR_INSTALLED; properties: ConnectorInstalledProps}
  | {name: typeof AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED; properties: ContextTreeFileEditedProps}
  | {name: typeof AnalyticsEventNames.CURATE_OPERATION_APPLIED; properties: CurateOperationAppliedProps}
  | {name: typeof AnalyticsEventNames.CURATE_RUN_COMPLETED; properties: CurateRunCompletedProps}
  | {name: typeof AnalyticsEventNames.DAEMON_RESET_EXECUTED; properties: DaemonResetExecutedProps}
  | {name: typeof AnalyticsEventNames.DAEMON_START; properties: DaemonStartProps}
  | {name: typeof AnalyticsEventNames.HUB_PACKAGE_INSTALLED; properties: HubPackageInstalledProps}
  | {name: typeof AnalyticsEventNames.HUB_REGISTRY_ADDED; properties: HubRegistryAddedProps}
  | {name: typeof AnalyticsEventNames.HUB_REGISTRY_REMOVED; properties: HubRegistryRemovedProps}
  | {name: typeof AnalyticsEventNames.MCP_SESSION_ENDED; properties: McpSessionEndedProps}
  | {name: typeof AnalyticsEventNames.MCP_SESSION_START; properties: McpSessionStartProps}
  | {name: typeof AnalyticsEventNames.MCP_TOOL_CALLED; properties: McpToolCalledProps}
  | {name: typeof AnalyticsEventNames.MIGRATE_RUN; properties: MigrateRunProps}
  | {name: typeof AnalyticsEventNames.ONBOARDING_AUTO_SETUP_STARTED; properties: OnboardingAutoSetupStartedProps}
  | {name: typeof AnalyticsEventNames.ONBOARDING_COMPLETED; properties: OnboardingCompletedProps}
  | {name: typeof AnalyticsEventNames.QUERY_COMPLETED; properties: QueryCompletedProps}
  | {name: typeof AnalyticsEventNames.REVIEW_APPROVED; properties: ReviewApprovedProps}
  | {name: typeof AnalyticsEventNames.REVIEW_REJECTED; properties: ReviewRejectedProps}
  | {name: typeof AnalyticsEventNames.REVIEW_TOGGLED; properties: ReviewToggledProps}
  | {name: typeof AnalyticsEventNames.SETTING_CHANGED; properties: SettingChangedProps}
  | {name: typeof AnalyticsEventNames.SETTING_RESET; properties: SettingResetProps}
  | {name: typeof AnalyticsEventNames.SOURCE_ADDED; properties: SourceAddedProps}
  | {name: typeof AnalyticsEventNames.SOURCE_REMOVED; properties: SourceRemovedProps}
  | {name: typeof AnalyticsEventNames.SPACE_SWITCHED; properties: SpaceSwitchedProps}
  | {name: typeof AnalyticsEventNames.TASK_COMPLETED; properties: TaskCompletedProps}
  | {name: typeof AnalyticsEventNames.TASK_CREATED; properties: TaskCreatedProps}
  | {name: typeof AnalyticsEventNames.TASK_FAILED; properties: TaskFailedProps}
  | {name: typeof AnalyticsEventNames.VC_BRANCHED; properties: VcBranchedProps}
  | {name: typeof AnalyticsEventNames.VC_CHECKED_OUT; properties: VcCheckedOutProps}
  | {name: typeof AnalyticsEventNames.VC_CLONED; properties: VcClonedProps}
  | {name: typeof AnalyticsEventNames.VC_COMMIT; properties: VcCommitProps}
  | {name: typeof AnalyticsEventNames.VC_DISCARDED; properties: VcDiscardedProps}
  | {name: typeof AnalyticsEventNames.VC_FETCHED; properties: VcFetchedProps}
  | {name: typeof AnalyticsEventNames.VC_INIT; properties: VcInitProps}
  | {name: typeof AnalyticsEventNames.VC_MERGED; properties: VcMergedProps}
  | {name: typeof AnalyticsEventNames.VC_PULLED; properties: VcPulledProps}
  | {name: typeof AnalyticsEventNames.VC_PUSHED; properties: VcPushedProps}
  | {name: typeof AnalyticsEventNames.VC_REMOTE_CHANGED; properties: VcRemoteChangedProps}
  | {name: typeof AnalyticsEventNames.VC_RESET_EXECUTED; properties: VcResetExecutedProps}
  | {name: typeof AnalyticsEventNames.WEBUI_SESSION_ENDED; properties: WebuiSessionEndedProps}
  | {name: typeof AnalyticsEventNames.WEBUI_SESSION_STARTED; properties: WebuiSessionStartedProps}
  | {name: typeof AnalyticsEventNames.WORKTREE_ADDED; properties: WorktreeAddedProps}
  | {name: typeof AnalyticsEventNames.WORKTREE_REMOVED; properties: WorktreeRemovedProps}

/**
 * Type-derived properties for a given event name. Magic-string typos
 * (e.g. `'daemon_starts'`) and wrong-shape payloads (e.g. `tool_name`
 * on `daemon_start`) become compile errors instead of runtime drops.
 */
export type PropsForEvent<E extends AnalyticsEventName> = Extract<AnyAnalyticsEvent, {name: E}>['properties']

/**
 * If the event has no required properties (e.g. `daemon_start`), the
 * `properties` argument is optional. Otherwise it is required. Implemented
 * via a rest tuple so the call site stays ergonomic.
 */
export type PropsArg<E extends AnalyticsEventName> = keyof PropsForEvent<E> extends never
  ? [properties?: PropsForEvent<E>]
  : [properties: PropsForEvent<E>]

/**
 * Runtime guard: narrows an unknown string to a known `AnalyticsEventName`.
 * Used by the wire-side handler to reject events that have no schema
 * before forwarding to the typed daemon client.
 */
export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
  return typeof value === 'string' && value in ALL_EVENT_SCHEMAS
}
