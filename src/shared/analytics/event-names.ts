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
  CLI_INVOCATION: 'cli_invocation',
  CURATE_OPERATION_APPLIED: 'curate_operation_applied',
  CURATE_RUN_COMPLETED: 'curate_run_completed',
  DAEMON_START: 'daemon_start',
  MCP_SESSION_START: 'mcp_session_start',
  MCP_TOOL_CALLED: 'mcp_tool_called',
  QUERY_COMPLETED: 'query_completed',
  TASK_COMPLETED: 'task_completed',
  TASK_CREATED: 'task_created',
  TASK_FAILED: 'task_failed',
} as const

export type AnalyticsEventName = (typeof AnalyticsEventNames)[keyof typeof AnalyticsEventNames]
