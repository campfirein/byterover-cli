import type {AnalyticsEventName} from '../event-names.js'

import {AnalyticsEventNames} from '../event-names.js'
import {type CliInvocationProps, CliInvocationSchema} from './cli-invocation.js'
import {type CurateOperationAppliedProps, CurateOperationAppliedSchema} from './curate-operation-applied.js'
import {type CurateRunCompletedProps, CurateRunCompletedSchema} from './curate-run-completed.js'
import {type DaemonStartProps, DaemonStartSchema} from './daemon-start.js'
import {type McpSessionStartProps, McpSessionStartSchema} from './mcp-session-start.js'
import {type McpToolCalledProps, McpToolCalledSchema} from './mcp-tool-called.js'
import {type QueryCompletedProps, QueryCompletedSchema} from './query-completed.js'
import {type TaskCompletedProps, TaskCompletedSchema} from './task-completed.js'
import {type TaskCreatedProps, TaskCreatedSchema} from './task-created.js'
import {type TaskFailedProps, TaskFailedSchema} from './task-failed.js'

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
  [AnalyticsEventNames.CLI_INVOCATION]: CliInvocationSchema,
  [AnalyticsEventNames.CURATE_OPERATION_APPLIED]: CurateOperationAppliedSchema,
  [AnalyticsEventNames.CURATE_RUN_COMPLETED]: CurateRunCompletedSchema,
  [AnalyticsEventNames.DAEMON_START]: DaemonStartSchema,
  [AnalyticsEventNames.MCP_SESSION_START]: McpSessionStartSchema,
  [AnalyticsEventNames.MCP_TOOL_CALLED]: McpToolCalledSchema,
  [AnalyticsEventNames.QUERY_COMPLETED]: QueryCompletedSchema,
  [AnalyticsEventNames.TASK_COMPLETED]: TaskCompletedSchema,
  [AnalyticsEventNames.TASK_CREATED]: TaskCreatedSchema,
  [AnalyticsEventNames.TASK_FAILED]: TaskFailedSchema,
} as const

/**
 * Discriminated union over every event in the catalog. A consumer can
 * destructure {name, properties} and TypeScript will narrow `properties`
 * against the matching per-event type.
 */
export type AnyAnalyticsEvent =
  | {name: typeof AnalyticsEventNames.CLI_INVOCATION; properties: CliInvocationProps}
  | {name: typeof AnalyticsEventNames.CURATE_OPERATION_APPLIED; properties: CurateOperationAppliedProps}
  | {name: typeof AnalyticsEventNames.CURATE_RUN_COMPLETED; properties: CurateRunCompletedProps}
  | {name: typeof AnalyticsEventNames.DAEMON_START; properties: DaemonStartProps}
  | {name: typeof AnalyticsEventNames.MCP_SESSION_START; properties: McpSessionStartProps}
  | {name: typeof AnalyticsEventNames.MCP_TOOL_CALLED; properties: McpToolCalledProps}
  | {name: typeof AnalyticsEventNames.QUERY_COMPLETED; properties: QueryCompletedProps}
  | {name: typeof AnalyticsEventNames.TASK_COMPLETED; properties: TaskCompletedProps}
  | {name: typeof AnalyticsEventNames.TASK_CREATED; properties: TaskCreatedProps}
  | {name: typeof AnalyticsEventNames.TASK_FAILED; properties: TaskFailedProps}

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
