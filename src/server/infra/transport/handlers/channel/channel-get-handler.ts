import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelGetRequest,
  ChannelGetRequestSchema,
  ChannelGetResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:get`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the get behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelGetHandler implements ITransportHandler<ChannelGetRequest, ChannelGetResponse> {
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.GET
    this.transportServer = transportServer
  }

  public async handle(request: ChannelGetRequest): Promise<ChannelGetResponse> {
    parseOrThrow(ChannelGetRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelGetRequest, ChannelGetResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
