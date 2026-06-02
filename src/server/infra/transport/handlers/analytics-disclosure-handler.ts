import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  type AnalyticsDisclosureResponse,
  AnalyticsEvents,
} from '../../../../shared/transport/events/analytics-events.js'
import {loadAnalyticsDisclosureText} from '../../../../shared/utils/load-analytics-disclosure.js'
import {parseAnalyticsDisclosure} from '../../../../shared/utils/parse-analytics-disclosure.js'

export interface AnalyticsDisclosureHandlerDeps {
  readonly loadDisclosure?: () => Promise<string>
  readonly transport: ITransportServer
}

/**
 * Serves `analytics:getDisclosure` so the local web UI can render the
 * canonical disclosure in its icon-grid layout. The daemon parses
 * `src/shared/assets/analytics-disclosure.md` into one section per
 * `## H2` heading and ships the structured array. Single source of truth
 * stays the markdown file — PM/legal edits propagate without code changes.
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
      const sections = parseAnalyticsDisclosure(markdown)
      if (sections.length === 0) {
        throw new Error('Analytics disclosure is missing or contains no sections.')
      }

      return {sections}
    })
  }
}
