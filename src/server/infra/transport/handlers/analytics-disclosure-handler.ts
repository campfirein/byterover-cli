import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  type AnalyticsDisclosureResponse,
  AnalyticsEvents,
} from '../../../../shared/transport/events/analytics-events.js'
import {loadAnalyticsDisclosureText} from '../../../../shared/utils/load-analytics-disclosure.js'

export interface AnalyticsDisclosureHandlerDeps {
  readonly loadDisclosure?: () => Promise<string>
  readonly transport: ITransportServer
}

/**
 * Serves `analytics:getDisclosure` so the local web UI can render the same
 * canonical disclosure markdown shown by the CLI consent prompt
 * (`brv settings set analytics.share true`). Single source of truth is
 * `src/shared/assets/analytics-disclosure.md`, read via
 * `loadAnalyticsDisclosureText()`.
 */
export class AnalyticsDisclosureHandler {
  private readonly loadDisclosure: () => Promise<string>
  private readonly transport: ITransportServer

  public constructor(deps: AnalyticsDisclosureHandlerDeps) {
    this.loadDisclosure = deps.loadDisclosure ?? loadAnalyticsDisclosureText
    this.transport = deps.transport
  }

  public setup(): void {
    this.transport.onRequest<void, AnalyticsDisclosureResponse>(AnalyticsEvents.GET_DISCLOSURE, async () => {
      const markdown = await this.loadDisclosure()
      if (!markdown) throw new Error('Analytics disclosure markdown is missing or empty.')
      return {markdown}
    })
  }
}
