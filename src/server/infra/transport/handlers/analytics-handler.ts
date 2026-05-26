import type {AnalyticsEventName} from '../../../../shared/analytics/event-names.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {CliInvocationSchema} from '../../../../shared/analytics/events/cli-invocation.js'
import {CurateOperationAppliedSchema} from '../../../../shared/analytics/events/curate-operation-applied.js'
import {CurateRunCompletedSchema} from '../../../../shared/analytics/events/curate-run-completed.js'
import {DaemonStartSchema} from '../../../../shared/analytics/events/daemon-start.js'
import {isAnalyticsEventName} from '../../../../shared/analytics/events/index.js'
import {McpSessionStartSchema} from '../../../../shared/analytics/events/mcp-session-start.js'
import {McpToolCalledSchema} from '../../../../shared/analytics/events/mcp-tool-called.js'
import {QueryCompletedSchema} from '../../../../shared/analytics/events/query-completed.js'
import {TaskCompletedSchema} from '../../../../shared/analytics/events/task-completed.js'
import {TaskCreatedSchema} from '../../../../shared/analytics/events/task-created.js'
import {TaskFailedSchema} from '../../../../shared/analytics/events/task-failed.js'
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
 * deferred scaffolding events (cli_invocation, mcp_*, task_*) that have a
 * schema but no daemon-side producer yet. Wire-side validation is in place
 * for the moment the producer ticket lands.
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
      case AnalyticsEventNames.CLI_INVOCATION: {
        const props = CliInvocationSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.CLI_INVOCATION, props.data)
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

      case AnalyticsEventNames.DAEMON_START: {
        const props = DaemonStartSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.DAEMON_START)
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

      case AnalyticsEventNames.QUERY_COMPLETED: {
        const props = QueryCompletedSchema.safeParse(rawProperties ?? {})
        if (!props.success) return
        this.analyticsClient.track(AnalyticsEventNames.QUERY_COMPLETED, props.data)
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
      // No default — `event` is narrowed to AnalyticsEventName by isAnalyticsEventName().
    }
  }
}
