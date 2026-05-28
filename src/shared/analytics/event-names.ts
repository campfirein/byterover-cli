/**
 * Canonical wire-format names for every analytics event the daemon may emit.
 *
 * These are the values that travel as `event.name` in the analytics batch
 * (see `AnalyticsBatch` in server/core/domain/analytics/batch.ts).
 *
 * Snake_case values per the analytics spec; the keys are SCREAMING_SNAKE for
 * use as in-source constants. Adding a new event REQUIRES adding both:
 *   1. A new entry here.
 *   2. A new schema file in ./events/ and registration in ./events/index.ts.
 *
 * Some entries are deferred scaffolding (no producer yet — emitter lands in
 * a future ticket). They are intentional, not Outside-In violations; the
 * upcoming milestones will wire the producer alongside its consumer.
 */
export const AnalyticsEventNames = {
  ANALYTICS_DISABLED: 'analytics_disabled',
  AUTH_LOGIN: 'auth_login',
  AUTH_LOGOUT: 'auth_logout',
  BRV_INIT: 'brv_init',
  CLI_INVOCATION: 'cli_invocation',
  CONNECTOR_INSTALLED: 'connector_installed',
  CONTENT_MIGRATED: 'content_migrated',
  CONTEXT_TREE_FILE_EDITED: 'context_tree_file_edited',
  CURATE_OPERATION_APPLIED: 'curate_operation_applied',
  CURATE_RUN_COMPLETED: 'curate_run_completed',
  DAEMON_RESET_EXECUTED: 'daemon_reset_executed',
  DAEMON_START: 'daemon_start',
  HUB_PACKAGE_INSTALLED: 'hub_package_installed',
  HUB_REGISTRY_ADDED: 'hub_registry_added',
  HUB_REGISTRY_REMOVED: 'hub_registry_removed',
  MCP_SESSION_ENDED: 'mcp_session_ended',
  MCP_SESSION_START: 'mcp_session_start',
  MCP_TOOL_CALLED: 'mcp_tool_called',
  MIGRATE_RUN: 'migrate_run',
  ONBOARDING_AUTO_SETUP_STARTED: 'onboarding_auto_setup_started',
  ONBOARDING_COMPLETED: 'onboarding_completed',
  QUERY_COMPLETED: 'query_completed',
  REVIEW_APPROVED: 'review_approved',
  REVIEW_REJECTED: 'review_rejected',
  REVIEW_TOGGLED: 'review_toggled',
  SETTING_CHANGED: 'setting_changed',
  SETTING_RESET: 'setting_reset',
  SOURCE_ADDED: 'source_added',
  SOURCE_REMOVED: 'source_removed',
  SPACE_SWITCHED: 'space_switched',
  SWARM_ONBOARDED: 'swarm_onboarded',
  SWARM_QUERY_COMPLETED: 'swarm_query_completed',
  TASK_COMPLETED: 'task_completed',
  TASK_CREATED: 'task_created',
  TASK_FAILED: 'task_failed',
  VC_BRANCHED: 'vc_branched',
  VC_CHECKED_OUT: 'vc_checked_out',
  VC_CLONED: 'vc_cloned',
  VC_COMMIT: 'vc_commit',
  VC_DISCARDED: 'vc_discarded',
  VC_FETCHED: 'vc_fetched',
  VC_INIT: 'vc_init',
  VC_MERGED: 'vc_merged',
  VC_PULLED: 'vc_pulled',
  VC_PUSHED: 'vc_pushed',
  VC_REMOTE_CHANGED: 'vc_remote_changed',
  VC_RESET_EXECUTED: 'vc_reset_executed',
  WEBUI_SESSION_ENDED: 'webui_session_ended',
  WEBUI_SESSION_STARTED: 'webui_session_started',
  WORKTREE_ADDED: 'worktree_added',
  WORKTREE_REMOVED: 'worktree_removed',
} as const

export type AnalyticsEventName = (typeof AnalyticsEventNames)[keyof typeof AnalyticsEventNames]
