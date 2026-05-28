import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {AnalyticsDisabledSchema} from '../../../../shared/analytics/events/analytics-disabled.js'
import {AuthLoginSchema} from '../../../../shared/analytics/events/auth-login.js'
import {AuthLogoutSchema} from '../../../../shared/analytics/events/auth-logout.js'
import {BrvInitSchema} from '../../../../shared/analytics/events/brv-init.js'
import {CliInvocationSchema} from '../../../../shared/analytics/events/cli-invocation.js'
import {ConnectorInstalledSchema} from '../../../../shared/analytics/events/connector-installed.js'
import {ContentMigratedSchema} from '../../../../shared/analytics/events/content-migrated.js'
import {ContextTreeFileEditedSchema} from '../../../../shared/analytics/events/context-tree-file-edited.js'
import {CurateOperationAppliedSchema} from '../../../../shared/analytics/events/curate-operation-applied.js'
import {CurateRunCompletedSchema} from '../../../../shared/analytics/events/curate-run-completed.js'
import {DaemonResetExecutedSchema} from '../../../../shared/analytics/events/daemon-reset-executed.js'
import {DaemonStartSchema} from '../../../../shared/analytics/events/daemon-start.js'
import {HubPackageInstalledSchema} from '../../../../shared/analytics/events/hub-package-installed.js'
import {HubRegistryAddedSchema} from '../../../../shared/analytics/events/hub-registry-added.js'
import {HubRegistryRemovedSchema} from '../../../../shared/analytics/events/hub-registry-removed.js'
import {isAnalyticsEventName} from '../../../../shared/analytics/events/index.js'
import {McpSessionEndedSchema} from '../../../../shared/analytics/events/mcp-session-ended.js'
import {McpSessionStartSchema} from '../../../../shared/analytics/events/mcp-session-start.js'
import {McpToolCalledSchema} from '../../../../shared/analytics/events/mcp-tool-called.js'
import {MigrateRunSchema} from '../../../../shared/analytics/events/migrate-run.js'
import {OnboardingAutoSetupStartedSchema} from '../../../../shared/analytics/events/onboarding-auto-setup-started.js'
import {OnboardingCompletedSchema} from '../../../../shared/analytics/events/onboarding-completed.js'
import {QueryCompletedSchema} from '../../../../shared/analytics/events/query-completed.js'
import {ReviewApprovedSchema} from '../../../../shared/analytics/events/review-approved.js'
import {ReviewRejectedSchema} from '../../../../shared/analytics/events/review-rejected.js'
import {ReviewToggledSchema} from '../../../../shared/analytics/events/review-toggled.js'
import {SettingChangedSchema} from '../../../../shared/analytics/events/setting-changed.js'
import {SettingResetSchema} from '../../../../shared/analytics/events/setting-reset.js'
import {SourceAddedSchema} from '../../../../shared/analytics/events/source-added.js'
import {SourceRemovedSchema} from '../../../../shared/analytics/events/source-removed.js'
import {SpaceSwitchedSchema} from '../../../../shared/analytics/events/space-switched.js'
import {SwarmOnboardedSchema} from '../../../../shared/analytics/events/swarm-onboarded.js'
import {SwarmQueryCompletedSchema} from '../../../../shared/analytics/events/swarm-query-completed.js'
import {SwarmStoreCompletedSchema} from '../../../../shared/analytics/events/swarm-store-completed.js'
import {TaskCompletedSchema} from '../../../../shared/analytics/events/task-completed.js'
import {TaskCreatedSchema} from '../../../../shared/analytics/events/task-created.js'
import {TaskFailedSchema} from '../../../../shared/analytics/events/task-failed.js'
import {VcBranchedSchema} from '../../../../shared/analytics/events/vc-branched.js'
import {VcCheckedOutSchema} from '../../../../shared/analytics/events/vc-checked-out.js'
import {VcClonedSchema} from '../../../../shared/analytics/events/vc-cloned.js'
import {VcCommitSchema} from '../../../../shared/analytics/events/vc-commit.js'
import {VcDiscardedSchema} from '../../../../shared/analytics/events/vc-discarded.js'
import {VcFetchedSchema} from '../../../../shared/analytics/events/vc-fetched.js'
import {VcInitSchema} from '../../../../shared/analytics/events/vc-init.js'
import {VcMergedSchema} from '../../../../shared/analytics/events/vc-merged.js'
import {VcPulledSchema} from '../../../../shared/analytics/events/vc-pulled.js'
import {VcPushedSchema} from '../../../../shared/analytics/events/vc-pushed.js'
import {VcRemoteChangedSchema} from '../../../../shared/analytics/events/vc-remote-changed.js'
import {VcResetExecutedSchema} from '../../../../shared/analytics/events/vc-reset-executed.js'
import {WebuiSessionEndedSchema} from '../../../../shared/analytics/events/webui-session-ended.js'
import {WebuiSessionStartedSchema} from '../../../../shared/analytics/events/webui-session-started.js'
import {WorktreeAddedSchema} from '../../../../shared/analytics/events/worktree-added.js'
import {WorktreeRemovedSchema} from '../../../../shared/analytics/events/worktree-removed.js'
import {
  AnalyticsEvents,
  type AnalyticsTrackPayload,
  AnalyticsTrackPayloadSchema,
} from '../../../../shared/transport/events/analytics-events.js'

