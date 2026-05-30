import type {ITransportServer} from '../../../../core/interfaces/transport/index.js'
import type {ITransportHandler} from '../i-transport-handler.js'

import {
  ChannelEvents,
  ChannelListRequest,
  ChannelListRequestSchema,
  ChannelListResponse,
} from '../../../../../shared/transport/events/channel-events.js'
import {ChannelNotImplementedError} from '../../../../core/domain/channel/errors.js'
import {parseOrThrow} from './parse-or-throw.js'

/**
 * Handles `channel:list`. `handle` validates the payload, then throws
 * {@link ChannelNotImplementedError}; the list behavior lands in a later
 * milestone, written after the validation step in `handle`.
 */
export class ChannelListHandler implements ITransportHandler<ChannelListRequest, ChannelListResponse> {
  private readonly event: string
  private readonly transportServer: ITransportServer

  public constructor(transportServer: ITransportServer) {
    this.event = ChannelEvents.LIST
    this.transportServer = transportServer
  }

  public async handle(request: ChannelListRequest): Promise<ChannelListResponse> {
    parseOrThrow(ChannelListRequestSchema, request)
    throw new ChannelNotImplementedError(this.event)
  }

  public setup(): void {
    this.transportServer.onRequest<ChannelListRequest, ChannelListResponse>(this.event, (request) =>
      this.handle(request),
    )
  }
}
