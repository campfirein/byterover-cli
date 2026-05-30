import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelShowRequest,
  ChannelShowRequestSchema,
  ChannelShowResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:show`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the show behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelShowHandler implements ITransportHandler<ChannelShowRequest, ChannelShowResponse> {
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.SHOW
    this.transportServer = transportServer
  }

  public async handle(request: ChannelShowRequest): Promise<ChannelShowResponse> {
    parseOrThrow(ChannelShowRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelShowRequest, ChannelShowResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