export interface AnalyticsHandlerDeps {
  analyticsClient: IAnalyticsClient
  transport: ITransportServer
}

/**
 * Daemon-side handler for `analytics:track`. Routes validated payloads to the
 * daemon-scoped AnalyticsClient, which stamps identity + super-properties and
 * enqueues for later flush.
 *
 * Validation runs at two layers:
 *   1. Wire envelope (`AnalyticsTrackPayloadSchema`) — event is non-empty
 *      string, properties is record-or-undefined.
 *   2. Per-event (`ALL_EVENT_SCHEMAS[event]`) — exact property shape for the
 *      registered event. Unknown events and shape mismatches are dropped here,
 *      so the daemon's typed `track<E>()` always receives a valid pair.
 *
 * The dispatch switch covers every entry in `AnalyticsEventNames`, including
 * deferred scaffolding events that have a schema but no daemon-side producer
 * yet. Wire-side validation is in place for the moment the producer ticket lands.
 *
 * Malformed payloads and any throw from track() are silently dropped:
 * analytics MUST NOT crash the emitting client.
 */
export class AnalyticsHandler {
  private readonly analyticsClient: IAnalyticsClient
  private readonly transport: ITransportServer

  public constructor(deps: AnalyticsHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.transport = deps.transport
  }

  public setup(): void {
    this.transport.onRequest<AnalyticsTrackPayload, void>(AnalyticsEvents.TRACK, async (data: unknown) => {
      const parsed = AnalyticsTrackPayloadSchema.safeParse(data)
      if (!parsed.success) return

      const {event, properties: rawProperties} = parsed.data
      if (!isAnalyticsEventName(event)) return

      try {
        this.dispatch(event, rawProperties)
      } catch {
        // Defensive: never crash the emitter.
      }
    })
  }

  /**
   * Per-event Zod validation + typed dispatch into `IAnalyticsClient.track`.
   * Each branch re-uses the catalog's per-event schema so the data flowing
   * into `track()` matches the discriminated-union contract at compile time —
   * no `as` casts.
   */
  // eslint-disable-next-line complexity
  private dispatch(event: AnalyticsEventName, rawProperties: unknown): void {
    switch (event) {
      case AnalyticsEventNames.ANALYTICS_DISABLED: {
        const props = AnalyticsDisabledSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.ANALYTICS_DISABLED)
        break
      }

      case AnalyticsEventNames.AUTH_LOGIN: {
        const props = AuthLoginSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.AUTH_LOGIN, props.data)
        break
      }

