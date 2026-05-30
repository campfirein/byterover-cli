import {z} from 'zod'

import type {AnalyticsEventName} from '../event-names.js'

import {AnalyticsEventNames} from '../event-names.js'
import {AnalyticsDisabledSchema} from './analytics-disabled.js'
import {AuthLoginSchema} from './auth-login.js'
import {AuthLogoutSchema} from './auth-logout.js'
import {BrvInitSchema} from './brv-init.js'
import {CliInvocationSchema} from './cli-invocation.js'
import {ConnectorInstalledSchema} from './connector-installed.js'
import {ContentMigratedSchema} from './content-migrated.js'
import {ContextTreeFileEditedSchema} from './context-tree-file-edited.js'
import {CurateOperationAppliedSchema} from './curate-operation-applied.js'
import {CurateRunCompletedSchema} from './curate-run-completed.js'
import {DaemonResetExecutedSchema} from './daemon-reset-executed.js'
import {DaemonStartSchema} from './daemon-start.js'
import {HubPackageInstalledSchema} from './hub-package-installed.js'
import {HubRegistryAddedSchema} from './hub-registry-added.js'
import {HubRegistryRemovedSchema} from './hub-registry-removed.js'
import {McpSessionEndedSchema} from './mcp-session-ended.js'
import {McpSessionStartSchema} from './mcp-session-start.js'
import {McpToolCalledSchema} from './mcp-tool-called.js'
import {MigrateRunSchema} from './migrate-run.js'
import {OnboardingAutoSetupStartedSchema} from './onboarding-auto-setup-started.js'
import {OnboardingCompletedSchema} from './onboarding-completed.js'
import {QueryCompletedSchema} from './query-completed.js'
import {ReviewApprovedSchema} from './review-approved.js'
import {ReviewRejectedSchema} from './review-rejected.js'
import {ReviewToggledSchema} from './review-toggled.js'
import {SettingChangedSchema} from './setting-changed.js'
import {SettingResetSchema} from './setting-reset.js'
import {SourceAddedSchema} from './source-added.js'
import {SourceRemovedSchema} from './source-removed.js'
import {SpaceSwitchedSchema} from './space-switched.js'
import {SwarmOnboardedSchema} from './swarm-onboarded.js'
import {SwarmQueryCompletedSchema} from './swarm-query-completed.js'
import {SwarmStoreCompletedSchema} from './swarm-store-completed.js'
import {TaskCompletedSchema} from './task-completed.js'
import {TaskCreatedSchema} from './task-created.js'
import {TaskFailedSchema} from './task-failed.js'
import {VcBranchedSchema} from './vc-branched.js'
import {VcCheckedOutSchema} from './vc-checked-out.js'
import {VcClonedSchema} from './vc-cloned.js'
import {VcCommitSchema} from './vc-commit.js'
import {VcDiscardedSchema} from './vc-discarded.js'
import {VcFetchedSchema} from './vc-fetched.js'
import {VcInitSchema} from './vc-init.js'
import {VcMergedSchema} from './vc-merged.js'
import {VcPulledSchema} from './vc-pulled.js'
import {VcPushedSchema} from './vc-pushed.js'
import {VcRemoteChangedSchema} from './vc-remote-changed.js'
import {VcResetExecutedSchema} from './vc-reset-executed.js'
import {WebuiSessionEndedSchema} from './webui-session-ended.js'
import {WebuiSessionStartedSchema} from './webui-session-started.js'
import {WorktreeAddedSchema} from './worktree-added.js'
import {WorktreeRemovedSchema} from './worktree-removed.js'

/**
 * THE single source of truth for the analytics event catalog: every shipped
 * event keyed by wire name, mapped to its per-event property schema.
 *
 * Everything else derives from this map — the `AnyAnalyticsEvent` union, the
 * `PropsForEvent` / `PropsArg` types used by `track<E>()`, the runtime guard
 * `isAnalyticsEventName`, and the wire-side validation in `AnalyticsHandler`
 * (`ALL_EVENT_SCHEMAS[event].safeParse(...)`). There is no second list to keep
 * in sync.
 *
 * `satisfies Record<AnalyticsEventName, z.ZodTypeAny>` makes completeness a
 * compile error: registering a new `AnalyticsEventName` without a schema entry
 * here fails the build. `as const` preserves the precise per-key schema types
 * so the derivations below stay exact.
 *
 * Adding a new event:
 *   1. New constant in `../event-names.ts`.
 *   2. New per-event schema file in this folder.
 *   3. New entry here. (The union and the prop types update automatically.)
 *
 * Some entries are deferred scaffolding for upcoming milestones — they have
 * schemas but no emitter today. Wire-side validation already covers them.
 */
export const ALL_EVENT_SCHEMAS = {
  [AnalyticsEventNames.ANALYTICS_DISABLED]: AnalyticsDisabledSchema,
  [AnalyticsEventNames.AUTH_LOGIN]: AuthLoginSchema,
  [AnalyticsEventNames.AUTH_LOGOUT]: AuthLogoutSchema,
  [AnalyticsEventNames.BRV_INIT]: BrvInitSchema,
  [AnalyticsEventNames.CLI_INVOCATION]: CliInvocationSchema,
  [AnalyticsEventNames.CONNECTOR_INSTALLED]: ConnectorInstalledSchema,
  [AnalyticsEventNames.CONTENT_MIGRATED]: ContentMigratedSchema,
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
  [AnalyticsEventNames.SWARM_ONBOARDED]: SwarmOnboardedSchema,
  [AnalyticsEventNames.SWARM_QUERY_COMPLETED]: SwarmQueryCompletedSchema,
  [AnalyticsEventNames.SWARM_STORE_COMPLETED]: SwarmStoreCompletedSchema,
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
} as const satisfies Record<AnalyticsEventName, z.ZodTypeAny>

/**
 * Discriminated union over every event in the catalog, DERIVED from
 * `ALL_EVENT_SCHEMAS` (no hand-maintained second list). A consumer can
 * destructure `{name, properties}` and TypeScript narrows `properties`
 * against the matching per-event type.
 */
export type AnyAnalyticsEvent = {
  [E in AnalyticsEventName]: {name: E; properties: z.infer<(typeof ALL_EVENT_SCHEMAS)[E]>}
}[AnalyticsEventName]

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
  // `Object.hasOwn`, NOT the `in` operator: `in` walks the prototype chain, so
  // 'toString' / 'constructor' / 'valueOf' / '__proto__' etc. would pass the
  // guard, and `ALL_EVENT_SCHEMAS[event]` would then resolve to an inherited
  // Object.prototype member (a Function, not a Zod schema) whose `.safeParse`
  // is undefined — throwing at the wire-side dispatch. Own-property only.
  return typeof value === 'string' && Object.hasOwn(ALL_EVENT_SCHEMAS, value)
}
