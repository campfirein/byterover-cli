import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelSubscribeRequest,
  ChannelSubscribeRequestSchema,
  ChannelSubscribeResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:subscribe`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the subscribe behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelSubscribeHandler
  implements ITransportHandler<ChannelSubscribeRequest, ChannelSubscribeResponse>
{
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.SUBSCRIBE
    this.transportServer = transportServer
  }

  public async handle(request: ChannelSubscribeRequest): Promise<ChannelSubscribeResponse> {
    parseOrThrow(ChannelSubscribeRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelSubscribeRequest, ChannelSubscribeResponse>(
      this.event,
      (request) => this.handle(request),
    )
  }
}
