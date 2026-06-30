import type {IJsonlAnalyticsStore} from '../../../core/interfaces/analytics/i-jsonl-analytics-store.js'
import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {redactRecord} from '../../../../shared/analytics/forbidden-field-names.js'
import {
  AnalyticsEvents,
  type AnalyticsListRequest,
  AnalyticsListRequestSchema,
  type AnalyticsListResponse,
} from '../../../../shared/transport/events/analytics-events.js'

export interface AnalyticsListHandlerDeps {
  jsonlStore: IJsonlAnalyticsStore
  transport: ITransportServer
}

const EMPTY_RESPONSE: AnalyticsListResponse = {rows: [], total: 0}

/**
 * Daemon-side handler for `analytics:list` (M11.2). Validates the
 * inbound request against M11.1's Zod schema, delegates to
 * `JsonlAnalyticsStore.list`, applies defense-in-depth property
 * redaction (drops keys in `FORBIDDEN_FIELD_NAMES`), and returns
 * `{rows, total}`.
 *
 * Defensive failure mode mirrors the existing `AnalyticsHandler`:
 * malformed input or any throw from the store yields
 * `{rows: [], total: 0}`. Analytics queries MUST NEVER crash the
 * webui requester.
 *
 * Identity is intentionally NOT redacted — see `redactRecord` for the
 * rationale (the four identity fields are super-properties, not
 * event-specific content).
 */
export class AnalyticsListHandler {
  private readonly jsonlStore: IJsonlAnalyticsStore
  private readonly transport: ITransportServer

  public constructor(deps: AnalyticsListHandlerDeps) {
    this.jsonlStore = deps.jsonlStore
    this.transport = deps.transport
  }

  public setup(): void {
    this.transport.onRequest<AnalyticsListRequest, AnalyticsListResponse>(
      AnalyticsEvents.LIST,
      async (data: unknown): Promise<AnalyticsListResponse> => {
        const parsed = AnalyticsListRequestSchema.safeParse(data)
        if (!parsed.success) return EMPTY_RESPONSE

        try {
          const {rows, total} = await this.jsonlStore.list(parsed.data)
          return {rows: rows.map((r) => redactRecord(r)), total}
        } catch {
          return EMPTY_RESPONSE
        }
      },
    )
  }
}
