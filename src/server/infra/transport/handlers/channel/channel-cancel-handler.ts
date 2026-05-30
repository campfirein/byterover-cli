import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelCancelRequest,
  ChannelCancelRequestSchema,
  ChannelCancelResponse,
  ChannelEvents,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:cancel`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the cancel behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelCancelHandler
  implements ITransportHandler<ChannelCancelRequest, ChannelCancelResponse>
{
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.CANCEL
    this.transportServer = transportServer
  }

  public async handle(request: ChannelCancelRequest): Promise<ChannelCancelResponse> {
    parseOrThrow(ChannelCancelRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelCancelRequest, ChannelCancelResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
