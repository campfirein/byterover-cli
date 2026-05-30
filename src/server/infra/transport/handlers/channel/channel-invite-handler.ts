import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelInviteRequest,
  ChannelInviteRequestSchema,
  ChannelInviteResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:invite`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the invite behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelInviteHandler
  implements ITransportHandler<ChannelInviteRequest, ChannelInviteResponse>
{
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.INVITE
    this.transportServer = transportServer
  }

  public async handle(request: ChannelInviteRequest): Promise<ChannelInviteResponse> {
    parseOrThrow(ChannelInviteRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelInviteRequest, ChannelInviteResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
