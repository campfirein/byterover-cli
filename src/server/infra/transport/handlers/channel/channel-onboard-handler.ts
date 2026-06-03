import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {IChannelOnboardService} from '../../../channel/onboard-service.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  type ChannelOnboardRequest,
  ChannelOnboardRequestSchema,
  type ChannelOnboardResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {parseOrThrow} from './parse-or-throw.js'

export type ChannelOnboardHandlerDeps = {
  readonly onboardService: IChannelOnboardService
  readonly transport: ITransportServer
}

/**
 * Handles `channel:onboard` by probing a candidate agent and persisting a
 * reusable profile. Project-independent — profiles are global.
 */
export class ChannelOnboardHandler implements ITransportHandler<ChannelOnboardRequest, ChannelOnboardResponse> {
  private readonly deps: ChannelOnboardHandlerDeps
  private readonly event = ChannelEvents.ONBOARD

  public constructor(deps: ChannelOnboardHandlerDeps) {
    this.deps = deps
  }

  public async handle(request: ChannelOnboardRequest): Promise<ChannelOnboardResponse> {
    const valid = parseOrThrow(ChannelOnboardRequestSchema, request)
    const {diagnostics, profile} = await this.deps.onboardService.onboard({
      displayName: valid.displayName,
      invocation: valid.invocation,
      profileName: valid.profileName,
    })
    return {diagnostics, profile}
  }

  public setup(): void {
    this.deps.transport.onRequest<ChannelOnboardRequest, ChannelOnboardResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
