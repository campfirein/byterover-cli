/**
 * Handler for `swarm:*` transport events.
 *
 * Thin emit surface for the federated-memory-provider operations
 * (`brv swarm query`, `brv swarm curate`, `brv swarm onboard`). The
 * coordinator itself still lives in the agent process at
 * `src/agent/infra/swarm/swarm-coordinator.ts` — the daemon does NOT
 * proxy the operations today. The CLI commands run swarm-coordinator
 * client-side and dispatch one of these three transport events to
 * the daemon when the operation terminates. The handler validates
 * the payload against the per-event Zod schema and forwards to
 * `analyticsClient.track()`.
 *
 * Mirrors the try/processLog pattern from `SettingsHandler` and
 * `MigrateHandler` so analytics failures never affect command
 * outcomes — the CLI gets `tracked: false` plus a reason; nothing
 * throws.
 *
 * Forward direction (out of scope for this commit): if the swarm
 * coordinator is moved into the daemon process, the SAME three event
 * names extend to carry the operation request payloads. Only the
 * handler internals change; CLI / LLM-tool callers stay unchanged.
 */

import type {SwarmOnboardedProps} from '../../../../shared/analytics/events/swarm-onboarded.js'
import type {SwarmQueryCompletedProps} from '../../../../shared/analytics/events/swarm-query-completed.js'
import type {SwarmStoreCompletedProps} from '../../../../shared/analytics/events/swarm-store-completed.js'
import type {
  SwarmTrackOnboardedRequest,
  SwarmTrackQueryCompletedRequest,
  SwarmTrackResponse,
  SwarmTrackStoreCompletedRequest,
} from '../../../../shared/transport/events/swarm-events.js'
import type {IAnalyticsClient} from '../../../core/interfaces/analytics/i-analytics-client.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {AnalyticsEventNames} from '../../../../shared/analytics/event-names.js'
import {SwarmOnboardedSchema} from '../../../../shared/analytics/events/swarm-onboarded.js'
import {SwarmQueryCompletedSchema} from '../../../../shared/analytics/events/swarm-query-completed.js'
import {SwarmStoreCompletedSchema} from '../../../../shared/analytics/events/swarm-store-completed.js'
import {SwarmEvents} from '../../../../shared/transport/events/swarm-events.js'
import {processLog} from '../../../utils/process-logger.js'

export interface SwarmHandlerDeps {
  /**
   * Optional — when undefined the handler still registers the transport
   * events but returns `{tracked: false, reason: 'analytics-unavailable'}`
   * for every call. Lets the wiring exist before analytics is plumbed
   * in test harnesses.
   */
  readonly analyticsClient?: IAnalyticsClient
  transport: ITransportServer
}

export class SwarmHandler {
  private readonly analyticsClient: IAnalyticsClient | undefined
  private readonly transport: ITransportServer

  constructor(deps: SwarmHandlerDeps) {
    this.analyticsClient = deps.analyticsClient
    this.transport = deps.transport
  }

  setup(): void {
    this.transport.onRequest<SwarmTrackQueryCompletedRequest, SwarmTrackResponse>(
      SwarmEvents.TRACK_QUERY_COMPLETED,
      (data) => this.handleTrackQueryCompleted(data),
    )
    this.transport.onRequest<SwarmTrackStoreCompletedRequest, SwarmTrackResponse>(
      SwarmEvents.TRACK_STORE_COMPLETED,
      (data) => this.handleTrackStoreCompleted(data),
    )
    this.transport.onRequest<SwarmTrackOnboardedRequest, SwarmTrackResponse>(
      SwarmEvents.TRACK_ONBOARDED,
      (data) => this.handleTrackOnboarded(data),
    )
  }

  private emit<P>(
    eventName: typeof AnalyticsEventNames[keyof typeof AnalyticsEventNames],
    properties: P,
  ): SwarmTrackResponse {
    const client = this.analyticsClient
    if (!client) return {reason: 'analytics-unavailable', tracked: false}
    try {
      // The `track` method is typed against AnalyticsEventNames; the
      // dispatch above ensures each branch passes the matching props
      // type. A direct call here keeps the type-narrowing without an
      // `as` cast — the schema parse already validated the shape.
      ;(client.track as (event: string, props: P) => void)(eventName, properties)
      return {tracked: true}
    } catch (error) {
      processLog(
        `[Swarm] analytics track ${eventName} failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      return {reason: 'analytics-throw', tracked: false}
    }
  }

  private handleTrackOnboarded(data: SwarmTrackOnboardedRequest): SwarmTrackResponse {
    const parsed = SwarmOnboardedSchema.safeParse(data)
    if (!parsed.success) return {reason: 'schema-rejection', tracked: false}
    return this.emit<SwarmOnboardedProps>(AnalyticsEventNames.SWARM_ONBOARDED, parsed.data)
  }

  private handleTrackQueryCompleted(data: SwarmTrackQueryCompletedRequest): SwarmTrackResponse {
    // Validate at the transport boundary — the CLI is an external trust
    // boundary even though we ship it ourselves. A future re-version of
    // the CLI sending an outdated wire shape gets a clean rejection here
    // rather than a malformed row in raw_events.
    const parsed = SwarmQueryCompletedSchema.safeParse(data)
    if (!parsed.success) return {reason: 'schema-rejection', tracked: false}
    return this.emit<SwarmQueryCompletedProps>(AnalyticsEventNames.SWARM_QUERY_COMPLETED, parsed.data)
  }

  private handleTrackStoreCompleted(data: SwarmTrackStoreCompletedRequest): SwarmTrackResponse {
    const parsed = SwarmStoreCompletedSchema.safeParse(data)
    if (!parsed.success) return {reason: 'schema-rejection', tracked: false}
    return this.emit<SwarmStoreCompletedProps>(AnalyticsEventNames.SWARM_STORE_COMPLETED, parsed.data)
  }
}
