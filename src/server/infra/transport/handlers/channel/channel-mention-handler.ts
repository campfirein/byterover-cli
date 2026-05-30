import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelMentionRequest,
  ChannelMentionRequestSchema,
  ChannelMentionResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:mention`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the mention behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelMentionHandler
  implements ITransportHandler<ChannelMentionRequest, ChannelMentionResponse>
{
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.MENTION
    this.transportServer = transportServer
  }

  public async handle(request: ChannelMentionRequest): Promise<ChannelMentionResponse> {
    parseOrThrow(ChannelMentionRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelMentionRequest, ChannelMentionResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
