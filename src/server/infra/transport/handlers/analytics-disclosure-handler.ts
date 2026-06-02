import type {ITransportServer} from '../../../core/interfaces/transport/i-transport-server.js'

import {
  type AnalyticsDisclosureResponse,
  type AnalyticsDisclosureSection,
  AnalyticsEvents,
} from '../../../../shared/transport/events/analytics-events.js'
import {loadAnalyticsDisclosureText} from '../../../../shared/utils/load-analytics-disclosure.js'
import {parseAnalyticsDisclosure} from '../../../../shared/utils/parse-analytics-disclosure.js'

export interface AnalyticsDisclosureHandlerDeps {
  readonly loadDisclosure?: () => Promise<string>
  readonly transport: ITransportServer
}

export class AnalyticsDisclosureHandler {
  private cachedSections: AnalyticsDisclosureSection[] | undefined
  private readonly loadDisclosure: () => Promise<string>
  private readonly transport: ITransportServer

  public constructor(deps: AnalyticsDisclosureHandlerDeps) {
    this.loadDisclosure = deps.loadDisclosure ?? loadAnalyticsDisclosureText
    this.transport = deps.transport
  }

  public setup(): void {
    this.transport.onRequest<void, AnalyticsDisclosureResponse>(AnalyticsEvents.GET_DISCLOSURE, async () => ({
      sections: await this.getSections(),
    }))
  }

  private async getSections(): Promise<AnalyticsDisclosureSection[]> {
    if (this.cachedSections) return this.cachedSections

    const markdown = await this.loadDisclosure()
    const sections = parseAnalyticsDisclosure(markdown)
    if (sections.length === 0) {
      throw new Error('Analytics disclosure is missing or contains no sections.')
    }

    this.cachedSections = sections
    return sections
  }
}