      case AnalyticsEventNames.AUTH_LOGOUT: {
        const props = AuthLogoutSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.AUTH_LOGOUT, props.data)
        break
      }

      case AnalyticsEventNames.BRV_INIT: {
        const props = BrvInitSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.BRV_INIT, props.data)
        break
      }

      case AnalyticsEventNames.CLI_INVOCATION: {
        const props = CliInvocationSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.CLI_INVOCATION, props.data)
        break
      }

      case AnalyticsEventNames.CONNECTOR_INSTALLED: {
        const props = ConnectorInstalledSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.CONNECTOR_INSTALLED, props.data)
        break
      }

      case AnalyticsEventNames.CONTENT_MIGRATED: {
        const props = ContentMigratedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.CONTENT_MIGRATED, props.data)
        break
      }

      case AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED: {
        const props = ContextTreeFileEditedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.CONTEXT_TREE_FILE_EDITED, props.data)
        break
      }

      case AnalyticsEventNames.CURATE_OPERATION_APPLIED: {
        const props = CurateOperationAppliedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.CURATE_OPERATION_APPLIED, props.data)
        break
      }

      case AnalyticsEventNames.CURATE_RUN_COMPLETED: {
        const props = CurateRunCompletedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.CURATE_RUN_COMPLETED, props.data)
        break
      }

      case AnalyticsEventNames.DAEMON_RESET_EXECUTED: {
        const props = DaemonResetExecutedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.DAEMON_RESET_EXECUTED, props.data)
        break
      }

      case AnalyticsEventNames.DAEMON_START: {
        const props = DaemonStartSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.DAEMON_START)
        break
      }

      case AnalyticsEventNames.HUB_PACKAGE_INSTALLED: {
        const props = HubPackageInstalledSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.HUB_PACKAGE_INSTALLED, props.data)
        break
      }

      case AnalyticsEventNames.HUB_REGISTRY_ADDED: {
        const props = HubRegistryAddedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.HUB_REGISTRY_ADDED, props.data)
        break
      }

      case AnalyticsEventNames.HUB_REGISTRY_REMOVED: {
        const props = HubRegistryRemovedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.HUB_REGISTRY_REMOVED, props.data)
        break
      }

      case AnalyticsEventNames.MCP_SESSION_ENDED: {
        const props = McpSessionEndedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.MCP_SESSION_ENDED, props.data)
        break
      }

      case AnalyticsEventNames.MCP_SESSION_START: {
        const props = McpSessionStartSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.MCP_SESSION_START, props.data)
        break
      }

      case AnalyticsEventNames.MCP_TOOL_CALLED: {
        const props = McpToolCalledSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.MCP_TOOL_CALLED, props.data)
        break
      }

      case AnalyticsEventNames.MIGRATE_RUN: {
        const props = MigrateRunSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.MIGRATE_RUN, props.data)
        break
      }

      case AnalyticsEventNames.ONBOARDING_AUTO_SETUP_STARTED: {
        const props = OnboardingAutoSetupStartedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.ONBOARDING_AUTO_SETUP_STARTED, props.data)
        break
      }

      case AnalyticsEventNames.ONBOARDING_COMPLETED: {
        const props = OnboardingCompletedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.ONBOARDING_COMPLETED, props.data)
        break
      }

      case AnalyticsEventNames.QUERY_COMPLETED: {
        const props = QueryCompletedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.QUERY_COMPLETED, props.data)
        break
      }

      case AnalyticsEventNames.REVIEW_APPROVED: {
        const props = ReviewApprovedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.REVIEW_APPROVED, props.data)
        break
      }

      case AnalyticsEventNames.REVIEW_REJECTED: {
        const props = ReviewRejectedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.REVIEW_REJECTED, props.data)
        break
      }

      case AnalyticsEventNames.REVIEW_TOGGLED: {
        const props = ReviewToggledSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.REVIEW_TOGGLED, props.data)
        break
      }

      case AnalyticsEventNames.SETTING_CHANGED: {
        const props = SettingChangedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SETTING_CHANGED, props.data)
        break
      }

      case AnalyticsEventNames.SETTING_RESET: {
        const props = SettingResetSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SETTING_RESET, props.data)
        break
      }

      case AnalyticsEventNames.SOURCE_ADDED: {
        const props = SourceAddedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SOURCE_ADDED, props.data)
        break
      }

      case AnalyticsEventNames.SOURCE_REMOVED: {
        const props = SourceRemovedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SOURCE_REMOVED, props.data)
        break
      }

      case AnalyticsEventNames.SPACE_SWITCHED: {
        const props = SpaceSwitchedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SPACE_SWITCHED, props.data)
        break
      }

      case AnalyticsEventNames.SWARM_ONBOARDED: {
        const props = SwarmOnboardedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SWARM_ONBOARDED, props.data)
        break
      }

      case AnalyticsEventNames.SWARM_QUERY_COMPLETED: {
        const props = SwarmQueryCompletedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SWARM_QUERY_COMPLETED, props.data)
        break
      }

      case AnalyticsEventNames.SWARM_STORE_COMPLETED: {
        const props = SwarmStoreCompletedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.SWARM_STORE_COMPLETED, props.data)
        break
      }

      case AnalyticsEventNames.TASK_COMPLETED: {
        const props = TaskCompletedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.TASK_COMPLETED, props.data)
        break
      }

      case AnalyticsEventNames.TASK_CREATED: {
        const props = TaskCreatedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.TASK_CREATED, props.data)
        break
      }

      case AnalyticsEventNames.TASK_FAILED: {
        const props = TaskFailedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.TASK_FAILED, props.data)
        break
      }

      case AnalyticsEventNames.VC_BRANCHED: {
        const props = VcBranchedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_BRANCHED, props.data)
        break
      }

      case AnalyticsEventNames.VC_CHECKED_OUT: {
        const props = VcCheckedOutSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_CHECKED_OUT, props.data)
        break
      }

      case AnalyticsEventNames.VC_CLONED: {
        const props = VcClonedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_CLONED, props.data)
        break
      }

      case AnalyticsEventNames.VC_COMMIT: {
        const props = VcCommitSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_COMMIT, props.data)
        break
      }

      case AnalyticsEventNames.VC_DISCARDED: {
        const props = VcDiscardedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_DISCARDED, props.data)
        break
      }

      case AnalyticsEventNames.VC_FETCHED: {
        const props = VcFetchedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_FETCHED, props.data)
        break
      }

      case AnalyticsEventNames.VC_INIT: {
        const props = VcInitSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_INIT, props.data)
        break
      }

      case AnalyticsEventNames.VC_MERGED: {
        const props = VcMergedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_MERGED, props.data)
        break
      }

      case AnalyticsEventNames.VC_PULLED: {
        const props = VcPulledSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_PULLED, props.data)
        break
      }

      case AnalyticsEventNames.VC_PUSHED: {
        const props = VcPushedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_PUSHED, props.data)
        break
      }

      case AnalyticsEventNames.VC_REMOTE_CHANGED: {
        const props = VcRemoteChangedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_REMOTE_CHANGED, props.data)
        break
      }

      case AnalyticsEventNames.VC_RESET_EXECUTED: {
        const props = VcResetExecutedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.VC_RESET_EXECUTED, props.data)
        break
      }

      case AnalyticsEventNames.WEBUI_SESSION_ENDED: {
        const props = WebuiSessionEndedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.WEBUI_SESSION_ENDED, props.data)
        break
      }

      case AnalyticsEventNames.WEBUI_SESSION_STARTED: {
        const props = WebuiSessionStartedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.WEBUI_SESSION_STARTED, props.data)
        break
      }

      case AnalyticsEventNames.WORKTREE_ADDED: {
        const props = WorktreeAddedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.WORKTREE_ADDED, props.data)
        break
      }

      case AnalyticsEventNames.WORKTREE_REMOVED: {
        const props = WorktreeRemovedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.WORKTREE_REMOVED, props.data)
        break
      }
      // No default — `event` is narrowed to AnalyticsEventName by isAnalyticsEventName().
    }
  }
}
