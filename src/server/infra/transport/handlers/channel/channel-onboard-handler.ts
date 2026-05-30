import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelOnboardRequest,
  ChannelOnboardRequestSchema,
  ChannelOnboardResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:onboard`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the onboard behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelOnboardHandler
  implements ITransportHandler<ChannelOnboardRequest, ChannelOnboardResponse>
{
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.ONBOARD
    this.transportServer = transportServer
  }

  public async handle(request: ChannelOnboardRequest): Promise<ChannelOnboardResponse> {
    parseOrThrow(ChannelOnboardRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelOnboardRequest, ChannelOnboardResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
